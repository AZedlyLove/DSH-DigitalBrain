// 所有可调参数集中在这里；运行时可改（存进 SQLite 的 state 表，重启不丢）。
// 不要在任何业务代码里硬编码阈值。
export const DEFAULT_CONFIG = Object.freeze({
  hot: {
    // Hot 层：当前上下文窗口内的近期原文（按“轮”计，1 轮 = 用户 + 助手）
    turns: 10,
  },
  gate: {
    // 三轴重要性门控的权重与阈值
    threshold: 0.25,
    weights: { directive: 0.40, affect: 0.35, novelty: 0.25 },
    // 低于阈值只进 Hot，不进 Warm
  },
  retention: {
    // R = exp(-Δt/S) * (1 + 0.45*Nr + 0.30*I + 0.25*F), S = ln(1+Nr)
    floorS: 0.35,        // Nr=0 时 ln(1)=0 会除零，给一个下限
    archiveBelow: 0.40,  // Warm 的 R 低于它 → 压缩进 Cold
    forgetBelow: 0.10,   // 再低 → 归档进 forget_log（只追加，不物理删除）
    staleDays: 90,       // 90 天没访问 → 也进 Cold
    coldTauMultiplier: 3, // 进 Cold 后衰减变慢（3 倍 τ），别刚归档就忘掉
    minColdDays: 30,      // 至少在 Cold 里待 30 天，才可能进 forget_log
    halfLifeBoost: { access: 0.45, importance: 0.30, affect: 0.25 },
  },
  retrieval: {
    k: 4,
    // retrieval_score = wRel*cos + wImp*I + wRec*exp(-h/168) + wMood*cos(PAD) + wAssoc*[from_edge]
    weights: { rel: 0.40, imp: 0.25, rec: 0.15, mood: 0.10, assoc: 0.10 },
    recTauHours: 168,
    expansionHops: 1,
    candidateLimit: 200,
    maxRevivalsPerTurn: 1, // 一轮最多把几条 Cold 唤醒回 Warm
  },
  emotion: {
    baseline: { p: 0.15, a: 0.05, d: 0.10 },
    beta: 0.35,            // 情绪易感性 0.2~0.6
    gamma: 0.15,           // 同调联想边的放大系数
    gammaCap: 1.5,
    tauEMinutes: 45,       // 两轮之间向基线回落的时间常数
    instinctThreshold: 0.3, // |A| < 0.3 本能主导；>= 0.3 情绪可改形态
    behaviorBetaFactor: 0.5, // 行为结果对情绪的影响减半
    semanticAffectFactor: 0.5, // 反思产出的 semantic 情绪幅度
    maxMemoriesPerTurn: 3,   // 一轮最多有几条记忆参与情绪更新（防饱和）
    maxDeltaPerTurn: 0.35,   // 单轮 PAD 总位移上限（防一步跳到 ±1）
  },
  edges: {
    min: 2,
    max: 4,
    affectAlignMin: 0.55,
    causalWindowHours: 6,
  },
  reflection: {
    everyTurns: 24,
    daily: true,
    minCluster: 2,
    semanticImportanceFloor: 0.5,
    tauMultiplier: 2.5,
    clusterSim: 0.45,
  },
  prompt: {
    persona: '你是一个有点笨拙但认真、会开玩笑也会看气氛的聊天搭子。',
    maxMemoryChars: 1200,   // 记忆区块总字数上限（≈600-800 token 的中文保守估计）
    perMemoryChars: { min: 40, max: 80 },
  },
  embed: { dim: 256, ngram: 3 },
  tick: { autoEveryMessages: 1 }, // 每条消息都跑一次衰减/迁移
  // 驱力：覆盖 DEFAULT_DRIVES（drives.mjs）里同名条目的参数
  drives: { defs: {} },
  // 自主循环：她自己什么时候可以做事
  autonomy: {
    quietHours: { start: '23:30', end: '08:00' }, // 这段时间不主动找人、不改签名
    minGapMinutes: 45,      // 两个“对外动作”之间至少隔这么久
    maxActionsPerTick: 1,   // 一个 tick 最多做一件事
    browseLimit: 3,         // 一次刷几条
    shareAfterBrowse: true, // 刷到有趣的要不要顺手分享
    thresholds: {
      proactiveChat: 0.55,  // social 驱力到多少才主动搭话
      postSignature: 0.60,
      writeDiary: 0.45,
      browseSocial: 0.40,
    },
  },
})

/** 深合并：用户配置覆盖默认值，未知字段保留。 */
export function mergeConfig(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeConfig(base?.[k] ?? {}, v) : v
  }
  return out
}
