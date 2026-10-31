// 本地哈希嵌入：char n-gram → 固定维度，L2 归一化。
// 这是“能离线跑、确定性、可替换”的权宜方案；接真实 embedding 时替换 embed() 即可，
// 其余代码只依赖 cosine() 和向量长度。
import { createHash } from 'node:crypto'

export function embed(text, { dim = 256, ngram = 3 } = {}) {
  const vec = new Float32Array(dim)
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!s) return vec
  const grams = []
  for (let n = 2; n <= ngram; n++) {
    for (let i = 0; i + n <= s.length; i++) grams.push(s.slice(i, i + n))
  }
  for (const g of grams) {
    const h = createHash('md5').update(g).digest()
    const idx = ((h[0] << 8) | h[1]) % dim
    const sign = h[2] % 2 === 0 ? 1 : -1
    vec[idx] += sign
  }
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm
  return vec
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  // 两边都归一化过，点积即余弦
  return Math.max(-1, Math.min(1, dot))
}

export function toBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function fromBlob(buf) {
  if (!buf) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}
