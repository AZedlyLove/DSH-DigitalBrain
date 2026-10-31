// 端到端演示：同一段对话里看门控、检索、情绪、反思、遗忘。
// 用临时库，不污染正式数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Brain } from './brain.mjs'

const file = path.join(os.tmpdir(), `brain-demo-${Date.now()}.sqlite`)
const brain = new Brain({ file, config: { hot: { turns: 10 } } })
const T0 = Date.now()
let clock = T0
const tick = (minutes = 2) => { clock += minutes * 60000; return clock }

const script = [
  ['我叫小林，在杭州做后端，最近天天加班到十一点，累死了', false],
  ['今天产品又改需求，第三次了，真烦', false],
  ['你还记得我是做什么的吗？', false],
  ['我养了只猫叫年糕，三岁了，特别粘人', false],
  ['年糕今天把我杯子打翻了，气死我了', false],
  ['不过它蹭我的时候又没办法生气', false],
  ['周末想去爬山，杭州附近有什么推荐吗？', false],
  ['最近睡得也不好，躺下就胡思乱想', false],
  ['你说我这样下去会不会垮掉', false],
  ['算了，先不想了，谢谢你听我说', false],
]

console.log(`# 临时库：${file}\n`)
for (const [text, at] of script) {
  const r = brain.onUserMessage({ text, session: 'demo', atMention: at, now: tick() })
  printTurn(text, r)
  brain.onAssistantReply({ text: '（示例回复）', session: 'demo', now: tick(0) })
}
console.log('\n===== 第 3 轮实际注入的 prompt =====')
{
  const b2 = new Brain({ file: path.join(os.tmpdir(), `brain-sample-${Date.now()}.sqlite`) })
  for (const [text] of script.slice(0, 2)) {
    b2.onUserMessage({ text, session: 'x', now: tick(1) })
    b2.onAssistantReply({ text: '嗯', session: 'x', now: tick(0) })
  }
  const last = b2.onUserMessage({ text: '你还记得我是做什么的吗？', session: 'x', now: tick(1) })
  console.log(last.prompt)
  b2.close()
}

console.log('\n===== 反思（把 episodic 聚类成 semantic）=====')
const created = brain.reflect({ now: tick(1) })
for (const c of created) console.log(`+ [${c.id}] ${c.text}  (来源 ${c.from} 条)`)

console.log('\n===== status() =====')
console.log(JSON.stringify(brain.status(), null, 2))

console.log('\n===== 模拟 20 天后：Warm → Cold =====')
const t20 = clock + 20 * 86400000
console.log('migrate:', brain.tick(t20))
console.log('memories:', JSON.stringify(brain.status().memories))

console.log('\n===== Cold 记忆被检索命中 → 唤醒回 Warm =====')
const coldRow = brain.db.prepare("SELECT id, content FROM memories WHERE layer = 'cold' LIMIT 1").get()
if (coldRow) {
  const r = brain.onUserMessage({ text: coldRow.content.slice(0, 10), session: 'demo', now: t20 + 60000 })
  const hitIds = new Set(r.hits.map((h) => h.row.id))
  console.log(`查「${coldRow.content.slice(0, 10)}…」→ 命中 ${r.hits.length} 条，其中 ${hitIds.has(coldRow.id) ? '目标已被唤醒' : '目标未命中'}`)
  console.log(`目标层：${brain.db.prepare('SELECT layer FROM memories WHERE id = ?').get(coldRow.id).layer}`)
  console.log('memories:', JSON.stringify(brain.status().memories))
} else {
  console.log('（没有 cold 记忆可唤醒）')
}

console.log('\n===== 再模拟 200 天无访问：Cold → forget_log =====')
const t200 = clock + 220 * 86400000
console.log('migrate:', brain.tick(t200))
console.log('memories:', JSON.stringify(brain.status().memories))
const forgotten = brain.db.prepare('SELECT memory_id, round(score,4) score, reason FROM forget_log ORDER BY id DESC LIMIT 3').all()
console.log('forget_log 最近 3 条:', JSON.stringify(forgotten, null, 2))

brain.close()
fs.rmSync(file, { force: true })

function printTurn(text, r) {
  const ids = r.hits.map((h) => `${h.row.id.slice(0, 8)}(${h.score.toFixed(2)}${h.revived ? ',revived' : ''}${h.fromAssociation ? ',assoc' : ''})`).join(' ') || '无'
  console.log(`\n用户：${text}`)
  console.log(`  门控 importance=${r.gate.importance.toFixed(2)} parts=${JSON.stringify(r.gate.parts)} → ${r.gate.written ? '写入 Warm ' + r.gate.written.slice(0, 8) : '只进 Hot'}`)
  console.log(`  检索 k=${r.hits.length}: ${ids}`)
  console.log(`  PAD p=${r.pad.p.toFixed(2)} a=${r.pad.a.toFixed(2)} d=${r.pad.d.toFixed(2)}  本能=[${r.instincts.reasons.join(',')}]`)
}
