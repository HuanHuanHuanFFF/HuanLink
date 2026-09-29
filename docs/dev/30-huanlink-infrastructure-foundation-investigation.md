# 30. HuanLink 基础设施接入调查

> 调查日期：2026-08-08（Asia/Shanghai）
>
> HuanLink 基线：`dev/v1.0-infrastructure`，起点 commit `f48f0e90a0d8e5fe0dc369b9e0e9e543b774ae34`
>
> 外部快照：OpenAI Codex `rust-v0.145.0-alpha.13` / `b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce`；Claude Code `v2.1.226` / `2bb60696142b493eafaeacfe00eac51d16c50c4f`；OpenClaw `2026.8.1` / `e897bc545d747b3a6ab8c3c4baf0bee76844c417`
>
> 范围：只读调查 SQLite、消息排队、格式化、日志与迁移基础设施。本文是后续设计参考，不是实施计划，也不授权安装依赖、修改运行链路或引入外部服务。
>
> 证据标记：`[H]` HuanLink 当前事实；`[S]` 外部项目源码事实；`[D]` 官方文档声明；`[I]` 对 HuanLink 的建议或推论；`[N]` 公开资料不足，不能确认。

## 1. 结论先行

### 1.1 是否接 SQLite

**建议接，但先只服务于 HuanLink 的本地运行状态，不把所有 JSONL、日志和任务一次性搬进数据库。**

最先适合 SQLite 的对象是：

- Conversation Session 元数据和有序时间线；
- `channelId + messageId` 去重索引；
- Bot 自身消息回流与 Tool Call 的待关联状态；
- 后续 Agent Run/Task 的少量可查询状态。

当前 `JsonlEventLog` 继续承担按 run 追加、审计和 Replay 事实；普通运行日志继续是独立的脱敏日志。SQLite、EventLog、运行日志分别解决“业务运行状态”“可回放语义事件”“故障诊断”，不能互相冒充。[I]

### 1.2 是否需要消息队列

**需要消息缓冲与排队能力，但当前不需要 Redis、RabbitMQ、Kafka 等外部 Broker。**

这里必须区分三层：

| 层 | 当前是否需要 | 作用 |
|---|---:|---|
| 进程内会话队列 | 是 | 同一 Session 保序、短时间聚合多条消息、限制并发、实施背压 |
| SQLite 持久队列 | 暂不需要 | 重启后恢复未消费消息或未完成投递、claim/lease、重试预算 |
| 外部消息 Broker | 不需要 | 多进程或多主机共同消费、独立 Worker 池、水平扩展 |

当前 `ChannelRuntime` 已用两组独立的 Promise tail，分别保证同一 route 的入站转发顺序和出站执行顺序；两个方向不共享 lane。它没有容量上限、聚合窗口、溢出策略、持久化或恢复，因此只是顺序控制，不是完整消息队列。[H]

### 1.3 TypeScript 格式化怎么接

**继续使用仓库已锁定的 Prettier，不在同一批再引入 ESLint 或切换 Oxfmt。**

当前根 `package.json` 已安装 `prettier@3.8.3`，但没有配置文件、ignore、`format`/`format:check` 脚本或 CI gate。[H] 后续应把首次全量格式化作为单独的纯格式提交，避免与 SQLite 或运行时行为改动混在一个 diff 中。

### 1.4 推荐顺序

```text
格式化基础设施与独立格式基线
-> Storage 合同与 SQLite 驱动小型 Spike
-> 版本化 migration + SQLite Conversation Store
-> Channel 下游有界内存队列
-> Session / Agent Runtime 组合
-> 真实 QQ 压测与恢复边界验证
```

外部 Broker、复杂持久任务队列、分布式 exactly-once、工作流 DSL 继续排除在当前 v1 范围外。

## 2. HuanLink 当前基础设施事实

### 2.1 当前已经有什么

