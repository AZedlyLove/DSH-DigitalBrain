// Autonomy contract tests: drives, quiet hours, cooldowns, and one-action-per-tick.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Brain } from '../src/brain.mjs'
import { Autonomy, inQuietHours } from '../src/autonomy.mjs'
import { Drives } from '../src/drives.mjs'

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0) // 10:00 — safely outside quiet hours
let seq = 0
const tmpFile = () => path.join(os.tmpdir(), `agent-brain-auto-${process.pid}-${seq++}-${Date.now()}.sqlite`)

test('quiet hours wrap around midnight', () => {
  const quiet = { start: '23:30', end: '08:00' }
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0).getTime()
  assert.equal(inQuietHours(at(23, 45), quiet), true)
  assert.equal(inQuietHours(at(2, 0), quiet), true)
  assert.equal(inQuietHours(at(7, 59), quiet), true)
  assert.equal(inQuietHours(at(8, 0), quiet), false)
  assert.equal(inQuietHours(at(12, 0), quiet), false)
})

test('drives accumulate over time and drop when satisfied', () => {
  const brain = new Brain({ file: tmpFile() })
  const drives = new Drives(brain.db, brain.cfg)
  drives.advance(T0)                       // first call only arms the clock
  const before = drives.get('social')
  drives.advance(T0 + 10 * 3600_000)
  const after = drives.get('social')
  assert.ok(after > before)
  drives.satisfy('social')
  assert.ok(drives.get('social') < after)
  brain.close()
})

test('autonomy runs one action per tick, respects cooldown and quiet hours', async () => {
  const brain = new Brain({ file: tmpFile() })
  const sent = []
  const io = {
    async sendMessage(text) { sent.push(text); return true },
    async setSignature() { return true },
    async writeDiary() { return true },
    async browseSocial() { return { source: 'stub', items: [] } },
  }
  brain.ext.register('composer', 'stub', async () => '测试开场')
  const autonomy = new Autonomy({ brain, io })
  autonomy.drives.bump('social', 0.8)
  brain.lastTurnAt = T0 - 6 * 3600_000 // silent for a while → social is hot

  const first = await autonomy.tick(T0)
  assert.equal(first.length, 1, 'exactly one action per tick')
  assert.equal(first[0].id, 'proactive_chat')
  assert.equal(sent.length, 1)

  const second = await autonomy.tick(T0 + 60_000)
  assert.equal(second.length, 0, 'cooldown must swallow the next attempt')

  // 23:45 next day: within quiet hours, so no proactive message
  const quietTick = await autonomy.tick(new Date(2026, 0, 2, 23, 45, 0).getTime())
  assert.ok(quietTick.every((r) => r.id !== 'proactive_chat'))
  brain.close()
})
