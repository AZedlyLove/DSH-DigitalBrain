// 行为插件：每个动作都是纯描述 + 一个 run()，自主循环只负责挑和限流。
// 想加新行为（比如“给某条动态点赞”“换头像”“唱一句”）就在这里加一个对象，核心不用改。
import { estimateAffect, padLabel, truncate, words } from './text.mjs'
import { listJournal } from './db.mjs'
import * as M from './memory.mjs'

/* ---------------- 文案素材（模板兜底；接了 composer 就交给模型写） ---------------- */

const OPENERS = {
  memory: [
    (q) => `突然想起你之前说「${q}」，后来怎么样了？`,
    (q) => `翻到一条旧记忆：${q}。你现在还这样吗？`,
  ],
  idle: [
    () => '在忙吗？我这边有点安静。',
    () => '有点想找人说话，你那边怎么样？',
    () => '刚发了会儿呆，来问问你在干嘛。',
  ],
  share: [
    (t, c) => `刚看到一个：${t}${c ? `，评论说「${c}」` : ''}。`,
  ],
}

const SIGNATURES = {
  high: ['今天状态不错，风都是软的', '有点开心，先记一下'],
  mid: ['在过日子，也在记事情', '今天没什么大事，挺好'],
  low: ['有点累，但还在', '电量不太够，慢慢来'],
  excited: ['脑子里有点吵，想找点事做', '心跳有点快，说不上为什么'],
}

const DIARY = (parts) => [
  `今天聊了 ${parts.turns} 句。`,
  parts.memories.length ? `印象最深的是：${parts.memories.join('；')}。` : '',
  `情绪落在${parts.tone}。`,
  parts.drives.length ? `现在${parts.drives.join('、')}。` : '',
].filter(Boolean).join('')

/* ---------------- 内置动作 ---------------- */

