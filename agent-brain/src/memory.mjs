// 记忆层：重要性门控 → 写入 Warm（带联想边）→ 保留分数 → 分层迁移（Cold / forget_log）→ 检索
import crypto from 'node:crypto'
import { embed, cosine, toBlob, fromBlob } from './embed.mjs'
import { tx } from './db.mjs'
import { clamp, directiveScore, entities, estimateAffect, jaccard, padMagnitude, truncate } from './text.mjs'

export const DAY = 86400000

export function newId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
}

/** 三轴门控：指令性 / 情感强度 / 新颖度 → importance */
export function gateImportance({ text, novelty, cfg }) {
  const direct = directiveScore(text)
  const affect = padMagnitude(estimateAffect(text))
  const w = cfg.gate.weights
  const importance = clamp(w.directive * direct + w.affect * affect + w.novelty * novelty, 0, 1)
  return { importance, parts: { directive: direct, affect, novelty } }
}

/** 新颖度 = 1 - 与现有 Warm 的最大余弦相似度 */
export function noveltyAgainst(vec, existing) {
  let best = 0
  for (const m of existing) {
    const mv = fromBlob(m.vec)
    if (!mv) continue
    const c = cosine(vec, mv)
    if (c > best) best = c
  }
  return clamp(1 - best, 0, 1)
}

export function retention(mem, now, cfg) {
  const dtDays = Math.max(0, now - mem.last_accessed_at) / DAY
  const nr = Math.max(0, mem.access_count)
  const baseS = Math.max(Math.log(1 + nr), cfg.retention.floorS)
  const tauFactor = Math.max(0.1, (mem.tau_days ?? 3) / 3)
  const S = baseS * tauFactor
  const F = padMagnitude({ p: mem.pad_p, a: mem.pad_a, d: mem.pad_d })
  const boost = 1 + cfg.retention.halfLifeBoost.access * nr
    + cfg.retention.halfLifeBoost.importance * mem.importance
    + cfg.retention.halfLifeBoost.affect * F
  return Math.exp(-dtDays / S) * boost
}

export function toneOf(mem) {
  const p = mem.pad_p; const a = mem.pad_a
  if (p >= 0.25 && a >= 0.3) return '愉快且上头'
  if (p >= 0.25) return '愉快'
  if (p <= -0.25 && a >= 0.3) return '激动地不满'
  if (p <= -0.25) return '低落'
  if (a >= 0.45) return '情绪浓度高'
  return '平静'
}

