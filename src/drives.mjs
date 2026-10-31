// 驱力（drives）：让她“有理由”主动做事。
// 每个 drive 是一个 0..1 的强度值：随时间上涨，被对应行为消耗。
// 与 PAD 耦合：愉悦度低 + 唤醒度高 → 更想找人说话；支配感高 → 更想表达。
import { clamp } from './text.mjs'
import { getState, setState } from './db.mjs'

export const DEFAULT_DRIVES = {
  social: { label: '想找人说话', ratePerHour: 0.06, initial: 0.15, satiate: 0.55, couple: { p: -0.35, a: 0.45, d: 0 } },
  curiosity: { label: '想知道点什么', ratePerHour: 0.09, initial: 0.25, satiate: 0.60, couple: { p: 0.1, a: 0.2, d: 0 } },
  expression: { label: '想写点什么', ratePerHour: 0.05, initial: 0.12, satiate: 0.70, couple: { p: -0.1, a: 0.1, d: 0.5 } },
}

export class Drives {
  constructor(db, cfg = {}, { log = () => {} } = {}) {
    this.db = db
    this.cfg = cfg
    this.log = log
    this.defs = { ...DEFAULT_DRIVES, ...(cfg.drives?.defs ?? {}) }
    const saved = getState(db, 'drives', null)
    this.values = {}
    for (const [id, def] of Object.entries(this.defs)) {
      this.values[id] = clamp(saved?.values?.[id] ?? def.initial, 0, 1)
    }
    this.lastTickAt = saved?.lastTickAt ?? null
  }

  /** 时间推进：按小时线性累积，并叠加当前情绪带来的“偏向” */
  advance(now = Date.now(), pad = { p: 0, a: 0, d: 0 }, { userSilentHours = 0 } = {}) {
    const hours = this.lastTickAt ? Math.max(0, (now - this.lastTickAt) / 3600000) : 0
    for (const [id, def] of Object.entries(this.defs)) {
      const c = def.couple ?? {}
      const bias = 1 + (c.p ?? 0) * pad.p + (c.a ?? 0) * pad.a + (c.d ?? 0) * pad.d
      // 越久没人说话，social 涨得越快（最多 1.6×）
      const silentBoost = id === 'social' ? 1 + Math.min(0.6, userSilentHours / 24) : 1
      const delta = def.ratePerHour * hours * Math.max(0.2, bias) * silentBoost
      this.values[id] = clamp(this.values[id] + delta, 0, 1)
    }
    this.lastTickAt = now
    this.persist()
    return this.snapshot()
  }

  bump(id, amount) {
    if (!(id in this.values)) return
    this.values[id] = clamp(this.values[id] + amount, 0, 1)
    this.persist()
  }

  satisfy(id, amount = null) {
    const def = this.defs[id]
    if (!def) return
    this.values[id] = clamp(this.values[id] - (amount ?? def.satiate), 0, 1)
    this.persist()
  }

  get(id) { return this.values[id] ?? 0 }

  level(id) {
    const v = this.get(id)
    return v >= 0.75 ? 'high' : v >= 0.45 ? 'mid' : 'low'
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.defs).map(([id, d]) => [id, {
      label: d.label, value: round3(this.values[id]), level: this.level(id),
    }]))
  }

  persist() {
    setState(this.db, 'drives', { values: this.values, lastTickAt: this.lastTickAt })
  }
}

function round3(x) { return Math.round(x * 1000) / 1000 }