| 能力 | 当前实现 | 边界 |
|---|---|---|
| Channel 顺序 | `ChannelRuntime` 以 `sessionId` 分别维护入站与出站 Promise tail | 入站彼此保序、出站彼此保序；两方向不共享 lane；无容量和聚合策略 |
| Agent turn 顺序 | `AgentTurnScheduler` 以 `sessionId` 串行 fresh turn | 只协调当前进程；没有持久队列或恢复 |
| Conversation | `InMemoryConversationSessionStore` | 保存消息、Tool Call/Result 和回流关联；进程退出即丢失 |
| EventLog | `JsonlEventLog` | 每个 run 一个 append-only JSONL；同 run 写入串行，可 Replay |
| 运行日志 | Pino + 单文件 JSONL | 已脱敏、best effort；没有轮转，D11 暂定 10 MiB × 3 |
| A2A Task Store | Codex A2A Adapter 使用 SDK `InMemoryTaskStore` | 外部 Task 不跨重启恢复 |
| 配置 | `.huanlink/config/config.json` 为固定入口的一棵 JSON 配置树 | `.huanlink` 其他运行数据默认不提交 Git |
| 工程验证 | CI 运行 build、test、typecheck | 尚无 format check 或 lint gate |

关键入口：[`main.ts`](../../apps/server/src/main.ts)、[`channel-runtime.ts`](../../apps/server/src/channel-runtime.ts)、[`agent-turn-scheduler.ts`](../../packages/core/src/orchestration/agent-turn-scheduler.ts)、[`jsonl-event-log.ts`](../../packages/core/src/events/jsonl-event-log.ts)、[`jsonl-file-runtime-logger.ts`](../../packages/core/src/logging/jsonl-file-runtime-logger.ts)。

### 2.2 当前真正缺的是什么

正式 Server 入口目前把消息转发到一个只写摘要日志的统一出口，并明确记录 `message_queue_deferred`；它没有把消息接入 Session、Agent 调度或 Tool 正式注入。[H]

D11 已确认的后续链路是：

```text
Channel Runtime 统一出口
-> 消息缓冲队列
-> Session 写入、去重和自身消息关联
-> Agent 是否运行的后续策略
-> Agent Tool Call / Result
-> 平台回流写回目标 Session
```

队列必须让普通消息、mention、command 和 `isSelf=true` 回流按同 route 的实际到达顺序进入下游；Channel 层不能提前替后续模块决定是否触发 Agent。[H]

### 2.3 旧研究结论如何更新

11 号和 15 号调查是在 Conversation/Channel 事务边界尚未形成时完成的，当时建议“JSONL 为事实源、SQLite 只做派生索引”。这个判断对 **run EventLog 和 Replay** 仍有效；但现在 Session 去重、回流关联和后续可恢复状态已经形成独立的事务需求，因此 SQLite 可以成为 **Conversation 运行状态** 的权威存储。[I]

这不是把同一份数据同时交给两个权威来源：

- Run EventLog：以 `runId + seq` 表达执行事件和 Replay；
- Conversation Store：以 `sessionId`、route、消息 ID 和 timeline seq 表达会话事实；
- Runtime Log：只用于诊断，允许轮转和删除。

如果未来同一 Channel message 同时写 Conversation Store 与 EventLog，新的 Dxx 计划必须明确写入顺序、稳定 event ID 和失败修复方式，不能进行无补偿的双写。[I]

## 3. 外部项目调查

### 3.1 OpenAI Codex

Codex 的核心做法是“JSONL 正文 + SQLite 可查询状态 + 进程内队列”，而不是用数据库取代所有文件。[S]

