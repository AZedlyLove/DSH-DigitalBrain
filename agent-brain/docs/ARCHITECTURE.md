# Architecture

This document describes the state machine behind `agent-brain`: what is stored, when it changes,
and why each constant has the value it has.

## 1. Data model

One SQLite file (`node:sqlite`, WAL). Six tables; nothing is ever hard-deleted.

| table | purpose | notable columns |
| --- | --- | --- |
| `hot` | recent turns, verbatim (default 10) | `session, role, text, created_at` |
| `memories` | all long-term entries, both Warm and Cold | `layer, content, summary, importance, pad_p/a/d, created_at, last_accessed_at, access_count, memory_type, tau_days, derived_from, vec, meta` |
| `edges` | typed associations between memories | `from_id, to_id, type, weight` |
| `state` | key/value snapshots | `config, pad, drives, turnCount, lastReflectAt, patterns, pendingOutcome` |
| `turn_log` | per-turn audit | `session, user_text, reply_text, behavior, at` |
| `forget_log` | append-only tombstone | `memory_id, score, reason, at` |

`memories.layer ∈ {warm, cold, forgotten}`. A forgotten row keeps its content but stops being a
retrieval candidate; the tombstone records why.

`memory_type ∈ {episodic, semantic, procedural}`. Episodic entries are events, semantic ones are
reflections, procedural ones come from repeated behaviour patterns.

`edges.type ∈ {entity_cooccur, affect_align, causal_temporal}`, unique per `(from, to, type)`.

## 2. One turn

```text
onUserMessage(text, session, now)
  ├─ pad ← decayPad(pad, Δt)                     exponential toward baseline, τ_e = 45 min
  ├─ hot ← insert(text); prune to N turns
  ├─ vec ← embed(text); novelty ← 1 − max cosine(vec, warm[80])
  ├─ gate  ← 0.40·directive + 0.35·|affect| + 0.25·novelty
  │     └─ if ≥ 0.25 → writeMemory(episodic, tau_days = 3) + 2–4 edges
  ├─ hits ← retrieve(...)                       5-factor score, +1 hop, top k = 4
  ├─ pad ← applyMemoryAffect(pad, hits)          ΔPAD = affect·R·β, ≤ 3 memories, ≤ 0.35/turn
  ├─ settle previous outcome                     infer reaction from this message
  ├─ prompt ← buildPrompt(persona, tone, memories, rules)
  └─ maybeReflect(now)                           every 24 turns or across a day boundary

onAssistantReply(text, session, now)
  ├─ write behavior_outcome memory (β halved)
  ├─ bumpPattern(mood bucket × behaviour × reaction)
  └─ pendingOutcome ← current turn

tick(now)  (timer)
  ├─ migrateTiers: warm→cold→forget_log
  └─ revive cold hits lazily during retrieval instead of a sweep
```

## 3. Scoring

**Gate**

```text
importance = 0.40·directive + 0.35·|affect| + 0.25·novelty
directive  ∈ [0,1]  explicit instructions, commitments, self-statements
|affect|   ∈ [0,1]  magnitude of the PAD estimate for the message
novelty    ∈ [0,1]  1 − max cosine against the 80 newest warm memories
store iff importance ≥ 0.25
```

**Retention** (`R`, evaluated on every tick)

```text
R = exp(−Δt_days / S) · (1 + 0.45·Nr + 0.30·I + 0.25·F)
S = max(ln(1 + Nr), 0.35) · max(tau_days / 3, 0.1)
```

`Nr` = access count, `I` = importance, `F` = |PAD|. Cold entries multiply `tau_days` by 3 — being
archived should cool an entry down, not delete it the next day.

**Retrieval**

```text
score = 0.40·cos(query, vec)
      + 0.25·importance
      + 0.15·exp(−hours_since_access / 168)
      + 0.10·cos(pad, mem.pad)
      + 0.10·[reached via a 1-hop edge]
```

Candidates are capped (`candidateLimit = 200`), hits refresh `access_count` and
`last_accessed_at`, and at most one Cold revival is allowed per turn — otherwise a single vague
question would wake the entire archive.

