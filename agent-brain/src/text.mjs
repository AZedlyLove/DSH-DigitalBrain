// 文本侧的小工具：情绪估计、指令性检测、实体抽取、截断。
// 这里全是确定性的启发式规则，不调用模型——门控与情绪更新必须便宜、可解释、可测试。

const POSITIVE = ['开心', '高兴', '喜欢', '爱', '好玩', '有趣', '笑死', '哈哈', '嘿嘿', '爽', '棒', '好耶', '厉害', '可爱', '温柔', '谢谢', '舒服', '期待', '满意', '治愈']
const NEGATIVE = ['难过', '伤心', '累', '烦', '气死', '讨厌', '难受', '焦虑', '压力', '烦死', '无语', '崩溃', 'emo', '委屈', '孤独', '害怕', '恶心', '吐了', '服了', '恶心死了']
const AROUSAL_UP = ['！', '!', '啊啊', '卧槽', '我靠', '天啊', '真的', '居然', '竟然', '太', '超级', '特别', '巨', '死', '爆', '疯']
const DOMINANT = ['必须', '一定', '不要', '别', '听我的', '就这样', '立刻', '马上', '我说了算', '给我']
const HEDGE = ['可能', '也许', '大概', '随便', '都行', '算了', '好像', '不太确定', '或许', '应该吧']

const DIRECTIVE_PATTERNS = [
  /我(?:很|最|比较|超)?(?:喜欢|讨厌|爱|怕|受不了|习惯)/,
  /记住|别忘|记一下|帮我记|记下来/,
  /答应|约好|说好|承诺|以后(?:都|就|别)/,
  /每天|每周|每晚|早上|晚上都/,
  /我(?:叫|是|住在|在.{1,8}(?:工作|上班|上学|读书))/,
  /生日|纪念日|忌口|过敏|不吃|不能吃/,
  /我的(?:猫|狗|电脑|手机|工作|老板|室友|妈妈|爸爸)/,
]

export function estimateAffect(text) {
  const s = String(text ?? '')
  const lower = s.toLowerCase()
  let v = 0
  for (const w of POSITIVE) if (lower.includes(w)) v += 0.55
  for (const w of NEGATIVE) if (lower.includes(w)) v -= 0.6
  if (/[😂🤣😄😆🥰😍😊]/u.test(s)) v += 0.35
  if (/[😭😢🥲😞😔😩😫🙃]/u.test(s)) v -= 0.35
  v = clamp(v)

  let a = 0
  a += Math.min(0.5, (s.match(/[!！?？]/g) ?? []).length * 0.12)
  for (const w of AROUSAL_UP) if (lower.includes(w)) a += 0.18
  if (/(.)\1{2,}/.test(s)) a += 0.15 // 重复字符：哈哈哈、啊啊啊
  a = clamp(Math.max(0, a))

  let d = 0
  for (const w of DOMINANT) if (lower.includes(w)) d += 0.25
  for (const w of HEDGE) if (lower.includes(w)) d -= 0.2
  d = clamp(d)

  return { p: v, a, d }
}

export function directiveScore(text) {
  const s = String(text ?? '')
  let hits = 0
  for (const re of DIRECTIVE_PATTERNS) if (re.test(s)) hits += 1
  if (/[?？]\s*$/.test(s)) hits += 0.15 // 提问往往带信息
  return clamp(hits / 2) // 命中两条即满分
}

export function isQuestion(text) {
  const s = String(text ?? '')
  return /[?？]\s*$/.test(s) || /(?:吗|呢|怎么|为什么|如何|哪个|多少|是不是|能不能|要不要)\s*[?？]?$/.test(s)
}

const SEGMENTER = (() => {
  try { return new Intl.Segmenter('zh', { granularity: 'word' }) } catch { return null }
})()

/** 中文分词（Intl.Segmenter），失败时退回 2 字滑窗。只保留“像词”的片段。 */
export function words(text) {
  const s = String(text ?? '')
  if (SEGMENTER) {
    return [...SEGMENTER.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment)
  }
  const out = []
  for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n))
  return out
}

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '现在', '就是', '可以', '不是', '没有', '一个',
  '这样', '那样', '还是', '因为', '所以', '但是', '然后', '如果', '而且', '已经', '自己', '时候', '真的',
  '感觉', '觉得', '知道', '东西', '一下', '有点', '其实', '可能', '应该', '东西', '不过', '今天', '明天',
  '昨天', '时候', '这种', '那种', '一直', '特别', '非常', '还有', '以后', '之前', '一次', '一点', '有点',
])

/** 实体：@/#/引号/英文词 + 中文实词（≥2 字、非停用词、非纯数字） */
export function entities(text) {
  const s = String(text ?? '')
  const out = new Set()
  for (const m of s.matchAll(/@([\w\u4e00-\u9fa5]{1,20})/g)) out.add(`@${m[1]}`)
  for (const m of s.matchAll(/#([\w\u4e00-\u9fa5]{1,20})/g)) out.add(`#${m[1]}`)
  for (const m of s.matchAll(/[「『"“']([^」』"”']{1,12})[」』"”']/g)) out.add(m[1])
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_+-]{1,15}/g)) out.add(m[0].toLowerCase())
  for (const w of words(s)) {
    if (w.length < 2) continue
    if (/^[\d\s]+$/.test(w)) continue
    if (STOP_WORDS.has(w)) continue
    out.add(w)
  }
  return [...out].slice(0, 40)
}

/** 高频实词（用于反思合成）：跨多条记忆统计，只留出现 ≥2 次的词 */
export function frequentWords(texts, n = 3) {
  // 虚词单字：出现在词首/词尾时基本是拼接产物，不当主题词
  const FUNC_CHARS = new Set([...'的了是在有和就都也还又很太把被给对从跟与而但着过呢吧啊吗对吧嘛'])
  const freq = new Map()
  for (const t of texts) {
    for (const w of new Set(words(t))) {
      if (w.length < 2 || STOP_WORDS.has(w) || /^[\d\s]+$/.test(w)) continue
      // 虚词开头/结尾的组合（“是有”“了这”“在这个”）不是主题词
      if (FUNC_CHARS.has(w[0]) || FUNC_CHARS.has(w[w.length - 1])) continue
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }
  }
  return [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w)
}

export function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

export function clamp(x, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, x))
}

export function truncate(s, max) {
  const str = String(s ?? '')
  return str.length <= max ? str : `${str.slice(0, Math.max(0, max - 1))}…`
}

export function padMagnitude({ p = 0, a = 0, d = 0 }) {
  return Math.sqrt(p * p + a * a + d * d) / Math.sqrt(3)
}

export function padLabel(x) {
  if (x <= -0.35) return 'low'
  if (x >= 0.35) return 'high'
  return 'mid'
}

export { jaccard as similaritySets }
