// 自主循环：驱动 → 候选行为 → 限流与静默 → 执行 → 记账 → 消耗驱力。
// 它是“她自己的时间”，不依赖用户消息；桥接里用 setInterval/tick 定期调用即可。
import { Drives } from './drives.mjs'
import { builtinActions, startOfDay } from './actions.mjs'
import { actionsSince, appendJournal, lastActionAt, lastAttemptAt, logAction, listJournal } from './db.mjs'

export class Autonomy {
  constructor({ brain, io = {}, actions = null, log = () => {} }) {
    this.brain = brain
    this.cfg = brain.cfg
    this.io = io
    this.log = log
    this.db = brain.db
    this.drives = new Drives(this.db, this.cfg, { log })
    this.actions = actions ?? builtinActions()
    for (const extra of brain.ext?.all('action') ?? []) this.actions.push(extra)
  }

  /** 推进时间并尝试执行一个动作；返回执行记录（没做事就是空数组） */
  async tick(now = Date.now()) {
    const cfg = this.cfg
    const silentHours = this.brain.lastTurnAt ? (now - this.brain.lastTurnAt) / 3600000 : 999
    this.drives.advance(now, this.brain.pad, { userSilentHours: silentHours })

    const ctx = { now, brain: this.brain, db: this.db, cfg, pad: this.brain.pad, drives: this.drives, io: this.io, silentHours }
    const quiet = inQuietHours(now, cfg.autonomy.quietHours)
    const dayStart = startOfDay(now)

    const candidates = []
    for (const action of this.actions) {
      if (action.quietHours && quiet) continue
      const cap = action.dailyCap ?? Infinity
      if (actionsSince(this.db, action.id, dayStart) >= cap) continue
      // 冷却按“任何一次尝试”算，失败也不允许立刻重试
      const lastAt = lastAttemptAt(this.db, action.id)
      if (lastAt && now - lastAt < (action.cooldownMin ?? 0) * 60000) continue
      // 对外动作之间留最小间隔，免得一口气刷屏
      if (action.drive && cfg.autonomy.minGapMinutes > 0) {
        const lastExternal = this.lastExternalAt()
        if (lastExternal && now - lastExternal < cfg.autonomy.minGapMinutes * 60000) continue
      }
      let verdict
      try { verdict = action.can(ctx) } catch (error) { verdict = `can() 抛错：${error?.message ?? error}` }
      if (verdict !== true) continue
      let priority = 0
      try { priority = action.priority(ctx) ?? 0 } catch { priority = 0 }
      if (priority <= 0) continue
      candidates.push({ action, priority })
    }

    candidates.sort((a, b) => b.priority - a.priority)
    const chosen = candidates.slice(0, Math.max(0, cfg.autonomy.maxActionsPerTick ?? 1))
    const ran = []
    for (const { action, priority } of chosen) {
      let result
      try {
        result = await action.run(ctx)
      } catch (error) {
        result = { ok: false, detail: { error: String(error?.message ?? error) } }
      }
      const ok = result?.ok !== false
      logAction(this.db, { at: now, action: action.id, drive: action.drive, ok, detail: result?.detail ?? null })
      if (ok) {
        if (action.drive) this.drives.satisfy(action.drive)
        if (result?.journal?.content) appendJournal(this.db, { at: now, kind: result.journal.kind, content: result.journal.content, meta: { action: action.id } })
      }
      this.brain.ext?.emit('action:run', { action: action.id, ok, priority, result, at: now })
      ran.push({ id: action.id, label: action.label, ok, priority, text: result?.text ?? null })
      this.log(`action ${action.id} ${ok ? 'ok' : 'fail'} (p=${priority.toFixed(2)})`)
    }
    return ran
  }

  lastExternalAt() {
    const row = this.db.prepare("SELECT at FROM actions_log WHERE ok = 1 AND detail IS NOT NULL AND action IN ('proactive_chat','post_signature','browse_social') ORDER BY id DESC LIMIT 1").get()
    return row?.at ?? null
  }

  /** 现在“想不想说话/想不想写”——给 prompt 或调试用 */
  moodNudge() {
    const snap = this.drives.snapshot()
    const top = Object.entries(snap).sort((a, b) => b[1].value - a[1].value)[0]
    if (!top) return null
    const [id, d] = top
    if (d.level !== 'high') return null
    return { id, label: d.label, value: d.value }
  }

  status() {
    const dayStart = startOfDay(Date.now())
    return {
      drives: this.drives.snapshot(),
      quietHours: this.cfg.autonomy.quietHours,
      candidatesToday: this.actions.map((a) => ({
        id: a.id, used: actionsSince(this.db, a.id, dayStart), cap: a.dailyCap ?? null,
        lastAt: lastActionAt(this.db, a.id),
      })),
      recentJournal: listJournal(this.db, { limit: 5 }),
    }
  }
}

/** "23:30" ~ "08:00" 这种跨零点区间 */
export function inQuietHours(now, { start, end } = {}) {
  if (!start || !end) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = String(start).split(':').map(Number)
  const [eh, em] = String(end).split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}