export function builtinActions() {
  return [
    {
      id: 'proactive_chat',
      label: '主动找 owner 说话',
      drive: 'social',
      quietHours: true,
      cooldownMin: 90,
      dailyCap: 3,
      priority: (ctx) => {
        const silence = ctx.silentHours
        const base = ctx.drives.get('social')
        return Math.min(1, base * (1 + Math.min(0.5, silence / 12)))
      },
      can: (ctx) => {
        if (!ctx.io.sendMessage) return '没有发送通道'
        if (ctx.drives.get('social') < ctx.cfg.autonomy.thresholds.proactiveChat) return '还没到想说话的程度'
        return true
      },
      async run(ctx) {
        const quote = pickQuote(ctx)
        const kind = quote ? 'memory' : 'idle'
        const seed = kind === 'memory'
          ? `你突然想起对方以前说过「${quote}」，想主动问一句近况。写一句不超过 30 字的中文开场，不要客套。`
          : '你有点想找人说话。写一句不超过 25 字的中文开场，自然一点，不要问“在吗”。'
        const text = await compose(ctx, seed, () => {
          const fns = OPENERS[kind]
          const n = Math.floor(ctx.now / 3600000)
          return fns[n % fns.length](quote, null)
        })
        const sent = await ctx.io.sendMessage(text, { reason: 'proactive', kind })
        return {
          ok: sent !== false,
          text,
          detail: { kind, quote },
          journal: { kind: 'note', content: text },
        }
      },
    },

    {
      id: 'post_signature',
      label: '改个性签名',
      drive: 'expression',
      quietHours: true,
      cooldownMin: 720,
      dailyCap: 1,
      priority: (ctx) => ctx.drives.get('expression'),
      can: (ctx) => {
        if (!ctx.io.setSignature) return '没有签名通道'
        if (ctx.drives.get('expression') < ctx.cfg.autonomy.thresholds.postSignature) return '还不想表达'
        return true
      },
      async run(ctx) {
        const mood = signatureMood(ctx.pad)
        const pool = SIGNATURES[mood.key]
        const seed = `按你现在的情绪（愉悦度${padLabel(ctx.pad.p)}/唤醒度${padLabel(ctx.pad.a)}），写一句 12 字以内的个性签名。`
        const text = await compose(ctx, seed, () => pool[Math.floor(Math.random() * pool.length)])
        const res = await ctx.io.setSignature(text)
        return { ok: res !== false, text, detail: { mood: mood.key }, journal: { kind: 'signature', content: text } }
      },
    },

    {
      id: 'write_diary',
      label: '写今天的日志',
      drive: 'expression',
      quietHours: false, // 日志可以晚上安静地写
      cooldownMin: 600,
      dailyCap: 1,
      priority: (ctx) => ctx.drives.get('expression') * 0.9,
      can: (ctx) => {
        if (ctx.drives.get('expression') < ctx.cfg.autonomy.thresholds.writeDiary) return '还不到想写的时候'
        const today = startOfDay(ctx.now)
        if (listJournal(ctx.db, { kind: 'diary', limit: 1 }).some((j) => j.at >= today)) return '今天已经写过'
        return true
      },
      async run(ctx) {
        const since = startOfDay(ctx.now)
        const rows = ctx.db.prepare(`SELECT * FROM memories WHERE layer IN ('warm','cold') AND created_at >= ?
          ORDER BY importance DESC LIMIT 3`).all(since)
        const turns = ctx.db.prepare('SELECT COUNT(*) c FROM turn_log WHERE at >= ?').get(since).c
        const parts = {
          turns,
          memories: rows.map((r) => truncate(r.content, 28)),
          tone: padLabel(ctx.pad.p) === 'low' ? '偏低' : padLabel(ctx.pad.p) === 'high' ? '偏亮' : '中间',
          drives: Object.entries(ctx.drives.snapshot()).filter(([, d]) => d.level === 'high').map(([, d]) => d.label),
        }
        const text = parts.turns || parts.memories.length ? DIARY(parts) : '今天没发生什么，但也就这样过去了。'
        if (ctx.io.writeDiary) await ctx.io.writeDiary(text)
        return { ok: true, text, detail: parts, journal: { kind: 'diary', content: text } }
      },
    },

    {
      id: 'browse_social',
      label: '刷视频 / 看评论',
      drive: 'curiosity',
      quietHours: false,
      cooldownMin: 75,
      dailyCap: 4,
      priority: (ctx) => ctx.drives.get('curiosity'),
      can: (ctx) => {
        if (!ctx.io.browseSocial) return '没有社交频道'
        if (ctx.drives.get('curiosity') < ctx.cfg.autonomy.thresholds.browseSocial) return '还不想看'
        return true
      },
      async run(ctx) {
        const feed = await ctx.io.browseSocial({ limit: ctx.cfg.autonomy.browseLimit })
        const items = feed?.items ?? []
        if (!items.length) return { ok: false, detail: { reason: 'empty_feed' } }
        // 刷到过的不再重复记：按 itemId 查一遍
        const seen = (id) => {
          if (id == null) return false
          return Boolean(ctx.db.prepare('SELECT 1 FROM memories WHERE meta LIKE ? LIMIT 1').get(`%"itemId":"${String(id)}"%`))
        }
        const top = items.find((it) => !seen(it.id)) ?? items[0]
        const duplicate = seen(top.id)
        const comment = top.comments?.[0]?.text
        // 看过的内容进记忆：importance 0.45，情绪按标题估
        const memText = `刷到《${top.title}》${comment ? `，热评「${truncate(comment, 40)}」` : ''}（${feed.source ?? 'social'}）`
        const mem = duplicate ? null : M.writeMemory(ctx.db, {
          text: memText, session: 'browse', type: 'episodic', now: ctx.now, cfg: ctx.cfg,
          affect: estimateAffect(`${top.title} ${comment ?? ''}`), importance: 0.45, tauDays: 4,
          meta: { browse: true, source: feed.source, itemId: top.id ?? null },
        })
        let shared = null
        if (!duplicate && ctx.cfg.autonomy.shareAfterBrowse && ctx.io.sendMessage && ctx.drives.get('social') >= 0.5) {
          const seed = `你刚刷到「${top.title}」${comment ? `，热评是「${comment}」` : ''}。写一句 30 字以内、像朋友分享的中文，不要像新闻播报。`
          shared = await compose(ctx, seed, () => OPENERS.share[0](top.title, comment && truncate(comment, 24)))
          await ctx.io.sendMessage(shared, { reason: 'share', itemId: top.id ?? null })
        }
        return {
          ok: true,
          text: memText,
          detail: { items: items.length, shared, memoryId: mem?.id ?? null, duplicate },
          journal: shared ? { kind: 'share', content: shared } : null,
        }
      },
    },

    {
      id: 'quiet_reflect',
      label: '内部反思',
      drive: null,
      quietHours: false,
      cooldownMin: 240,
      dailyCap: 3,
      priority: () => 0.15,
      can: (ctx) => {
        const since = ctx.brain.lastReflectAt ?? 0
        const n = ctx.db.prepare('SELECT COUNT(*) c FROM memories WHERE created_at >= ?').get(since).c
        return n >= ctx.cfg.reflection.minCluster ? true : '没有新的材料可反思'
      },
      async run(ctx) {
        const created = ctx.brain.reflect({ now: ctx.now })
        return { ok: created.length > 0, detail: { created: created.length }, journal: null }
      },
    },
  ]
}

/* ---------------- 文案与环境 ---------------- */

function pickQuote(ctx) {
  const row = ctx.db.prepare(`SELECT content FROM memories WHERE memory_type = 'episodic' AND content NOT LIKE '%刷到%'
    ORDER BY importance DESC, created_at DESC LIMIT 1`).get()
  return row ? truncate(row.content.replace(/\s+/g, ' '), 26) : null
}

function signatureMood(pad) {
  if (pad.a >= 0.45) return { key: 'excited' }
  if (pad.p >= 0.3) return { key: 'high' }
  if (pad.p <= -0.3) return { key: 'low' }
  return { key: 'mid' }
}

async function compose(ctx, seed, fallback) {
  if (ctx.io.compose) {
    const out = await ctx.io.compose({ seed, kind: 'short_text' })
    if (out && String(out).trim()) return String(out).trim()
  }
  const provider = ctx.brain.ext?.provider('composer')
  if (provider) {
    const out = await provider({ seed })
    if (out) return String(out).trim()
  }
  return fallback()
}

export function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
