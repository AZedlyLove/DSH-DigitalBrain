# agent-brain（数字大脑）

**给聊天智能体一套有状态的外部大脑：记忆、情绪、动机。**

模型的上下文窗口不是记忆。`agent-brain` 挂在模型外面，提供三样 prompt 永远给不了的东西：
它真的记得的事、会改变说话方式的情绪、以及不需要用户先开口的理由。

零第三方依赖，一个 SQLite 文件，Node ≥ 22.5（用内置 `node:sqlite`）。

[English README](README.md)

## 为什么做这个

大多数“智能体记忆”就是往 prompt 里塞向量检索：所有东西等权重地记着，永远不忘，轮与轮之间
没有任何内部状态。这里换成一个显式的小型状态机：

- **三层记忆 + 迁移**：Hot（最近 10 轮原文）→ Warm（可检索、带评分）→ Cold（摘要 + 指针，
  命中即唤醒）→ `forget_log`（只追加，不物理删除）。
- **重要性是算出来的**：三轴门控（指令性 / 情感强度 / 新颖度）过阈值才写入，灌水只进 Hot。
- **情绪是向量，不是形容词**：PAD `(愉悦, 唤醒, 支配)` 向基线回落、被回忆染色，最后翻译成
  *可操作的语调指引*，而不是“你现在很高兴”。
- **本能不被情绪取消**：“必须回应”是规则；情绪只能改变回应的形态，不能改变回不回。
- **主动行为来自动机，不靠随机数**：社交 / 好奇 / 表达三个驱力随时间上涨、被满足后回落；
  静默时段、冷却、日上限防止它变成刷屏机器人。

## 跑起来

```bash
git clone https://github.com/AZedlyLove/agent-brain.git
cd agent-brain
node examples/quickstart.mjs   # 30 秒看懂：门控、检索、情绪、prompt
npm test                       # node --test，无需装依赖
node src/demo.mjs              # 完整演示：分层迁移、唤醒、遗忘
node src/demo-autonomy.mjs     # 36 小时假时钟，看动机什么时候推进什么行为
```

```js
import { Brain } from 'agent-brain'

const brain = new Brain({ file: 'state/brain.sqlite' })

// 1) 调模型之前
const { prompt } = brain.onUserMessage({ text: '我叫小林，最近天天加班', session: 'u1' })

// 2) 回复真正发出去之后
brain.onAssistantReply({ text: '加班到几点？', session: 'u1' })

// 3) 定时（例如每 5 分钟）：衰减、迁移、反思
setInterval(() => brain.tick(), 5 * 60 * 1000)
```

`prompt` 是四段：人设 · 语调指引 · `你记得…` 记忆行 · 行为约束。把它当 system 前置上下文，用户原话照旧。

## 核心机制

| 阶段 | 机制 |
| --- | --- |
| 门控 | `importance = 0.40·指令性 + 0.35·|affect| + 0.25·新颖度`，阈值 `0.25` |
| 保留 | `R = exp(−Δt/S)·(1 + 0.45·Nr + 0.30·I + 0.25·F)`，`S = ln(1+Nr)` |
| 迁移 | Warm `R<0.40` 或 90 天未访问 → Cold；Cold 冷 ≥30 天且 `R<0.10` → `forget_log` |
| 唤醒 | Cold 被检索命中回 Warm（一轮最多 1 条），并计一次复述 |
| 联想 | 每次写入生成 2–4 条带类型边（实体共现 / 情绪同调 / 因果时序） |
| 检索 | `0.40·相关 + 0.25·重要 + 0.15·新近 + 0.10·情绪 + 0.10·联想`，取 4 条，沿边扩 1 跳 |
| 情绪 | `ΔPAD = affect·R·β`，同调命中放大 `1+γk`（上限 1.5×），两轮间按 `τ_e=45min` 回落 |
| 反思 | 每 24 轮或跨天：近期 episodic 聚类 → 一条 semantic（写 `derived_from` 边） |
| 行为 | 驱力 → 候选动作 → 静默/冷却/日上限/`can()` → 优先级 → 一次只做一个 |

所有阈值都在 [`src/config.mjs`](src/config.mjs) 一个对象里，业务代码不硬编码。

## 自主行为

驱力是 0~1 的标量，按小时上涨、被满足后回落：

| 驱力 | 初始 | 每小时 | 被谁满足 |
| --- | --- | --- | --- |
| `social` 想找人说话 | 0.15 | +0.06 | 主动聊天、分享刷到的东西、收到你的消息 |
| `curiosity` 好奇 | 0.25 | +0.09 | 刷信息流、看评论 |
| `expression` 表达欲 | 0.12 | +0.05 | 改签名、写日志 |

情绪会耦合进速率；长时间没人说话时 `social` 加速（最多 1.6×）。内置五个动作
（[`src/actions.mjs`](src/actions.mjs)）：`proactive_chat` / `post_signature` / `write_diary` /
`browse_social` / `quiet_reflect`。接入只需要实现五个 `io` 方法，
见 [`examples/integration.mjs`](examples/integration.mjs)。

## 扩展点

两层，都是运行时生效：

**事件钩子**：`turn:before`、`turn:after`、`memory:written`、`retrieve:done`、`outcome`、
`reflect`、`tick`、`action:run`。

**Provider（替换内部实现）**：`affect`（情绪识别）、`embedder`（向量化）、`promptSection`
（往 prompt 插一段）、`composer`（写主动消息）、`action`（新增自主行为）。

```js
brain.ext.on('memory:written', ({ memory }) => console.log('新记忆', memory.content))
brain.ext.register('embedder', 'bge', async (text) => myModel.embed(text))
brain.ext.register('action', 'like_post', { id: 'like_post', drive: 'expression', /* … */ })
```

## 命令行

```bash
node src/cli.mjs status            # 层级计数、PAD、驱力、上次反思
node src/cli.mjs tick              # 手动跑一次衰减 + 迁移
node src/cli.mjs reflect           # 手动跑一次反思
node src/cli.mjs recall 我那只猫叫什么   # 完整检索，并打印实际注入的 prompt
```

## 局限（有意留的接口）

- 文本启发式是中文优先（`Intl.Segmenter` 分词/实体）。换语言要改 `prompt.mjs` / `text.mjs`。
- 默认嵌入是字符 n-gram 哈希（256 维），便宜、确定，但不语义；接真实向量请注册 `embedder`。
- 情绪识别是词典 + 标点；接模型请注册 `affect`。
- 反思合成是模板句；`cfg.reflection.synthesizer` 可以交给 LLM。
- SQLite 单写者，一个进程一个 agent；多 agent 请各用各的文件。

完整数据模型、生命周期与公式见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 许可

MIT。欢迎提交 PR，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
