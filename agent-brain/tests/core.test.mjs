// Core contract tests: gating, retention, tier migration, revival, affect bounds.
// Everything runs against a throwaway temp database and an explicit clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Brain } from '../src/brain.mjs'
import { DAY, gateImportance, retention, writeMemory } from '../src/memory.mjs'
import { DEFAULT_CONFIG } from '../src/config.mjs'

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0)
let seq = 0
const tmpFile = () => path.join(os.tmpdir(), `agent-brain-test-${process.pid}-${seq++}-${Date.now()}.sqlite`)
const open = (config = {}) => new Brain({ file: tmpFile(), config })

test('gate: directive statements are remembered, filler is not', () => {
  const strong = gateImportance({ text: '记住：我叫小林，在杭州做后端，猫叫年糕', novelty: 0.8, cfg: DEFAULT_CONFIG })
  const weak = gateImportance({ text: '嗯', novelty: 0.02, cfg: DEFAULT_CONFIG })
  assert.ok(strong.importance > 0.5, `expected strong > 0.5, got ${strong.importance}`)
  assert.ok(weak.importance < DEFAULT_CONFIG.gate.threshold, `expected weak below threshold, got ${weak.importance}`)
})

test('retention decays with time and rewards access', () => {
  const row = { last_accessed_at: T0, access_count: 1, importance: 0.6, tau_days: 3, pad_p: -0.4, pad_a: 0.2, pad_d: 0 }
  const fresh = retention(row, T0, DEFAULT_CONFIG)
  const aged = retention(row, T0 + 120 * DAY, DEFAULT_CONFIG)
  const touched = retention({ ...row, access_count: 5 }, T0 + 120 * DAY, DEFAULT_CONFIG)
  assert.ok(fresh > aged)
  assert.ok(touched > aged)
})

test('migration: warm → cold → forget_log, without deleting rows', () => {
  const brain = open()
  writeMemory(brain.db, {
    text: '用户说他养了只猫叫年糕，三岁，特别粘人',
    session: 'test', now: T0, cfg: brain.cfg, importance: 0.9, tauDays: 3,
  })
  assert.equal(brain.status().memories.warm, 1)

  const first = brain.tick(T0 + 200 * DAY)
  assert.ok(first.archived >= 1)
  assert.equal(brain.db.prepare("SELECT COUNT(*) n FROM memories WHERE layer = 'cold'").get().n, 1)
  assert.equal(brain.status().memories.forgotten, 0)

  const second = brain.tick(T0 + 900 * DAY)
  assert.ok(second.forgotten >= 1)
  const logged = brain.db.prepare('SELECT COUNT(*) n FROM forget_log').get().n
  assert.ok(logged >= 1, 'forgotten memory must leave an append-only log entry')
  brain.close()
})

test('a cold memory that gets mentioned is revived to warm', () => {
  const brain = open()
  const text = '我养了只猫叫年糕，三岁，特别粘人'
  writeMemory(brain.db, { text, session: 'test', now: T0, cfg: brain.cfg, importance: 0.9 })
  brain.tick(T0 + 200 * DAY)
  assert.equal(brain.db.prepare('SELECT layer FROM memories LIMIT 1').get().layer, 'cold')

  const now = T0 + 201 * DAY
  const r = brain.onUserMessage({ text: '年糕最近怎么样来着', session: 'test', now })
  assert.ok(r.hits.length > 0)
  assert.equal(brain.db.prepare('SELECT layer FROM memories LIMIT 1').get().layer, 'warm')
  brain.close()
})

test('affect is bounded: a burst of bad news cannot pin PAD to -1', () => {
  const brain = open()
  let now = T0
  const worst = []
  for (let i = 0; i < 8; i += 1) {
    now += 2 * 60_000
    const r = brain.onUserMessage({ text: '我今天特别难受，快撑不住了，感觉要垮掉', session: 'test', now })
    worst.push(r.pad.p)
  }
  for (const p of worst) assert.ok(p >= -1 && p <= 1)
  assert.ok(worst.at(-1) > -0.97, `expected damping near -1, got ${worst.at(-1)}`)
  assert.ok(worst.at(-1) < 0, 'negative news should still push mood down')
  brain.close()
})

test('prompt carries a usable memory line once something was remembered', () => {
  const brain = open()
  let now = T0
  for (const text of ['我叫小林，在杭州做后端', '我还养了只猫叫年糕']) {
    brain.onUserMessage({ text, session: 'test', now })
    brain.onAssistantReply({ text: '记住了', session: 'test', now })
    now += 3 * 60_000
  }
  const r = brain.onUserMessage({ text: '你还记得我叫什么吗', session: 'test', now })
  assert.match(r.prompt, /你记得/)
  assert.ok(r.prompt.length < 4000, 'prompt block should stay small')
  brain.close()
})
