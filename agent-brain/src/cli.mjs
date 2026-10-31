#!/usr/bin/env node
// 运维小工具：查看状态、手动迁移、手动反思、试检索。
// 用法：node src/cli.mjs status|tick|reflect|recall <文本> [--db brain.sqlite]
import path from 'node:path'
import { Brain } from './brain.mjs'
import { truncate } from './text.mjs'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'status'
const dbIdx = args.indexOf('--db')
const file = dbIdx >= 0 ? args[dbIdx + 1] : path.join(process.cwd(), 'brain.sqlite')
const brain = new Brain({ file })

try {
  if (cmd === 'status') {
    console.log(JSON.stringify(brain.status(), null, 2))
  } else if (cmd === 'tick') {
    console.log('migrate:', brain.tick())
    console.log(JSON.stringify(brain.status().memories))
  } else if (cmd === 'reflect') {
    const created = brain.reflect()
    for (const c of created) console.log(`+ [${c.id}] ${c.text}`)
    if (!created.length) console.log('（这轮没有可合成的记忆）')
  } else if (cmd === 'recall') {
    const q = args.slice(1).filter((a) => a !== '--db' && a !== file).join(' ')
    const r = brain.onUserMessage({ text: q, session: 'cli' })
    console.log(r.prompt)
    console.log('\n--- 命中 ---')
    for (const h of r.hits) {
      console.log(`${h.score.toFixed(3)}  ${h.row.memory_type}/${h.row.layer}  ${truncate(h.row.content, 50)}${h.revived ? '  [唤醒]' : ''}${h.fromAssociation ? '  [联想]' : ''}`)
    }
  } else {
    console.error(`未知命令：${cmd}（可用：status / tick / reflect / recall <文本>）`)
    process.exitCode = 1
  }
} finally {
  brain.close()
}
