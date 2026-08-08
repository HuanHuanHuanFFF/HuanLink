# HuanLink SQLite Conversation Store 实施计划

> **状态：已完成（2026-08-08）。** 本计划只实施 Core 层可替换的 SQLite Conversation Store；正式 Server 接线、消息缓冲队列、Agent 触发、日志轮转和可靠投递均不在本批。代码基于独立 Prettier 基线开发，文档与代码分开提交。

## 1. 目标结果

在不改变现有 Conversation 业务语义的前提下，为 `InMemoryConversationSessionStore` 建立统一合同，并提供使用 Node.js 内建 `node:sqlite` 的持久化实现。

完成后应具备：

- In-memory 与 SQLite 实现满足同一个同步 `ConversationSessionStore` 合同；
- Channel 消息、Tool Call/Tool Result、发送回执和自身消息关联可以写入 SQLite；
- 关闭并重新打开同一数据库后，Session 时间线、去重和待回流关联仍然有效；
- schema 通过只前进的版本化 migration 建立；
- EventLog 继续使用 JSONL，运行日志继续独立保存；
- 正式 Server 入口不会仅为“证明接入”而创建空数据库。

## 2. 已确认边界

### 本计划负责

- `ConversationSessionStore` 公共合同；
- 现有 In-memory 实现对该合同的显式实现；
- `node:sqlite` Conversation Store；
- 版本化 schema migration；
- In-memory / SQLite 行为等价测试和文件重开测试；
- Core 包公开导出。

### 本计划不负责

- 把 Store 接到 `apps/server/src/main.ts`；
- 决定哪些 Channel 消息写入 Session 或触发 Agent；
- 消息聚合、队列容量、overflow、重试、claim、lease 或跨进程 Worker；
- 持久化 Agent Run、A2A Task、EventLog 或运行日志；
- ORM、全文检索、embedding、备份服务或多租户表；
- retention、checkpoint 周期、只读降级和灾难恢复产品策略；
- 修改 OneBot、Channel Adapter 或 Agent Tool 合同。

## 3. 状态所有权

SQLite Conversation Store 是下列 Conversation 事实的唯一权威来源：

- 固定 Session route 与 `contentFormat`；
- Session 有序时间线；
- `(channelId, messageId)` 消息身份和冲突检测；
- Tool Call / Tool Result 配对；
- 发送回执与平台自身消息的待关联或已关联状态。

`JsonlEventLog` 仍以 `runId + seq` 保存执行事件和 Replay；Runtime JSONL 日志仍是可轮转、可删除的诊断数据。本计划不双写同一 Channel 事实，也不宣称任务或投递能够在重启后自动恢复执行。

## 4. 技术选择

### 4.1 SQLite 驱动

使用 Node.js 24 内建的 `node:sqlite`：

- 仓库 CI 已固定 Node 24，`@types/node` 已提供声明；
- 不新增 native addon、ORM 或 lockfile 依赖；
- 当前 Store 是同步合同，`DatabaseSync` 不需要把同步语义伪装成异步；
- 数据库调用必须保持短小，事务内不得等待网络、模型或外部 Tool。

`node:sqlite` 在当前 Node 24 文档中仍为 release candidate。该风险通过 Core 内部封装和兼容测试控制；如果后续 Node 版本或稳定性证据不满足要求，再在 Store 合同后替换驱动，不把驱动类型泄漏给调用方。

### 4.2 数据文件

本批测试使用 `:memory:` 和测试临时目录。正式默认路径候选仍为 `.huanlink/data/huanlink.sqlite`，但只有后续 Session 编排接线时才由 Server 组合根创建目录、选择路径和管理关闭顺序。

现有 `.gitignore` 已忽略 `.huanlink/config/**` 以外的 `.huanlink` 运行数据，因此本批不增加反向放行规则。

### 4.3 最小 schema

| 表 | 职责 |
|---|---|
| `schema_migrations` | migration 版本、名称、checksum 和应用时间 |
| `conversation_sessions` | Session ID、固定 route、内容格式 |
| `conversation_entries` | Session 时间线顺序、条目类型和 JSON payload |
| `channel_messages` | 全局消息身份、目标 Session、对应时间线位置 |
| `outbound_deliveries` | 尚未与平台消息合并的发送关联 |
| `conversation_tool_calls` | Tool Call 唯一身份、名称和时间线位置 |
| `conversation_tool_results` | Tool Result 唯一身份及与 Tool Call 的配对关系 |

时间线排序键预留间隔，使晚到的 Tool Result 可以插入对应 Tool Call 之后，而不重写业务内容。所有 JSON 在写入前继续使用现有校验与防御性复制边界。

## 5. migration 与事务约束

