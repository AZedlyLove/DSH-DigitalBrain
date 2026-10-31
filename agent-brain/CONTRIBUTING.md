# Contributing

Thanks for taking a look. This project is small on purpose — one SQLite file, no runtime
dependencies, every constant in one config object. Please keep it that way.

## Setup

```bash
node --version    # ≥ 22.5, for node:sqlite
npm test          # no install step needed
node src/demo.mjs
node src/demo-autonomy.mjs
```

## Ground rules

- **No runtime dependencies.** If something can be done with the standard library, do that. New
  capabilities belong behind a provider (`embedder`, `affect`, `composer`, …), not in `package.json`.
- **No hardcoded thresholds.** Add a key to `src/config.mjs` and read it from there.
- **No hidden global state.** Persist through `db.mjs` helpers so `status()` stays honest.
- **Prompts stay small.** The memory block has a character budget (`cfg.prompt.maxMemoryChars`);
  don't blow it up.
- **Tests use an explicit clock.** Never let a test depend on `Date.now()` moving.

## Good first issues

- A real embedding provider (bge / text-embedding-3-small) behind `embedder`.
- An `affect` provider backed by a small local model.
- Extra locales for `text.mjs` / `prompt.mjs` (English, Japanese).
- More action examples: calendar nudge, status rotation, journal-to-blog sync.
- An adapter package for a specific transport (Discord / Telegram / Matrix).

## Pull requests

1. One topic per PR; include the "why" in the description.
2. Add or update tests when behaviour changes (`npm test` must pass).
3. Update `docs/ARCHITECTURE.md` if you touch scoring, tiers, or the autonomy loop.
4. Keep commit messages conventional-ish: `feat: cold revival budget`, `fix: clamp pad`.

## Code style

- ESM, no transpiler, 2-space indent, single quotes, no semicolons.
- Comments explain *why*; the *what* should be obvious from names.
- Chinese comments are fine in text/heuristics modules; keep public APIs documented in English.

## Reporting bugs

Include: Node version, OS, the smallest script that reproduces, and the output of
`node src/cli.mjs status` (memory counts, PAD, drives) if the state matters.

## License

By contributing you agree your changes are released under the MIT license.
