# agent-brain

**A stateful memory · emotion · drives loop for LLM chat agents.**

A context window is not a memory. `agent-brain` runs *beside* your model and gives it the three
things a prompt alone can never provide: something it actually remembers, a mood that changes
how it speaks, and a reason to start a conversation on its own.

Zero dependencies. One SQLite file. Node ≥ 22.5 (`node:sqlite`).

```text
              user message
                   │
             ┌─────▼──────┐   gate (directive / affect / novelty)
             │  remember  │───────────────► Warm memory  ──┐
             └─────┬──────┘                                 │ decay
                   │  retrieve (5-factor score, 1-hop edges) │
             ┌─────▼──────┐                                 ▼
             │   recall   │◄──────────── Cold (summary + pointer)
             └─────┬──────┘
                   │  colour PAD by what came back
             ┌─────▼──────┐   persona / tone / memories / rules
             │   prompt   │───────────────► your LLM
             └────────────┘
                   │  reply → outcome memory → patterns → reflection
             ┌────────────┐        ┌──────────────┐
             │  drives    │───────►│ autonomous   │ chat · signature · diary · browse
             │ 0…1, rising│        │   actions    │
             └────────────┘        └──────────────┘
```

## Why

Most "agent memory" is a vector store glued to the prompt: everything is remembered equally,
nothing is ever forgotten, and the agent has no inner state between turns. `agent-brain` is a
small explicit state machine instead:

- **Three tiers, with migration.** Hot (last 10 turns verbatim) → Warm (searchable, scored) → Cold
  (compressed, woken on hit) → `forget_log` (append-only; rows are never deleted).
- **Importance is computed, not declared.** A message is only stored if a three-axis gate
  (explicit instruction / emotional intensity / novelty) scores high enough.
- **Mood is a vector, not an adjective.** PAD `(pleasure, arousal, dominance)` decays toward a
  baseline, is coloured by recalled memories, and is translated into *style instructions* — never
  into "you are happy".
- **Instincts survive emotion.** "Must reply" is a rule; mood may change *how* it replies, never
  *whether* it does.
- **Autonomy comes from drives, not dice.** Social / curiosity / expression rise with time and
  fall when satisfied; quiet hours, cooldowns and daily caps keep it from becoming a spam bot.

## Quickstart

```bash
git clone https://github.com/AZedlyLove/agent-brain.git
cd agent-brain
node examples/quickstart.mjs   # 30-second tour: gating, recall, affect, prompt
npm test                       # node --test, no dependencies
```

```js
import { Brain } from 'agent-brain'

const brain = new Brain({ file: 'state/brain.sqlite' })

// 1) before calling your model
const { prompt } = brain.onUserMessage({ text: '我叫小林，最近天天加班', session: 'u1' })

// 2) after the reply was delivered
brain.onAssistantReply({ text: '加班到几点？', session: 'u1' })

// 3) on a timer: decay, tier migration, reflection
setInterval(() => brain.tick(), 5 * 60 * 1000)
```

`prompt` is a four-part block: persona · tone guidance · `你记得…` memory lines · behaviour rules.
Feed it as a leading system message; send the user's own text unchanged.

## What it does

| Stage | Mechanism |
| --- | --- |
| Gate | `importance = 0.40·directive + 0.35·|affect| + 0.25·novelty`, threshold `0.25` |
| Keep | `R = exp(−Δt/S)·(1 + 0.45·Nr + 0.30·I + 0.25·F)`, `S = ln(1+Nr)` |
| Migrate | Warm `R<0.40` or 90 days idle → Cold; Cold `R<0.10` after ≥30 days → `forget_log` |
| Revive | a Cold hit returns to Warm (at most 1 per turn), and counts as a repetition |
| Link | 2–4 typed edges per write (`entity_cooccur` / `affect_align` / `causal_temporal`) |
| Recall | `0.40·rel + 0.25·I + 0.15·recency + 0.10·mood + 0.10·assoc`, top 4, +1 hop |
| Mood | `ΔPAD = affect·R·β`, same-affect hits amplified `1+γk` (≤1.5×), decay `τ_e=45min` |
| Reflect | every 24 turns or daily: cluster recent episodic → one semantic memory (`derived_from`) |
| Act | drives → candidate actions → quiet hours / cooldown / daily cap / `can()` → priority → 1 |

Everything above is one object in [`src/config.mjs`](src/config.mjs); nothing is hardcoded.

## Autonomy

Drives are scalars in `0…1` that rise hourly and drop when satisfied:

| Drive | Initial | /hour | Satiated by |
| --- | --- | --- | --- |
| `social` — wants to talk | 0.15 | +0.06 | proactive chat, sharing something, your message |
| `curiosity` — wants to know | 0.25 | +0.09 | browsing a feed and reading comments |
| `expression` — wants to write | 0.12 | +0.05 | signature, diary |

Mood couples into the rates; long silence accelerates `social` (up to 1.6×). Five built-in actions
ship in [`src/actions.mjs`](src/actions.mjs): `proactive_chat`, `post_signature`, `write_diary`,
`browse_social`, `quiet_reflect`. Wiring is five `io` methods — see
[`examples/integration.mjs`](examples/integration.mjs).

## Extension points

Two layers, both runtime:

**Hooks** — `turn:before`, `turn:after`, `memory:written`, `retrieve:done`, `outcome`, `reflect`,
`tick`, `action:run`.

**Providers** — `affect` (emotion detection), `embedder` (vectors), `promptSection` (inject a
section), `composer` (write proactive text), `action` (new autonomous behaviour).

```js
brain.ext.on('memory:written', ({ memory }) => console.log('new memory', memory.content))
brain.ext.register('embedder', 'bge', async (text) => myModel.embed(text))
brain.ext.register('action', 'like_post', { id: 'like_post', drive: 'expression', /* … */ })
```

## CLI

```bash
node src/cli.mjs status            # tier counts, PAD, drives, last reflection
node src/cli.mjs tick              # run decay + migration once
node src/cli.mjs reflect           # force a reflection pass
node src/cli.mjs recall 我那只猫叫什么   # full retrieval, prints the injected prompt
```

## Design notes & limits

- Chinese-first text heuristics (`Intl.Segmenter` for words/entities). Prompts are authored in
  Chinese; swap `prompt.mjs` / `text.mjs` for other languages.
- The default embedder is a character n-gram hash (256-d). It is cheap and deterministic, not
  semantic — register an `embedder` provider for real embeddings.
- Affect detection is lexicon + punctuation; register an `affect` provider to use a model.
- Reflection composes template sentences; `cfg.reflection.synthesizer` can delegate to an LLM.
- Single-writer SQLite. Fine for one agent process; use one file per agent.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full data model, lifecycle and formulas.

## License

MIT. Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

[中文说明](README.zh-CN.md)
