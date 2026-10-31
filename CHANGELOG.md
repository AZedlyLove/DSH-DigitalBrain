# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2025-10-31

First public release.

### Added

- Three-tier memory (`hot` / `warm` / `cold`) with append-only `forget_log` and lazy revival.
- Three-axis write gate (directive / affect / novelty) with a configurable threshold.
- Retention scoring with access, importance and affect boosts; timed tier migration.
- Typed association edges (`entity_cooccur`, `affect_align`, `causal_temporal`) with 1-hop expansion.
- Five-factor retrieval, per-turn revival budget, conflict labelling for contradictory memories.
- PAD affect model: decay toward baseline, memory colouring, saturation guards, style-only tone guidance.
- Instinct rules (must reply, comfort first, direct answer) that emotion may shape but not cancel.
- Behaviour-outcome memories and pattern mining into procedural memories.
- Reflection pass that clusters episodic memories into semantic ones.
- Four-section prompt assembly with per-memory and total character budgets.
- Drives (`social`, `curiosity`, `expression`) and an autonomy loop with quiet hours, cooldowns,
  daily caps, priority ordering and journal/action logs.
- Five built-in autonomous actions: proactive chat, signature, diary, social browsing, quiet reflection.
- Extension layer: 8 event hooks and 5 provider kinds (`affect`, `embedder`, `promptSection`,
  `composer`, `action`).
- CLI (`status`, `tick`, `reflect`, `recall`), two demos, integration template, test suite.
