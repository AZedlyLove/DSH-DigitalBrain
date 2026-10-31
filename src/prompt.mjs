// Prompt 组装：人设 → 语调指引 → 记忆片段 → 行为约束。顺序固定，长度受 maxMemoryChars 约束。
import { truncate } from './text.mjs'

const TYPE_LABEL = { episodic: '经历', semantic: '印象', procedural: '经验' }

export function memoryLine(hit, cfg) {
  const m = hit.row
  const tone = hit.tone ?? '平静'
  const max = cfg.prompt.perMemoryChars.max
  const min = cfg.prompt.perMemoryChars.min
  let body = String(m.summary ?? m.content).replace(/\s+/g, ' ')
  // 太短就补一句“性质”上下文（不要写「你记得这个」这种废话），太长截断到 40~80 字
  body = body.length < min
    ? `${body}（${m.memory_type === 'semantic' ? '你后来想明白的' : m.memory_type === 'procedural' ? '你摸索出的经验' : '你当时就在场'}）`
    : body
  body = truncate(body, max)
  return `你记得：${body}（${TYPE_LABEL[m.memory_type] ?? m.memory_type}·当时的情绪：${tone}）`
}

/** 冲突记忆：主题相近但情绪方向相反的两条，并列标注 */
export function markConflicts(hits) {
  const marks = new Set()
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i].row; const b = hits[j].row
      const topic = hits[i].rel ?? 0
      const opposite = (a.pad_p >= 0.25 && b.pad_p <= -0.25) || (a.pad_p <= -0.25 && b.pad_p >= 0.25)
      if (topic > 0.15 && opposite && a.importance >= 0.4 && b.importance >= 0.4) {
        marks.add(a.id); marks.add(b.id)
      }
    }
  }
  return marks
}

export function buildPrompt({ cfg, pad, toneText, hits, instinct, modulation, extraSections = [] }) {
  const lines = []
  lines.push(cfg.prompt.persona.trim())

  lines.push('')
  lines.push(toneText.trim())

  const memoryLines = []
  let chars = 0
  const conflicts = markConflicts(hits)
  for (const h of hits) {
    let line = memoryLine(h, cfg)
    if (conflicts.has(h.row.id)) line += ' [与另一条相左]'
    if (chars + line.length > cfg.prompt.maxMemoryChars) break
    memoryLines.push(line)
    chars += line.length
  }
  lines.push('')
  lines.push(memoryLines.length ? memoryLines.join('\n') : '你暂时想不起类似的事。')

  // 扩展段落：由 hooks.mjs 的 promptSection provider 提供，插在记忆和行为约束之间
  for (const section of extraSections) {
    const text = String(section ?? '').trim()
    if (!text) continue
    lines.push('')
    lines.push(text)
  }

  lines.push('')
  const constraints = []
  if (instinct.mustReply) constraints.push('对方在叫你/在问事，必须回应，不能装没看见。')
  if (instinct.comfortFirst) constraints.push('对方情绪不好：先安抚，不解释、不讲道理、不抖机灵。')
  if (instinct.directAnswer) constraints.push('你记得相关的事，可以直接说，不要反问对方。')
  constraints.push(modulation.suppressPlayfulness
    ? '这一轮收着说，最多两句话。'
    : `这一轮控制在 ${modulation.maxSentences} 句话内，别写成小作文。`)
  lines.push(constraints.join('\n'))

  return lines.join('\n').trim()
}