- canonical rollout 由 recorder 追加为 JSONL；SQLite 从 rollout 回填 thread metadata 和查询状态。[`recorder.rs`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/rollout/src/recorder.rs#L80-L139)、[`codex-state`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/state/src/lib.rs#L1-L87)
- 状态、日志、目标、记忆使用不同版本的 SQLite 文件；迁移由随二进制嵌入的版本化 SQL 执行。[数据库文件常量](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/state/src/lib.rs#L100-L103)、[`migrations`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/state/src/migrations.rs#L1-L57)
- SQLite 使用 WAL、`synchronous=NORMAL`、busy timeout 和有限连接池。[`runtime.rs`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/state/src/runtime.rs#L330-L450)
- rollout writer 使用容量 256 的 Tokio channel；活动 thread 和 Agent job 调度仍主要是进程内状态，不是外部 Broker。[`recorder.rs`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/rollout/src/recorder.rs#L820-L930)、[`thread_state.rs`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/app-server/src/thread_state.rs#L286-L340)、[`agent_jobs.rs`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/codex-rs/core/src/tools/handlers/agent_jobs.rs#L27-L282)
- 主体是 Rust；根 Prettier 只覆盖文档/JSON/YAML/JS，TypeScript SDK 才独立使用 ESLint、Prettier 和 Jest。[`package.json`](https://github.com/openai/codex/blob/b7a5de8ebf2770a0e21ad32d7820a29d0f0470ce/package.json)

对 HuanLink 最有价值的不是复制多个数据库文件，而是：保留可回放记录、数据库 migration 版本化、写入队列有界、运行态与持久态分层。[I]

### 3.2 Claude Code

Claude Code 的公开资料能证明本地文件持久化，但不能证明存在 SQLite 或通用持久队列。[D][N]

- 会话 transcript 位于 `~/.claude/projects/<project>/<session>.jsonl`，包含消息、Tool Call 和 Tool Result；任务清单、计划、调试日志和文件快照使用独立目录。[官方 Application data](https://code.claude.com/docs/en/claude-directory#application-data)
- `~/.claude/sessions/` 保存运行中 Session 的小型状态文件，用于并发识别和崩溃检测；但官方公开资料没有给出通用 FIFO、ack、去重、重试或重启恢复合同，因此本次将队列语义标记为未知。[官方 Application data](https://code.claude.com/docs/en/claude-directory#application-data)
- 官方 `claude-code-action` 采用 Prettier、严格 `tsc --noEmit` 和测试的独立 CI gate；该样本没有 ESLint gate。[`package.json`](https://github.com/anthropics/claude-code-action/blob/6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975/package.json)、[`ci.yml`](https://github.com/anthropics/claude-code-action/blob/6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975/.github/workflows/ci.yml)

Claude Code 说明简单文件存储足以支撑成熟本地工具的一部分场景；但 transcript 默认明文也提醒 HuanLink：Session 持久化需要 retention、敏感内容边界和明确清理策略，不能把普通调试日志当作会话数据库。[I]

### 3.3 OpenClaw

OpenClaw 当前实现最接近 HuanLink 的多 Channel 场景，但规模也远大于 HuanLink v1。[S]

28、29 号文档固定的是更早的 OpenClaw 快照；本节固定到 `e897bc54`，上游已把更多 Session/Transcript 状态迁入 SQLite。两组事实各自只对其固定 commit 有效，后续设计不得把旧快照描述成 OpenClaw 当前实现。[S]

- 每个 Agent 有 Conversation SQLite，保存 Session、Transcript event 和全文索引；共享 SQLite 保存 task、flow、delivery 和 audit 等跨 Agent 状态。[Agent schema](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/state/openclaw-agent-schema.sql)、[shared schema](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/state/openclaw-state-schema.sql)
- 入站 Agent run 使用进程内 lane：同一 Session 串行、不同 Session 可并行；默认队列具有 debounce、cap 和 overflow 策略。[队列文档](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/docs/concepts/queue.md)
- 可靠出站另用 SQLite delivery queue，具有状态、attempt、lease/fencing、恢复 drain 和重试预算；这不是普通入站队列。[`delivery-queue-sqlite.ts`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/infra/delivery-queue-sqlite.ts)、[`delivery-queue-sqlite-claim.ts`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/infra/delivery-queue-sqlite-claim.ts#L112-L217)、[`delivery-recovery.shared.ts`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/infra/delivery-recovery.shared.ts#L227-L285)
- 运行日志是脱敏并按大小滚动的结构化文件；审计事件另存数据库，不把两者混为一类。[日志文档](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/docs/gateway/logging.md)、[shared schema](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/src/state/openclaw-state-schema.sql)
- TypeScript 使用 Oxfmt、Oxlint、严格类型检查和分 lane CI。[`.oxfmtrc.jsonc`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/.oxfmtrc.jsonc)、[`.oxlintrc.json`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/.oxlintrc.json)、[`package.json`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/package.json)、[`ci.yml`](https://github.com/openclaw/openclaw/blob/e897bc545d747b3a6ab8c3c4baf0bee76844c417/.github/workflows/ci.yml)

可借鉴的是“会话 lane + 全局并发”“入站内存队列 + 可靠出站持久队列分开”“容量和溢出策略显式化”。不应照搬多 Agent 数据库、FTS、lease/fencing、自动恢复与庞大 CI 矩阵。[I]

### 3.4 对比矩阵

| 项目 | 会话正文 | SQLite 角色 | 运行队列 | 外部 Broker | 格式化 |
|---|---|---|---|---|---|
| HuanLink 当前 | 进程内 Conversation；run EventLog 为 JSONL | 尚未接入 | 入站/出站各自使用 Promise tail | 无 | 已安装 Prettier，未接线 |
| Codex | rollout JSONL | metadata、日志、目标、记忆、可重建查询状态 | 有界 Tokio channel + 内存调度 | 本地链路未使用 | Rustfmt；非 Rust 文件 Prettier |
| Claude Code | Session JSONL 与独立文件目录 | 未从官方资料确认 | 未从公开稳定合同确认 | 未确认 | 官方 Action 使用 Prettier |
| OpenClaw | Agent SQLite transcript event | Conversation、task、delivery、audit、索引 | Session lane + 有界策略 | 单机路径未使用 | Oxfmt + Oxlint |

共同规律：[I]

1. 本地优先不等于“所有内容都塞进一个数据库”。
2. 保序和限制并发通常先由进程内队列完成。
3. 持久队列只在明确需要恢复、claim、重试和投递状态时出现。
4. 运行日志、会话历史和任务状态属于不同生命周期。
5. Formatter、typecheck、test 应是可单独定位失败原因的验证 gate。

## 4. SQLite 接入建议

### 4.1 第一阶段职责

建议新增协议无关的 `ConversationSessionStore` 接口，由现有 In-memory 实现和后续 SQLite 实现共同满足；SQLite 驱动不得泄漏到 Channel 合同或 OneBot Adapter。[I]

最小 schema 候选：

| 表 | 最小职责 |
|---|---|
| `schema_migrations` | 已执行 migration、校验和、执行时间 |
| `conversation_sessions` | `session_id`、kind、固定 route、content format、时间戳 |
| `conversation_entries` | Session 内单调 seq、entry type、结构化 JSON payload |
| `channel_messages` | 唯一 `(channel_id, message_id)`、目标 Session、事实 hash/定位 |
| `outbound_deliveries` | 回执、来源 Session、run/toolCall、回流关联状态 |

第一阶段不建：通用任务 DAG、审批状态机、全文检索、embedding、跨进程 lease、死信队列或多租户表。

### 4.2 数据文件与配置

推荐默认数据库位于固定运行目录：

```text
.huanlink/data/huanlink.sqlite
```

配置树最多保存相对项目根目录的数据路径，不把绝对路径写回仓库。数据库、`-wal`、`-shm`、备份和临时文件都必须保持 Git ignore。[I]

### 4.3 驱动选择

HuanLink CI 已固定 Node 24。官方 [`node:sqlite`](https://nodejs.org/download/release/v24.18.1/docs/api/sqlite.html) 不需要额外原生依赖，并提供 prepared statement、transaction、backup 等能力；但在本次固定审计版本 Node.js 24.18.1 的文档中仍标记为 Stability 1.2（Release candidate）。[D]

因此后续 Dxx 不应直接凭偏好选包，而应做一个很小的驱动 Spike：

| 候选 | 优点 | 风险 |
|---|---|---|
| `node:sqlite` | Node 24 内建、安装简单、减少 Windows 原生依赖问题 | API 仍为 RC；同步调用会占用事件循环 |
| `better-sqlite3` | 成熟、事务 API 简单、生态与 Kysely 经验多 | 原生 addon、Node/平台预编译与安装链更复杂；同样同步 |

当前 schema 很小，不建议第一批再叠加 ORM。可以使用受封装的 prepared SQL + 独立 migration 文件；若后续查询和表关系明显增长，再评估 Kysely。[I]

### 4.4 SQLite 运行约束

后续实现至少要验证：

- migration 只前进，失败不部分应用；
- `PRAGMA foreign_keys = ON`；
- WAL、busy timeout、checkpoint 和备份策略明确；
- 写入事务短小，不在事务中等待网络或模型；
- 同一进程收敛到一个写入所有者；
- 冲突消息保留第一条事实并留下脱敏错误，不能静默覆盖；
- 数据库损坏、锁超时、磁盘满和 migration 失败都有明确启动/降级行为。

SQLite 官方说明 WAL 允许读写更好地并行，但仍可能返回 `SQLITE_BUSY`，WAL 文件也必须和主数据库一起管理；它不是“开启 WAL 后就无需处理锁和 checkpoint”。[D] [SQLite WAL](https://www.sqlite.org/wal.html)

## 5. 消息队列建议

### 5.1 HuanLink 当前需要的队列

建议把新组件命名为 `ConversationIngressQueue` 或 `ChannelMessageBuffer`，避免让人误以为已引入外部 Broker。[I]

它位于 Channel Runtime 统一出口之后，职责仅包括：

- 以完整 Session route 作为 lane key；
- 保留普通消息和 `isSelf` 消息的真实到达顺序；
- 可配置短暂聚合窗口，把连续消息交给一个后续 Agent turn；
- 同 Session 至多一个消费任务，不同 Session 受全局并发上限控制；
- 有明确的 per-session cap、global cap 和 shutdown drain 行为；
- 产生 queue depth、等待时间、overflow 等脱敏指标。

它不负责：

- 决定 mention/command 是否触发 Agent；
- 自动发送 Channel 回复；
- 猜测 `isSelf` 是否应进入模型上下文；
- 自动重试具有外部副作用的 Tool；
- 承诺跨重启恢复或 exactly-once。

### 5.2 为什么不能只依赖现有 Promise tail

现有 tail 在下游很慢时会无限积累 Promise，且看不到深度、年龄或溢出；它也无法把短时间连续消息聚合为一次唤醒。新队列需要显式数据结构和状态，而不是再增加一层不可观测的 Promise 链。[H][I]

ChannelRuntime 的现有 tail 仍可保留为 Adapter 边界的顺序保护；下游 handler 应快速完成入队，真正的缓冲、批处理与 Agent 并发由新队列负责。[I]

### 5.3 何时升级成 SQLite 持久队列

只有确认以下产品语义之一后才升级：

- 服务重启后仍必须处理已接收但未消费的消息；
- 后台 Agent Task 必须恢复；
- 出站必须记录 intent、attempt、确认、不确定与失败，并按规则恢复；
- 多个 Worker 需要 claim 同一任务且避免重复处理。

即使升级，也应把入站缓冲、Agent Task 和可靠出站分成不同 queue/status 语义，不能只建一张 `messages(status)` 表解决所有问题。[I]

### 5.4 何时才需要外部 Broker

满足以下条件前不评估外部 Broker：

- Server 与 Worker 已拆成独立进程或主机；
- 多消费者必须共享任务并做故障转移；
- SQLite 单写者已经通过实际指标成为瓶颈；
- 需要跨机管理 lease、ack、重试、延迟投递和死信；
- 能接受部署、认证、备份和故障定位成本。

HuanLink 当前是本地单用户、单 Server 组合根，不满足这些条件。[H]

## 6. TypeScript 格式化与代码质量建议

### 6.1 最小接入

后续格式化批次建议只完成：

1. 根 `prettier.config.mjs`；
2. 根 `.prettierignore`；
3. `format` 与 `format:check` 脚本；
4. CI 增加只读 `format:check`；
5. 单独执行一次受控的格式基线提交。

Prettier 官方建议锁定本地版本、提供配置和 ignore，并在 CI 运行 `prettier --check`；当前仓库已经满足“本地精确版本”这一项。[D] [Prettier 安装与 CI](https://prettier.io/docs/install.html)

### 6.2 控制首次 diff

首次格式化不应和 SQLite、Queue 或业务修复同 commit。建议先只纳入：

- `apps/**/*.ts`；
- `packages/**/*.ts`；
- 根与 workspace 的 JSON/TS 配置；
- `.github/**/*.yml`。

`docs/dev/**`、`references/**`、运行数据、生成物和本地配置样例是否纳入应单独确认。大型 Markdown 调查文档不必因为接入 TypeScript formatter 同时产生全量改写。[I]

### 6.3 Formatter 不等于 Linter

Prettier 解决稳定排版；`tsc` 解决类型；Vitest 保护行为；ESLint/Oxlint 解决可静态发现的代码规则。当前没有证据表明 HuanLink 必须在同一批增加 Linter。[I]

推荐先观察格式基线与 CI 成本，再单独评估：

- 未处理 Promise；
- 无用导入/变量；
- import 边界；
- Node 安全和测试规则。

不因为 OpenClaw 使用 Oxfmt/Oxlint 就切换现有 Prettier；OpenClaw 的规模和 CI 拓扑不是 HuanLink 当前需求。

## 7. 相邻基础设施

### 7.1 日志轮转

D11 已记录 `server.jsonl` 当前为单文件追加，并暂定单文件 10 MiB、保留最近 3 份。SQLite 接入不能替代日志轮转；建议在基础设施模块中保留独立小批次，但不与数据库首次迁移同批实现。[H][I]

### 7.2 备份与清理

SQLite 首批至少需要：

- migration 前的可恢复备份；
- 数据文件、WAL/SHM 的一致管理；
- 受测的关闭与 flush；
- Session retention 的配置入口或明确“暂不自动清理”；
- 不在普通日志输出消息正文、Tool 参数和数据库行。

### 7.3 可观测性

先增加低基数指标/日志字段即可：

- queue depth 与 oldest age；
- 每 Session 等待时间；
- SQLite transaction duration、busy/locked 次数；
- migration version；
- overflow、association conflict 与恢复结果。

不需要为了这些指标先接外部监控平台。

## 8. 后续设计门禁

本文之后应先编写并确认独立 `Dxx` 实施计划，再写代码。至少需要用户确认：

1. SQLite 第一批究竟持久化 Conversation，还是只做驱动 Spike；
2. `node:sqlite` 与 `better-sqlite3` 的选择；
3. EventLog 与 Conversation Store 出现同一消息时的写入和修复语义；
4. 队列聚合窗口、per-session/global cap 与 overflow 行为；
5. 是否承诺任何重启恢复；
6. 首次 Prettier 格式化的文件范围；
7. 日志轮转是否与本模块一起排期。

建议分批：

| 批次 | 只做什么 | 不做什么 |
|---|---|---|
| 第 1 批 | Prettier 配置、脚本、CI 与格式基线 | 不改运行行为 |
| 第 2 批 | Storage 接口、SQLite 驱动 Spike、migration 骨架 | 不接 Agent，不迁移全部状态 |
| 第 3 批 | SQLite Conversation Store 与现有 In-memory 合同测试 | 不实现持久任务队列 |
| 第 4 批 | Channel 下游有界内存队列与压力测试 | 不自动回复，不改 Agent 触发策略 |
| 第 5 批 | Session/Agent Runtime 组合和真实 QQ 验证 | 不引入外部 Broker |
| 第 6 批 | 日志轮转与数据维护 | 不把运行日志迁进业务数据库 |

批次名只是本调查的讨论占位，不具有当前 `Dxx` 计划的实施授权。

## 9. 最终判断

- **SQLite：接。** 用于本地 Conversation/关联状态和后续可查询运行状态；保留 EventLog/日志分层。
- **消息队列：接轻量进程内队列。** 显式有界、按 Session 保序、支持短暂聚合与背压；暂不做持久队列。
- **外部 Broker：不接。** 当前没有多进程、多主机或水平扩展证据。
- **TypeScript 格式化：接 Prettier。** 已有依赖，只补配置、脚本、CI 与独立基线；Linter 另批评估。
- **ORM：首批不接。** 先用封装后的 prepared SQL 和版本化 migration；复杂查询出现后再评估 Kysely。
- **日志轮转：需要，但独立批次。** 不让数据库接入掩盖现有单文件日志增长问题。

这套顺序能够先解决 HuanLink 已经真实出现的 Session、回流、排队和 diff 可维护性问题，同时继续遵守 v1 的本地单用户、单进程和渐进式开发边界。
