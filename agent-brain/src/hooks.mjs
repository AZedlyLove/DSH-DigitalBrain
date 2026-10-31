// 扩展点：所有“以后可能换/加法”的东西都从这里挂进来，核心代码不直接依赖具体实现。
//
// 两类扩展：
//   hooks     —— 在生命周期的固定位置插入副作用（记录、告警、触发别的系统）
//   providers —— 替换/补充某个能力（情绪估计、嵌入、prompt 段落、动作、文本合成）
//
// 约定：hook 抛错只记录不打断主流程；provider 由调用方给默认值，注册的覆盖默认。

export const HOOKS = [
  'turn:before',    // 用户消息进来、还没写记忆
  'turn:after',     // prompt 组好、状态已落盘
  'memory:written', // 每写一条记忆
  'retrieve:done',  // 检索完成
  'outcome',        // 上一轮行为的结果结算完
  'reflect',        // 反思产出
  'tick',           // 迁移完成
  'action:run',     // 自主行为执行完（由 autonomy 触发）
]

export const PROVIDERS = ['affect', 'embedder', 'promptSection', 'composer', 'action']

export class Extensions {
  constructor({ log = () => {} } = {}) {
    this.log = log
    this.hooks = new Map()
    this.providers = new Map()
    this.errors = []
    for (const h of HOOKS) this.hooks.set(h, [])
    for (const p of PROVIDERS) this.providers.set(p, [])
  }

  /** 注册 hook；返回取消函数 */
  on(event, fn, { name = fn.name || 'anonymous' } = {}) {
    if (!this.hooks.has(event)) this.hooks.set(event, [])
    const entry = { name, fn }
    this.hooks.get(event).push(entry)
    return () => {
      const list = this.hooks.get(event)
      const i = list.indexOf(entry)
      if (i >= 0) list.splice(i, 1)
    }
  }

  emit(event, payload) {
    const results = []
    for (const { name, fn } of this.hooks.get(event) ?? []) {
      try {
        const r = fn(payload)
        if (r !== undefined) results.push(r)
      } catch (error) {
        this.errors.push({ event, name, message: String(error?.message ?? error), at: Date.now() })
        this.log(`hook ${event}/${name} 出错：${error?.message ?? error}`)
      }
    }
    return results
  }

  /** 注册 provider：同 kind 后注册的覆盖先注册的（all 保留全部） */
  register(kind, name, impl) {
    if (!this.providers.has(kind)) this.providers.set(kind, [])
    this.providers.get(kind).push({ name, impl })
    return () => {
      const list = this.providers.get(kind)
      const i = list.findIndex((p) => p.impl === impl)
      if (i >= 0) list.splice(i, 1)
    }
  }

  /** 取最后注册的那个 provider（覆盖语义） */
  provider(kind) {
    const list = this.providers.get(kind) ?? []
    return list.length ? list[list.length - 1].impl : null
  }

  all(kind) {
    return (this.providers.get(kind) ?? []).map((p) => p.impl)
  }

  /** 逐个跑 provider，收集非空返回（promptSection / action 这种“多份并存”的用这个） */
  collect(kind, ...args) {
    const out = []
    for (const { name, impl } of this.providers.get(kind) ?? []) {
      try {
        const r = impl(...args)
        if (r !== undefined && r !== null) out.push({ name, value: r })
      } catch (error) {
        this.errors.push({ kind, name, message: String(error?.message ?? error), at: Date.now() })
        this.log(`provider ${kind}/${name} 出错：${error?.message ?? error}`)
      }
    }
    return out
  }

  list() {
    return {
      hooks: Object.fromEntries([...this.hooks.entries()].map(([k, v]) => [k, v.map((x) => x.name)])),
      providers: Object.fromEntries([...this.providers.entries()].map(([k, v]) => [k, v.map((x) => x.name)])),
      errors: this.errors.slice(-10),
    }
  }
}
