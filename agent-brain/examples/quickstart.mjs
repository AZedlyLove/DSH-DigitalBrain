// Minimal quickstart: one conversation, watch memory + affect accumulate.
import os from 'node:os'
import path from 'node:path'
import { Brain } from '../src/brain.mjs'

const file = path.join(os.tmpdir(), `agent-brain-quickstart-${Date.now()}.sqlite`)
const brain = new Brain({ file })

const turns = [
  '我叫小林，在杭州做后端，最近天天加班到十一点，累死了',
  '今天产品又改需求，第三次了，真烦',
  '你还记得我是做什么的吗？',
]

for (const text of turns) {
  const r = brain.onUserMessage({ text, session: 'quickstart' })
  console.log(`\n用户：${text}`)
  console.log(`  写入：${r.gate.written ? 'Warm' : '只进 Hot'}（importance ${r.gate.importance.toFixed(2)}）`)
  console.log(`  情绪：p=${r.pad.p.toFixed(2)} a=${r.pad.a.toFixed(2)} d=${r.pad.d.toFixed(2)}`)
  if (r.hits.length) console.log(`  想起：${r.hits.map((h) => h.row.content.slice(0, 18)).join(' | ')}`)
  brain.onAssistantReply({ text: '（示例回复）', session: 'quickstart' })
}

console.log('\n===== 下一轮会注入的 prompt =====')
console.log(brain.onUserMessage({ text: '那我先睡了', session: 'quickstart' }).prompt)

console.log('\n===== status =====')
console.log(JSON.stringify(brain.status().memories))
brain.close()