- migration 按整数版本只前进；v1 建立 Session、时间线、Channel 消息和发送关联，v2 只新增 Tool Call/Result 索引表；
- migration SQL 随 TypeScript 编译进入 `dist`，不依赖遗漏的外部 `.sql` 资产；
- 每个版本保存固定 checksum；同版本内容变化必须拒绝启动；
- migration 使用事务，失败时回滚并让 Store 构造失败；
- 启用 foreign keys、WAL、`synchronous=NORMAL` 和有限 busy timeout；
- 每个公开写操作使用一个短事务；失败不得留下部分 Session、索引或关联；
- 相同消息完全一致时幂等，不一致时保留第一条并明确报错；
- Store 提供显式、可重复调用的 `close()`，但不把生命周期方法塞进业务 Store 合同。

## 6. TDD 公共验收缝隙

测试只通过 `ConversationSessionStore` 六个业务方法观察行为：

- `appendChannelMessage`；
- `recordOutboundDelivery`；
- `appendAgentToolCall`；
- `appendAgentToolResult`；
- `getSession`；
- `getSessionMetadata`。

SQLite 生命周期另通过构造、`close()`、重开同一路径观察，不依赖查询内部表来证明业务结果。

至少覆盖：

1. 首条 Channel 消息创建固定 Session；
2. Tool Result 始终紧邻对应 Tool Call；
3. 回执先到和自身消息先到都能最终关联；
4. 跨 Session 关联保留 `cross_session` 来源；
5. 完全相同消息幂等，冲突事实拒绝覆盖；
6. route 与 `contentFormat` 不可漂移；
7. 返回值是防御性副本；
8. 关闭并重开文件后仍可读取、去重和完成 pending 关联；
9. 重复打开已迁移数据库不会重复应用 migration；
10. 任一写操作失败后重新读取，不出现半写入状态。

## 7. 小批次

### B01：合同与首个持久化切片（完成）

- 提取 `ConversationSessionStore`；
- 让 In-memory 实现显式满足合同；
- 先写 SQLite 文件重开后的 Session 持久化红灯测试；
- 建立 schema v1、最小 migration 和 Channel 消息读写。

### B02：Tool 历史与回流关联（完成）

- 持久化 Tool Call/Tool Result；
- 持久化 pending outbound delivery；
- 保持先回流/后回执、先回执/后回流和跨 Session 语义；
- 复用行为合同测试。

### B03：完整验证与压力审查（完成）

- Core 定向测试、全仓 build/test/typecheck/format check；
- SQLite 文件重开、冲突回滚和 migration 幂等测试；
- 两名独立 Reviewer 交叉检查状态所有权、事务原子性和范围边界；
- 修复确认的问题后再提交代码。

## 8. 实际结果

- 提取了同步 `ConversationSessionStore` 六方法合同，In-memory 与 SQLite 实现共同通过核心行为矩阵；
- SQLite 实现使用 Node.js 24 内建 `node:sqlite`，没有新增 ORM、native addon 或 lockfile 依赖；
- schema v1/v2、连续版本检查、名称与 SHA-256 checksum 校验均已落地；bootstrap 和待执行 migration 在同一事务内完成；
- 公开写操作使用短事务，覆盖 Channel 消息、Tool Call/Result、pending outbound delivery、两种回流顺序和跨 Session 关联；
- 时间线以 1024 为常规步长，为晚到的 Tool Result 保留紧邻 Tool Call 的插入位置；
- `:memory:` 与真实临时文件均已验证；关闭重开后，Session、Tool 历史、去重和 pending 关联仍然有效；
- 两路独立压力审查最终均未发现未解决的 P0/P1/P2；审查过程中发现的 migration 空洞接受和 bootstrap 事务边界问题已经修复并补测试；
- 代码提交为 `d6b5821 feat(core): 接入 SQLite Conversation Store`；本批没有修改 Server、Channel Adapter、Agent Runtime 或 EventLog，也不会在正式进程中创建数据库文件。

### 验证记录

- `corepack pnpm format:check`：通过；
- `corepack pnpm build`：6 个 workspace 项目全部通过；
- `corepack pnpm test`：Core 223、OneBot 104、OpenAI Agents 58、A2A Client 17、Codex Adapter 143、Server 145，共 690 项通过，2 项跳过；
- `corepack pnpm typecheck`：6 个 workspace 项目全部通过；
- `git diff --check`：通过；
- 工作树未产生 SQLite、WAL/SHM 或临时测试配置文件。

## 9. 完成定义

只有同时满足以下条件，才可报告 SQLite 基础批次完成：

- 两个 Store 实现通过同一核心行为矩阵；
- SQLite 文件重开证明确实持久化，而非只通过内存缓存；
- migration、事务和冲突语义有测试证据；
- package build/test/typecheck 和根 format check 通过；
- 压力审查没有未解决的 P0/P1/P2；
- 工作树没有数据库、WAL/SHM、临时测试配置或其他运行产物；
- Server、Channel、Agent Runtime 和 EventLog 没有被越界修改。
