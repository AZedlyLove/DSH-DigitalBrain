// 行为系统：本能（不经情绪调制，直接触发）+ 情绪调制（语调指引）+ 行为结果回收
import { clamp, isQuestion, padMagnitude } from './text.mjs'

/**
 * 本能规则：
 *  1) 被 @ 必回
 *  2) 收到问题，且检索到高置信度记忆 → 直接回答
 *  3) 用户这一条消息本身强烈负面 → 安抚优先（看本轮情绪，不看滞后的全局 PAD）
 */
export function instincts({ text, atMention = false, hits = [], pad, userAffect = { p: 0 } }, cfg) {
  const reasons = []
  let mustReply = atMention || isQuestion(text)
  if (atMention) reasons.push('at_mention')
  if (isQuestion(text)) reasons.push('question')

  const comfortFirst = (userAffect?.p ?? 0) <= -0.3 || pad.p <= -0.55
  if (comfortFirst) reasons.push('strong_negative_user_affect')
  if (comfortFirst) mustReply = true

  const top = hits[0]
  const directAnswer = Boolean(top && top.score >= 0.55 && (top.rel ?? 0) >= 0.25)
  if (directAnswer) reasons.push('high_confidence_memory')

  return {
    mustReply,
    comfortFirst,
    directAnswer,
    confidence: top ? round2(top.score) : 0,
    reasons,
  }
}

/** 情绪调制：不取消本能，只改变形态 */
export function modulation({ pad, instincts: inst }, cfg) {
  const mag = padMagnitude(pad)
  return {
    enabled: true,
    canChangeForm: mag >= cfg.emotion.instinctThreshold,
    cannotCancelInstinct: inst.mustReply,
    // 安抚优先时，即使情绪高涨也压住表现欲
    suppressPlayfulness: inst.comfortFirst || pad.p <= -0.3,
    maxSentences: inst.comfortFirst ? 2 : mag >= 0.5 ? 3 : 2,
  }
}

/** 从“用户下一条消息”推断上一条行为的结果 */
export function classifyReaction(nextUserText) {
  if (nextUserText == null) return 'none'
  const s = String(nextUserText).trim()
  if (!s) return 'none'
  if (/[?？]$|^(为什么|怎么|那|所以)/.test(s)) return 'positive' // 继续追问 = 有接住
  if (/(谢谢|哈哈|笑死|懂了|好的|可以|有用|厉害|牛)/.test(s)) return 'positive'
  if (/(闭嘴|烦|无语|别说了|滚|不想|没用|答非所问|听不懂)/.test(s)) return 'negative'
  return 'neutral'
}

/** 行为模式的累积统计，供反思合成 procedural 记忆 */
export function bumpPattern(patterns, { behavior, pad, reaction }, cfg) {
  const key = `${behavior}|${bucket(pad)}|${reaction}`
  const item = patterns[key] ?? { behavior, mood: bucket(pad), reaction, n: 0 }
  item.n += 1
  patterns[key] = item
  return patterns
}

export function proceduralCandidates(patterns) {
  return Object.values(patterns)
    .filter((p) => p.n >= 3 && p.reaction !== 'neutral')
    .map((p) => ({
      text: `在${p.mood}的状态下做「${p.behavior}」，用户反应偏${p.reaction === 'positive' ? '积极' : '负面'}（${p.n} 次）。`,
      n: p.n,
      reaction: p.reaction,
    }))
}

function bucket(pad) {
  if (pad.p >= 0.3 && pad.a >= 0.3) return '情绪高涨'
  if (pad.p <= -0.3) return '情绪低落'
  if (pad.a >= 0.45) return '激动'
  return '平静'
}

function round2(x) { return Math.round(x * 100) / 100 }
export { clamp }
