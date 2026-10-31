// 自主行为演示：一整天（36 小时）里她什么时候想说话、想写、想看东西。
// 用桩 io，不连任何真实 IM；时间用假时钟推进。
import os from 'node:os'
import path from 'node:path'
import { Brain } from './brain.mjs'
import { Autonomy, inQuietHours } from './autonomy.mjs'

const file = path.join(os.tmpdir(), `brain-autonomy-${Date.now()}.sqlite`)
const brain = new Brain({ file })

/* ---- 1. 注册一个扩展段落：把“她现在想干什么”写进 prompt ---- */
brain.ext.register('promptSection', 'drives-hint', () => {
  const snap = globalThis.__autonomy?.drives.snapshot()
  if (!snap) return null
  const top = Object.entries(snap).sort((a, b) => b[1].value - a[1].value)[0]
  if (!top || top[1].level === 'low') return null
  return `【你自己的状态】${top[1].label}（${top[1].level}）。如果话题自然，可以往这上面引一句，但别硬提。`
})

/* ---- 2. 桩 IO：真实接入时换成你自己桥接/IM 的工具调用 ---- */
const out = { messages: [], signatures: [], diaries: [], browses: [] }
let clock = new Date(2026, 9, 31, 9, 0, 0).getTime()
const io = {
  async sendMessage(text, meta) { out.messages.push({ text, meta, at: clock }); return true },
  async setSignature(text) { out.signatures.push({ text, at: clock }); return true },
  async writeDiary(text) { out.diaries.push({ text, at: clock }) },
  async browseSocial({ limit }) {
    out.browses.push({ at: clock, limit })
    return {
      source: 'douyin',
      items: [{ id: 'demo-1', title: '猫在电梯里翻白眼', comments: [{ text: '这猫是有脾气的' }] }],
    }
  },
}

const autonomy = new Autonomy({ brain, io })
globalThis.__autonomy = autonomy
brain.ext.on('action:run', ({ action, ok }) => console.log(`   [hook] ${action} ${ok ? 'ok' : 'fail'}`))

/* ---- 3. 假时钟：从 09:00 起，每 30 分钟 tick 一次 ---- */
const start = clock
const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const STEPS = 72 // 36 小时

console.log(`# 自主循环演示（${fmt(start)} 起，每 30 分钟一拍）\n`)
for (let i = 0; i < STEPS; i += 1) {
  const ran = await autonomy.tick(clock)
  if (ran.length) {
    const quiet = inQuietHours(clock, brain.cfg.autonomy.quietHours) ? '（静默时段）' : ''
    for (const r of ran) {
      console.log(`${fmt(clock)} ${quiet} ${r.id}  priority=${r.priority.toFixed(2)}  ${r.text ? `「${r.text}」` : ''}`)
    }
  }
  // 第 12 小时（21:00）owner 回了一句，顺便看 prompt 里的扩展段
  if (i === 24) {
    const turn = brain.onUserMessage({ text: '今天有点累，刚下班', session: 'owner', now: clock })
    brain.onAssistantReply({ text: '那先歇会儿，别硬撑。', session: 'owner', now: clock })
    console.log(`\n${fmt(clock)} owner 发来：「今天有点累，刚下班」`)
    console.log('--- 这一轮注入的 prompt（前 14 行）---')
    console.log(turn.prompt.split('\n').slice(0, 14).join('\n'))
    console.log('---------------------------\n')
  }
  clock += 30 * 60000
}

/* ---- 4. 结果汇总 ---- */
console.log('\n===== 她今天做了什么 =====')
console.log('主动消息：', out.messages.length, '条')
for (const m of out.messages) console.log(`  ${fmt(m.at)} 「${m.text}」 (${m.meta?.reason}${m.meta?.kind ? '/' + m.meta.kind : ''})`)
console.log('签名：', out.signatures.length, '条')
for (const s of out.signatures) console.log(`  ${fmt(s.at)} 「${s.text}」`)
console.log('日志：', out.diaries.length, '篇')
for (const d of out.diaries) console.log(`  ${fmt(d.at)} ${d.text}`)
console.log('刷视频：', out.browses.length, '次')

console.log('\n===== 自主状态（截断） =====')
console.log(JSON.stringify(autonomy.status(), null, 2).slice(0, 1200))

console.log('\n===== 扩展点清单 =====')
console.log(JSON.stringify(brain.ext.list(), null, 2))

brain.close()
