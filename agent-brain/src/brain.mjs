// 数字大脑：把记忆、情绪、行为串成一个有状态的循环。
// 外部只有三个入口：onUserMessage / onAssistantReply / recordOutcome；其余都是内部状态。
import fs from 'node:fs'
import { openDb, getState, setState } from './db.mjs'
import { DEFAULT_CONFIG, mergeConfig } from './config.mjs'
import { embed, fromBlob } from './embed.mjs'
import * as M from './memory.mjs'
import { applyMemoryAffect, applyOutcomeAffect, decayPad, defaultPad, emotionSnapshot, toneGuidance } from './emotion.mjs'
import { classifyReaction, instincts, modulation, bumpPattern, proceduralCandidates } from './behavior.mjs'
import { buildPrompt } from './prompt.mjs'
import { Extensions } from './hooks.mjs'
import { estimateAffect, frequentWords, padMagnitude, truncate } from './text.mjs'

export class Brain {
  constructor({ file = 'brain.sqlite', config = {}, log = () => {}, extensions = null } = {}) {
    this.db = openDb(file)
    this.file = file
    this.log = log
    // 扩展点：hooks + providers。任何时刻都可以 brain.ext.on/register 追加能力
    this.ext = extensions ?? new Extensions({ log })
    const saved = getState(this.db, 'config', {})
    this.cfg = mergeConfig(DEFAULT_CONFIG, saved)
    this.cfg = mergeConfig(this.cfg, config)
    this.pad = getState(this.db, 'pad', defaultPad(this.cfg)) ?? defaultPad(this.cfg)
    this.lastTurnAt = getState(this.db, 'lastTurnAt', null)
    this.turnCount = getState(this.db, 'turnCount', 0)
    this.lastReflectAt = getState(this.db, 'lastReflectAt', 0)
    this.patterns = getState(this.db, 'patterns', {})
    this.pending = getState(this.db, 'pendingOutcome', null)
  }

  setConfig(patch) {
    this.cfg = mergeConfig(this.cfg, patch)
    setState(this.db, 'config', this.cfg)
    return this.cfg
  }

  /** 用户消息到达：衰减情绪 → 门控写记忆 → 检索 → 情绪染色 → 组 prompt */
  onUserMessage({ text, session = 'default', atMention = false, now = Date.now() }) {
    const cfg = this.cfg
    const gapMin = this.lastTurnAt ? (now - this.lastTurnAt) / 60000 : 0
    this.pad = decayPad(this.pad, cfg, gapMin)

    // Hot：原文进环形缓冲（只保留最近 N 轮）
    this.db.prepare('INSERT INTO hot(session, role, text, created_at) VALUES (?,?,?,?)').run(session, 'user', text, now)
    this.pruneHot(session)
    this.ext.emit('turn:before', { text, session, atMention, now, pad: { ...this.pad } })

    // 三轴门控
    const vec = embed(text, cfg.embed)
    const existing = this.db.prepare("SELECT vec FROM memories WHERE layer = 'warm' ORDER BY created_at DESC LIMIT 80").all()
    const novelty = M.noveltyAgainst(vec, existing)
    const gate = M.gateImportance({ text, novelty, cfg })
    const userAffect = this.affect(text)
    let written = null
    if (gate.importance >= cfg.gate.threshold) {
      written = M.writeMemory(this.db, {
        text, session, type: 'episodic', now, cfg,
        affect: userAffect, importance: gate.importance,
        tauDays: 3, meta: { gate: gate.parts },
      })
      this.ext.emit('memory:written', { memory: written, kind: 'user_message', now })
    }

    // 检索（用“当前”情绪），再按命中记忆染色
    const hits = M.retrieve(this.db, { query: text, pad: this.pad, cfg, now })
    this.pad = applyMemoryAffect(this.pad, hits, cfg)
    this.ext.emit('retrieve:done', { hits, pad: { ...this.pad }, now })

    // 上一轮行为的用户反应：用本轮消息补齐
    if (this.pending) {
      const reaction = classifyReaction(text)
      this.applyOutcome({ reaction, now, silent: true })
    }

    const inst = instincts({ text, atMention, hits, pad: { ...this.pad }, userAffect }, cfg)
    const mod = modulation({ pad: this.pad, instincts: inst }, cfg)
    const toneText = toneGuidance(this.pad, cfg)
    // 扩展段落：交给第三方往 prompt 里补「当前状态/待办/她自己的心情」之类
    const extraSections = this.ext.collect('promptSection', {
      brain: this, pad: { ...this.pad }, hits, text, instincts: inst,
    }).map((x) => x.value)
    const prompt = buildPrompt({ cfg, pad: this.pad, toneText, hits, instinct: inst, modulation: mod, extraSections })

    this.lastTurnAt = now
    this.turnCount += 1
    this.persist()

    // 反思：每 N 轮或跨天
    this.maybeReflect(now)

    this.ext.emit('turn:after', {
      text, session, hits, pad: { ...this.pad }, prompt, instincts: inst, gate, now,
    })

    return {
      prompt, hits, toneText, pad: { ...this.pad },
      instincts: inst, modulation: mod, gate: { ...gate, written: written?.id ?? null },
      snapshot: emotionSnapshot(this.pad, cfg),
    }
  }