**Tier policy**

| from | condition | to |
| --- | --- | --- |
| Warm | `R < 0.40` or ≥ 90 days untouched | Cold (summary + pointer, `meta.coldSince`) |
| Cold | `R < 0.10` and cold ≥ 30 days | `forget_log` (row kept, layer = `forgotten`) |
| Cold | retrieved | Warm (repetition counted) |

## 4. Affect

`PAD` lives in `[−1, 1]³` with a configurable baseline (default `0.15 / 0.05 / 0.10`).

- **Decay** between turns: `x ← x·exp(−Δt/τ_e) + baseline·(1 − exp(−Δt/τ_e))`, `τ_e = 45 min`.
- **Colour from recall**: up to 3 memories with the strongest affect affinity contribute
  `Δ = affect·R·β` (`β = 0.35`); same-affect edges amplify by `1 + 0.15k` (cap 1.5×).
- **Two guards** keep a single bad message from pinning the mood: a per-turn displacement cap
  (`0.35`), and a compression factor `(1 − |x|)` so movement slows near ±1.
- **Translation, not assertion**: `toneGuidance()` maps each axis into three bands, then emits
  style instructions ("short sentences, keep it light") — the model never sees "you are happy".

Semantic memories colour at half strength but decay more slowly. Behaviour outcomes apply at
`β × 0.5`, so mood drifts with how conversations actually went, not only with what was said.

## 5. Prompt assembly

```text
[persona]                       one paragraph, from cfg.prompt.persona
[语气与节奏]                     three bands + one behavioural tendency
[你记得…]                        ≤ 4 lines, 40–80 chars each, ≤ 1200 chars total
                               conflicting pairs are labelled
[行为约束]                       instincts + modulation ("one or two sentences")
[extra sections]                promptSection providers (drives, weather, calendar…)
```

Memory lines are prose, not records: `你记得：<content>（<how it was learned>·<tone>）`.

## 6. Autonomy

```text
drives.advance(now, pad, {silentHours})
  rate·Δt_hours·max(0.2, 1 + couple·pad)·silentBoost(social only, ≤ 1.6×)

for action in actions:
  if action.quietHours and inQuietHours(now): skip
  if used_today ≥ dailyCap: skip
  if now − lastAttempt < cooldown: skip        # attempts, not successes
  if action.drive and now − lastExternal < minGap: skip
  if action.can(ctx) !== true: skip
  priority = action.priority(ctx); keep if > 0

run the top `maxActionsPerTick` (default 1), log, satisfy its drive, journal the result
```

`quietHours` supports windows that cross midnight (`23:30 → 08:00`). Cooldowns are measured from
the last *attempt* so a failing channel cannot retry in a tight loop.

## 7. Extension points

```js
brain.ext.on(event, handler, { name })      // returns unsubscribe
brain.ext.register(kind, name, impl)        // providers: affect, embedder, promptSection, composer, action
```

Hooks receive plain objects and are isolated: a throwing hook is recorded in `ext.errors` and never
breaks a turn. `action` descriptors are merged into the autonomy loop, so new behaviours need no
core changes.

## 8. Testing

`tests/` uses `node:test` with an explicit clock and throwaway temp databases:

- gating (strong vs. filler), retention monotonicity;
- warm → cold → `forget_log`, revival on mention;
- PAD bound under a burst of negative messages;
- prompt contains memory lines and stays small;
- drives accumulate/satisfy, quiet-hours wrap, one action per tick, cooldown suppression.

Run with `npm test` (or `node --test tests`).

## 9. Trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| SQLite, WAL | zero ops, crash-safe, queryable | single writer; one file per agent |
| Hash n-gram embeddings | no model download, deterministic tests | no semantics; swap via `embedder` |
| Lexicon affect | instant, debuggable | misses sarcasm; swap via `affect` |
| Template reflection | no extra model call per day | flatter summaries; `synthesizer` hook |
| Rules for instincts | predictability beats cleverness | manual tuning per locale |
