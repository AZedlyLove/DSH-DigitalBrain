// 情绪系统：全局 PAD（-1..1）+ 基线；检索时被记忆“染色”，两轮之间按 τ_e 回落。
import { clamp, padLabel, padMagnitude } from './text.mjs'

export function defaultPad(cfg) {
  const b = cfg.emotion.baseline
  return { p: b.p, a: b.a, d: b.d }
}

export function decayPad(pad, cfg, dtMinutes) {
  const b = cfg.emotion.baseline
  const k = Math.exp(-Math.max(0, dtMinutes) / cfg.emotion.tauEMinutes)
  return {
    p: pad.p * k + b.p * (1 - k),
    a: pad.a * k + b.a * (1 - k),
    d: pad.d * k + b.d * (1 - k),
  }
}

/**
 * ΔPAD = memory.affect_vector * R * β
 * 若命中记忆通过联想边连着 k 条同调记忆，ΔPAD *= (1 + γk)，上限 1.5 倍。
 * semantic（反思）记忆：幅度 ×semanticAffectFactor，但 τ 更大 → 影响温和持久。
 */
export function applyMemoryAffect(pad, hits, cfg) {
  // 工程护栏：一轮里被多条同情绪记忆叠加会把 PAD 顶到 ±1，情绪失去分辨度。
  // 只取“最抓人”的 maxMemoriesPerTurn 条，并限制单轮总位移 maxDeltaPerTurn。
  const affinity = (h) => {
    const m = h.row ?? h
    return (h.retention ?? 0.5) * padMagnitude({ p: m.pad_p ?? 0, a: m.pad_a ?? 0, d: m.pad_d ?? 0 })
  }
  const contributors = [...hits].sort((a, b) => affinity(b) - affinity(a))
    .slice(0, Math.max(1, cfg.emotion.maxMemoriesPerTurn))
  let dp = 0; let da = 0; let dd = 0
  for (const h of contributors) {
    const m = h.row ?? h
    const r = h.retention ?? 0.5
    const isSemantic = (m.memory_type === 'semantic')
    const factor = isSemantic ? cfg.emotion.semanticAffectFactor * 0.6 : 1
    const toneHits = contributors.filter((o) => {
      const om = o.row ?? o
      if (om.id === m.id) return false
      const dot = (om.pad_p ?? 0) * (m.pad_p ?? 0) + (om.pad_a ?? 0) * (m.pad_a ?? 0) + (om.pad_d ?? 0) * (m.pad_d ?? 0)
      return dot > 0.3
    }).length
    const amp = Math.min(cfg.emotion.gammaCap, 1 + cfg.emotion.gamma * toneHits)
    dp += (m.pad_p ?? 0) * r * cfg.emotion.beta * amp * factor
    da += (m.pad_a ?? 0) * r * cfg.emotion.beta * amp * factor
    dd += (m.pad_d ?? 0) * r * cfg.emotion.beta * amp * factor
  }
  const cap = cfg.emotion.maxDeltaPerTurn
  // 靠近 ±1 时位移按 (1-|x|) 收窄：情绪越满越难再被推，保留分辨度（否则一步就贴顶）
  const damp = (x, d) => x + clamp(d, -cap, cap) * (1 - Math.abs(x))
  return {
    p: clamp(damp(pad.p, dp)),
    a: clamp(damp(pad.a, da)),
    d: clamp(damp(pad.d, dd)),
  }
}

/** 行为结果对情绪的反作用：β 减半 */
export function applyOutcomeAffect(pad, outcome, cfg) {
  const map = { positive: { p: 0.25, a: 0.1, d: 0.05 }, negative: { p: -0.3, a: 0.15, d: -0.1 }, neutral: { p: 0, a: 0, d: 0 } }
  const v = map[outcome] ?? map.neutral
  const beta = cfg.emotion.beta * cfg.emotion.behaviorBetaFactor
  return {
    p: clamp(pad.p + v.p * beta),
    a: clamp(pad.a + v.a * beta),
    d: clamp(pad.d + v.d * beta),
  }
}

/**
 * 把 PAD 翻译成**可操作参数**，不写“你很高兴”。
 * 三维各三档，加一句行为倾向；同时给出本能与情绪的优先级说明。
 */
export function toneGuidance(pad, cfg) {
  const pl = padLabel(pad.p)     // 愉悦度
  const al = padLabel(pad.a)     // 唤醒度
  const dl = padLabel(pad.d)     // 支配感
  const mag = padMagnitude(pad)
  const instinctDominant = mag < cfg.emotion.instinctThreshold

  const P_TEXT = {
    low: '积极词汇少，不主动延伸话题；对方示好也收着回',
    mid: '常态用词，可以接梗但不夸张',
    high: '积极词汇偏多，愿意主动延伸话题、多问一句',
  }
  const A_TEXT = {
    low: '句子偏长、语气平；少用语气词，表情 0~1 个',
    mid: '句长中等，偶尔语气词（啊/吧/呢），表情 0~1 个',
    high: '句子偏短、有节奏；语气词和表情可以多一个，但不刷屏',
  }
  const D_TEXT = {
    low: '多跟随、多附和，少下判断；把决定权交回对方',
    mid: '该提问就提问，结论留余地',
    high: '可以主动提问、给出明确判断或建议，语气更笃定',
  }
  const tendency = (() => {
    if (pl === 'low' && al === 'high') return '先接住情绪，别讲道理；一两句话，别展开'
    if (pl === 'low') return '简短回应，不主动展开话题'
    if (pl === 'high' && al === 'high') return '可以活跃、接梗，但注意别抢话'
    if (dl === 'high') return '可以主导话题，给出明确建议'
    return '自然接话，控制在两三句'
  })()

  return [
    '当前情绪状态：',
    `- 愉悦度：${pl}（影响：${P_TEXT[pl]}）`,
    `- 唤醒度：${al}（影响：${A_TEXT[al]}）`,
    `- 支配感：${dl}（影响：${D_TEXT[dl]}）`,
    `行为倾向：${tendency}`,
    instinctDominant
      ? '本能与情绪冲突时：当前情绪强度不足，本能否决权更高，情绪只做语调染色。'
      : '本能与情绪冲突时：情绪可以改变回应的“形态”（长短/语气/是否追问），但不能取消本能要求的“必须回应”。',
  ].join('\n')
}

export function emotionSnapshot(pad, cfg) {
  return {
    pad: { p: round3(pad.p), a: round3(pad.a), d: round3(pad.d) },
    magnitude: round3(padMagnitude(pad)),
    instinctDominant: padMagnitude(pad) < cfg.emotion.instinctThreshold,
    levels: { pleasure: padLabel(pad.p), arousal: padLabel(pad.a), dominance: padLabel(pad.d) },
  }
}

function round3(x) { return Math.round(x * 1000) / 1000 }