  /** 情绪估计走 provider，未注册时用内置启发式 */
  affect(text) {
    const provider = this.ext.provider('affect')
    if (!provider) return estimateAffect(text)
    try {
      return provider(text) ?? estimateAffect(text)
    } catch (error) {
      this.log(`affect provider 出错，退回启发式：${error?.message ?? error}`)
      return estimateAffect(text)
    }
  }

  onAssistantReply({ text, session = 'default', behavior = 'reply', now = Date.now() }) {
    this.db.prepare('INSERT INTO hot(session, role, text, created_at) VALUES (?,?,?,?)').run(session, 'assistant', text, now)
    this.pruneHot(session)
    this.db.prepare('INSERT INTO turn_log(session, user_text, reply_text, behavior, at) VALUES (?,?,?,?,?)')
      .run(session, null, text, behavior, now)
    this.pending = { behavior, at: now, padP: this.pad.p }
    setState(this.db, 'pendingOutcome', this.pending)
    return this.pending
  }

  applyOutcome({ reaction, now = Date.now(), silent = false }) {
    const p = this.pending
    if (!p) return null
    this.pad = applyOutcomeAffect(this.pad, reaction, this.cfg)
    // behavior_outcome 记忆：importance 中等，情绪 = 行为后的状态
    const text = `我在${padWord(p.padP)}的时候${behaviorWord(p.behavior)}，对方反应${reactionWord(reaction)}。`
    M.writeMemory(this.db, {
      text, session: 'outcome', type: 'episodic', now, cfg: this.cfg,
      affect: { p: reaction === 'positive' ? 0.25 : reaction === 'negative' ? -0.3 : 0, a: 0.1, d: 0 },
      importance: 0.35, tauDays: 2, meta: { behavior: p.behavior, reaction, outcome: true },
    })
    this.patterns = bumpPattern(this.patterns, { behavior: p.behavior, pad: { p: p.padP, a: 0.2, d: 0 }, reaction }, this.cfg)
    this.pending = null
    setState(this.db, 'pendingOutcome', null)
    setState(this.db, 'patterns', this.patterns)
    this.ext.emit('outcome', { reaction, behavior: p.behavior, pad: { ...this.pad }, now })
    this.persist()
    if (!silent) this.log(`outcome: ${p.behavior} → ${reaction}`)
    return reaction
  }

  maybeReflect(now = Date.now()) {
    const cfg = this.cfg
    const dueTurns = this.turnCount % cfg.reflection.everyTurns === 0
    const dueDaily = cfg.reflection.daily && now - this.lastReflectAt > 86400000
    if (!dueTurns && !dueDaily) return null
    return this.reflect({ now })
  }

  /** 反思：episodic 聚类 → semantic；patterns → procedural */
  reflect({ now = Date.now() } = {}) {
    const cfg = this.cfg
    const rows = this.db.prepare(`SELECT * FROM memories WHERE layer IN ('warm','cold') AND memory_type = 'episodic'
      AND created_at >= ? ORDER BY created_at ASC LIMIT 200`).all(this.lastReflectAt || 0)
      .filter((r) => !isOutcome(r)) // 行为结果单独走 patterns → procedural，不混进事件聚类
    const created = []
    let clusters = M.clusterEpisodic(rows, cfg)
    // 没形成任何簇但有足够 episodic：退回“整段作为一个簇”，保证反思不会永远空转
    if (!clusters.length && rows.length >= cfg.reflection.minCluster) clusters = [{ items: rows }]
    for (const cluster of clusters) {
      const text = this.synthesize(cluster.items)
      if (!text) continue
      const avgP = avg(cluster.items.map((r) => r.pad_p)) * cfg.emotion.semanticAffectFactor
      const mem = M.writeMemory(this.db, {
        text, session: 'reflection', type: 'semantic', now, cfg,
        affect: { p: avgP, a: avg(cluster.items.map((r) => r.pad_a)) * 0.5, d: 0 },
        importance: Math.max(cfg.reflection.semanticImportanceFloor, avg(cluster.items.map((r) => r.importance)) + 0.1),
        tauDays: 3 * cfg.reflection.tauMultiplier,
        meta: { derivedFrom: cluster.items.map((r) => r.id), clusterSize: cluster.items.length },
      })
      for (const r of cluster.items) {
        this.db.prepare('INSERT OR IGNORE INTO edges(from_id, to_id, type, weight, created_at) VALUES (?,?,?,?,?)')
          .run(mem.id, r.id, 'derived_from', 0.7, now)
      }
      created.push({ id: mem.id, text, from: cluster.items.length })
    }

    // 行为经验 → procedural
    for (const cand of proceduralCandidates(this.patterns)) {
      const mem = M.writeMemory(this.db, {
        text: cand.text, session: 'reflection', type: 'procedural', now, cfg,
        affect: { p: 0, a: 0, d: 0.1 }, importance: 0.55, tauDays: 3 * cfg.reflection.tauMultiplier,
        meta: { pattern: true, n: cand.n },
      })
      created.push({ id: mem.id, text: cand.text, from: 1 })
    }

    this.lastReflectAt = now
    this.persist()
    this.ext.emit('reflect', { created, now })
    this.log(`reflect: +${created.length} 条（semantic/procedural）`)
    return created
  }