/** 写入一条 Warm 记忆，并生成 2~4 条联想边。 */
export function writeMemory(db, { text, session = 'default', type = 'episodic', now = Date.now(), cfg, affect, importance, meta = {}, tauDays = 3 }) {
  const vec = embed(text, cfg.embed)
  const pad = affect ?? estimateAffect(text)
  const id = newId(type === 'semantic' ? 's' : type === 'procedural' ? 'p' : 'm')
  const row = {
    id, layer: 'warm', content: text, summary: null,
    importance: clamp(importance, 0, 1),
    pad_p: pad.p ?? 0, pad_a: pad.a ?? 0, pad_d: pad.d ?? 0,
    created_at: now, last_accessed_at: now, access_count: 1,
    memory_type: type, tau_days: tauDays,
    derived_from: meta.derivedFrom ? JSON.stringify(meta.derivedFrom) : null,
    vec: toBlob(vec),
    meta: JSON.stringify({ session, ...meta }),
  }
  tx(db, () => {
    db.prepare(`INSERT INTO memories
      (id, layer, content, summary, importance, pad_p, pad_a, pad_d, created_at, last_accessed_at,
       access_count, memory_type, tau_days, derived_from, vec, meta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.layer, row.content, row.summary, row.importance, row.pad_p, row.pad_a, row.pad_d,
      row.created_at, row.last_accessed_at, row.access_count, row.memory_type, row.tau_days,
      row.derived_from, row.vec, row.meta,
    )
    linkEdges(db, row, vec, pad, cfg, now)
  })
  return row
}

function linkEdges(db, row, vec, pad, cfg, now) {
  const recent = db.prepare('SELECT id, content, vec, pad_p, pad_a, pad_d, created_at FROM memories WHERE layer = \'warm\' AND id != ? ORDER BY created_at DESC LIMIT 60').all(row.id)
  const myEntities = entities(row.content)
  const scored = []
  const wantAffect = cfg.edges.affectAlignMin
  for (const m of recent) {
    const mv = fromBlob(m.vec)
    const sim = mv ? cosine(vec, mv) : 0
    const entSim = jaccard(myEntities, entities(m.content))
    const affectSim = cosine([pad.p, pad.a, pad.d], [m.pad_p, m.pad_a, m.pad_d])
    const dtHours = Math.abs(now - m.created_at) / 3600000
    let type = null
    let weight = 0
    if (entSim > 0.12 && entSim >= sim) { type = 'entity_cooccur'; weight = clamp(0.4 + entSim, 0, 1) }
    else if (affectSim >= wantAffect && sim > 0.3) { type = 'affect_align'; weight = clamp(0.4 + affectSim * 0.5, 0, 1) }
    else if (dtHours <= cfg.edges.causalWindowHours && sim > 0.25) { type = 'causal_temporal'; weight = clamp(0.3 + sim * 0.5, 0, 1) }
    if (type) scored.push({ id: m.id, type, weight })
  }
  scored.sort((a, b) => b.weight - a.weight)
  const picked = scored.slice(0, Math.max(cfg.edges.min, Math.min(cfg.edges.max, scored.length)))
  // 不足最低边数时，用最近的记忆补 causal_temporal（保证图不是孤点）
  if (picked.length < cfg.edges.min) {
    for (const m of recent) {
      if (picked.length >= cfg.edges.min) break
      if (picked.some((p) => p.id === m.id)) continue
      picked.push({ id: m.id, type: 'causal_temporal', weight: 0.25 })
    }
  }
  for (const p of picked) {
    for (const [from, to] of [[row.id, p.id], [p.id, row.id]]) {
      db.prepare('INSERT OR IGNORE INTO edges(from_id, to_id, type, weight, created_at) VALUES (?,?,?,?,?)')
        .run(from, to, p.type, p.weight, now)
    }
  }
}

export function recordAccess(db, ids, now = Date.now()) {
  const stmt = db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?')
  for (const id of ids) stmt.run(now, id)
}

/**
 * 检索：rel / importance / recency / mood / association 五项加权，取 top-k，沿边扩散 1 跳。
 * Cold 命中会被“唤醒”回 Warm（并计一次复述）。
 */
export function retrieve(db, { query, pad, cfg, now = Date.now(), k = cfg.retrieval.k }) {
  const qv = embed(query, cfg.embed)
  const rows = db.prepare(`SELECT * FROM memories WHERE layer IN ('warm','cold') ORDER BY last_accessed_at DESC LIMIT ?`).all(cfg.retrieval.candidateLimit)
  const w = cfg.retrieval.weights
  const scored = []
  for (const m of rows) {
    const mv = fromBlob(m.vec)
    const rel = mv ? cosine(qv, mv) : 0
    const rec = Math.exp(-Math.max(0, now - m.last_accessed_at) / (cfg.retrieval.recTauHours * 3600000))
    const mood = mv ? cosine([pad.p, pad.a, pad.d], [m.pad_p, m.pad_a, m.pad_d]) : 0
    const score = w.rel * rel + w.imp * m.importance + w.rec * rec + w.mood * mood
    scored.push({ row: m, score, rel, relParts: { rel, rec, mood } })
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.slice(0, Math.max(1, k))
  const pickedIds = new Set(picked.map((p) => p.row.id))

  // 1 跳联想扩散：邻居只加 w_assoc 的分数，不重新计算相关性
  if (cfg.retrieval.expansionHops > 0 && picked.length) {
    for (const p of [...picked]) {
      const neighbors = db.prepare(`SELECT e.to_id AS id, e.type AS type, e.weight AS weight, m.* FROM edges e
        JOIN memories m ON m.id = e.to_id
        WHERE e.from_id = ? AND m.layer IN ('warm','cold') ORDER BY e.weight DESC LIMIT 5`).all(p.row.id)
      for (const n of neighbors) {
        if (pickedIds.has(n.id)) continue
        const mv = fromBlob(n.vec)
        const rel = mv ? cosine(qv, mv) : 0
        const rec = Math.exp(-Math.max(0, now - n.last_accessed_at) / (cfg.retrieval.recTauHours * 3600000))
        const mood = mv ? cosine([pad.p, pad.a, pad.d], [n.pad_p, n.pad_a, n.pad_d]) : 0
        const score = w.rel * rel + w.imp * n.importance + w.rec * rec + w.mood * mood + w.assoc
        picked.push({ row: n, score, rel, fromAssociation: true, edge: n.type })
        pickedIds.add(n.id)
      }
    }
    picked.sort((a, b) => b.score - a.score)
  }

  const top = picked.slice(0, Math.max(1, k)).map((p) => ({
    ...p,
    retention: retention(p.row, now, cfg),
    tone: toneOf(p.row),
  }))

  // Cold 唤醒：重建为 Warm，计一次复述（一轮最多唤醒 maxRevivalsPerTurn 条，避免一次翻出半本旧账）
  let revivedCount = 0
  for (const hit of top) {
    if (hit.row.layer === 'cold' && revivedCount < cfg.retrieval.maxRevivalsPerTurn) {
      db.prepare('UPDATE memories SET layer = \'warm\', last_accessed_at = ?, meta = ? WHERE id = ?')
        .run(now, JSON.stringify({ ...JSON.parse(hit.row.meta ?? '{}'), revivedAt: now }), hit.row.id)
      hit.revived = true
      hit.row.layer = 'warm'
      revivedCount += 1
    }
  }
  recordAccess(db, top.map((t) => t.row.id), now)
  return top
}

/** 分层迁移：Warm → Cold（R 低或 90 天未访问）；Cold → forgotten（R 太低，记 forget_log） */
export function migrateTiers(db, cfg, now = Date.now()) {
  const result = { archived: 0, forgotten: 0 }
  const warm = db.prepare('SELECT * FROM memories WHERE layer = \'warm\'').all()
  for (const m of warm) {
    const r = retention(m, now, cfg)
    const stale = now - m.last_accessed_at > cfg.retention.staleDays * DAY
    if (r < cfg.retention.archiveBelow || stale) {
      const summary = summarizeForCold(m)
      const slower = Math.max(m.tau_days ?? 3, 3) * cfg.retention.coldTauMultiplier
      const meta = JSON.stringify({ ...safeJson(m.meta), coldSince: now })
      db.prepare('UPDATE memories SET layer = \'cold\', summary = ?, tau_days = ?, meta = ? WHERE id = ?')
        .run(summary, slower, meta, m.id)
      result.archived += 1
    }
  }
  const cold = db.prepare('SELECT * FROM memories WHERE layer = \'cold\'').all()
  const minCold = cfg.retention.minColdDays * DAY
  for (const m of cold) {
    const r = retention(m, now, cfg)
    // 刚进 Cold 的记忆不立即判定遗忘：至少“冷”了 minColdDays 天，才允许掉出
    const coldSince = safeJson(m.meta).coldSince ?? now
    const cooledLongEnough = now - coldSince >= minCold
    if (r < cfg.retention.forgetBelow && cooledLongEnough) {
      db.prepare('UPDATE memories SET layer = \'forgotten\' WHERE id = ?').run(m.id)
      db.prepare('INSERT INTO forget_log(memory_id, score, reason, at, meta) VALUES (?,?,?,?,?)')
        .run(m.id, r, 'retention_below_forget_threshold', now, JSON.stringify({ content: truncate(m.content, 120), type: m.memory_type, importance: m.importance }))
      result.forgotten += 1
    }
  }
  return result
}

export function summarizeForCold(m) {
  const first = truncate(m.content.replace(/\s+/g, ' '), 60)
  return `（早期记忆·${m.memory_type}）${first}`
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : {} } catch { return {} }
}

/** 反思：把近期 episodic 聚类成 semantic */
export function clusterEpisodic(rows, cfg) {
  const clusters = []
  for (const r of rows) {
    const v = fromBlob(r.vec)
    let placed = false
    for (const c of clusters) {
      const sim = cosine(v, c.centroidVec)
      if (sim >= cfg.reflection.clusterSim) {
        c.items.push(r)
        for (let i = 0; i < c.centroidVec.length; i++) c.centroidVec[i] = (c.centroidVec[i] * (c.items.length - 1) + v[i]) / c.items.length
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ items: [r], centroidVec: Float32Array.from(v) })
  }
  return clusters.filter((c) => c.items.length >= cfg.reflection.minCluster)
}