  synthesize(items) {
    if (typeof this.cfg.reflection.synthesizer === 'function') return this.cfg.reflection.synthesizer(items)
    const texts = items.map((r) => r.content)
    const topics = frequentWords(texts, 3)
    if (!topics.length) return null
    const avgP = avg(items.map((r) => r.pad_p))
    const moodWord = avgP >= 0.2 ? '偏积极' : avgP <= -0.2 ? '偏低落/有压力' : '比较平静'
    return `用户近期反复提到${topics.join('、')}（${items.length} 条相关记忆），整体情绪${moodWord}。`
  }

  pruneHot(session) {
    const keep = Math.max(2, this.cfg.hot.turns * 2)
    this.db.prepare(`DELETE FROM hot WHERE session = ? AND id NOT IN (
      SELECT id FROM hot WHERE session = ? ORDER BY id DESC LIMIT ?)`).run(session, session, keep)
  }

  tick(now = Date.now()) {
    const r = M.migrateTiers(this.db, this.cfg, now)
    this.persist()
    this.ext.emit('tick', { ...r, now })
    return r
  }

  persist() {
    setState(this.db, 'pad', this.pad)
    setState(this.db, 'lastTurnAt', this.lastTurnAt)
    setState(this.db, 'turnCount', this.turnCount)
    setState(this.db, 'lastReflectAt', this.lastReflectAt)
  }

  status() {
    const count = (sql, ...args) => this.db.prepare(sql).get(...args).c
    return {
      file: this.file,
      memories: {
        hot: count('SELECT COUNT(*) c FROM hot'),
        warm: count("SELECT COUNT(*) c FROM memories WHERE layer = 'warm'"),
        cold: count("SELECT COUNT(*) c FROM memories WHERE layer = 'cold'"),
        forgotten: count("SELECT COUNT(*) c FROM memories WHERE layer = 'forgotten'"),
        edges: count('SELECT COUNT(*) c FROM edges'),
        byType: this.db.prepare('SELECT memory_type t, COUNT(*) c FROM memories GROUP BY memory_type').all(),
      },
      emotion: emotionSnapshot(this.pad, this.cfg),
      turns: this.turnCount,
      lastReflectAt: this.lastReflectAt ? new Date(this.lastReflectAt).toISOString() : null,
      thresholds: {
        importance: this.cfg.gate.threshold,
        archiveBelow: this.cfg.retention.archiveBelow,
        forgetBelow: this.cfg.retention.forgetBelow,
      },
      forgetLog: count('SELECT COUNT(*) c FROM forget_log'),
      journal: count('SELECT COUNT(*) c FROM journal'),
      extensions: this.ext.list(),
    }
  }

  recentHot(session = 'default', limit = 10) {
    return this.db.prepare('SELECT role, text, created_at FROM hot WHERE session = ? ORDER BY id DESC LIMIT ?').all(session, limit).reverse()
  }

  close() { try { this.db.close() } catch {} }
}

function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
function isOutcome(row) {
  try { return Boolean(JSON.parse(row.meta ?? '{}').outcome) } catch { return false }
}
function padWord(p) { return p >= 0.2 ? '心情不错' : p <= -0.2 ? '情绪低落' : '情绪平常' }
function behaviorWord(b) { return b === 'comfort' ? '先安抚对方' : b === 'direct_answer' ? '直接回答' : b === 'silent' ? '没接话' : '正常接话' }
function reactionWord(r) { return r === 'positive' ? '积极' : r === 'negative' ? '负面' : r === 'none' ? '没有回应' : '中性' }
