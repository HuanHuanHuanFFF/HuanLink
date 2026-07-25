# 28. OpenClaw Channel、状态与附件调查

> 调查日期：2026-07-26
>
> OpenClaw 快照：`e3a6da0f518136a4277373afdf4b7f894c9e092f`（本地 shallow clone、detached HEAD）
>
> 范围：只读源码调查。本文不构成实现计划，也不证明 HuanLink 的未接入能力。
> 证据标记：`[S]` 源码事实；`[D]` 文档/计划声明；`[I]` 基于证据的建议；`[T]` 本次未执行测试，不把测试文件当作运行证明。

## 1. 核心结论

1. OpenClaw 的通用 Channel 层是“插件合同 + 通用入站/回复管线”；平台 Adapter 负责协议、账号连接、平台资源与平台展示能力，并不只是无状态 Codec。[S]
2. 聊天历史的业务事实主要落在 Agent session：`sessions.json` 保存 session 索引/路由元数据，session transcript 是逐行 JSONL；Channel 不另建一份通用聊天消息库。[S]
3. OpenClaw 已为“原路回复”持久化 route、delivery context 和 pending final delivery；还存在 SQLite 队列与任务状态，但这不等于所有在途 Agent 工作都能自动恢复。[S]
4. 附件通常经历“平台标识或私有 URL -> Adapter 下载/刷新 -> 统一本地 media store -> Agent 本地路径”的路线，默认复制短期文件；这是服务其本地 Agent/Sandbox 集成的选择，而非跨平台 Channel 的唯一边界。[S][I]
5. HuanLink 当前 B04 的 `publicUrl | channelResource`、无附件复制、无数据库依然合理，但只能承诺“当前进程和资源有效期内可访问”，不能声称重启后的附件、在途 A2A 任务或原路回复恢复。[D][I]

## 2. OpenClaw Channel 通用架构

```text
Gateway Server
  -> 按 channelId + accountId 启动 Plugin.gateway.startAccount()
  -> 平台 Adapter 接收 webhook / socket / SDK 事件
  -> 平台解析、去重、allowlist / mention / command 判断
  -> buildChannelInboundEventContext / runChannelInboundEvent
  -> recordInboundSession(sessionKey, route, delivery context)
  -> dispatchReplyFromConfig
  -> Agent runtime / tool loop
  -> reply pipeline
  -> Adapter 平台发送、typing、draft streaming、reaction、edit 等
```

### 2.1 模块边界

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| Channel Plugin 合同 | capabilities、配置、账号、gateway、messaging、threading、actions 等扩展点 | 不规定每个平台的资源字段和协议细节 |
| Gateway Server Runtime | 启动/停止每个账号、状态、AbortSignal、重启管理 | 不解析 Telegram/Slack/飞书协议 |
| Adapter / Transport | socket/webhook、认证、事件解析、附件下载、平台发送、typing/edit/reaction | 不拥有通用 Agent transcript |
| Channel Core pipeline | 入站标准化、session record、reply dispatch、通用 outbound 处理 | 不拥有平台 API token 或平台资源语义 |
| Agent session | 历史 transcript、模型/session 配置、route、投递上下文 | 不维护平台连接 |
| Plugin runtime state | buffer、reply fence、去重缓存、SDK client、连接状态 | 不应成为跨重启的唯一业务事实 |

`ChannelPlugin` 按可选 adapter 分面组织，包含 messaging、threading、streaming、actions、approval、gateway 等能力；它并不要求每个平台实现一张巨型接口。[S] `references/openclaw/src/channels/plugins/types.plugin.ts:66-111`

Gateway 会以 `channelId + accountId` 启动账号实例，并向插件传递账号配置、AbortSignal、状态读写器和可选 Channel Runtime。[S] `references/openclaw/src/gateway/server-channels.ts:520-663`

### 2.2 多平台、多账号、群聊、私聊和 thread

- 公共 session key 以 `agent:<agentId>:` 为前缀。[S] `references/openclaw/src/routing/session-key.ts:91-107`
- 群/频道默认 key 为 `agent:<agent>:<channel>:<group|channel>:<peer>`；私聊的隔离粒度由 `dmScope` 决定，可退化为 main、也可按 peer/channel/account 分开。[S] `references/openclaw/src/routing/session-key.ts:151-217`
- thread 可以附加 `:thread:<id>`；平台若有 topic 或 scoped conversation 等特殊规则，可由 plugin 自己定义 session conversation grammar。[S] `references/openclaw/src/routing/session-key.ts:258-279`；`references/openclaw/src/channels/plugins/types.core.ts:518-549`
- outbound route 会保留 `sessionKey`、peer kind/id、chat type、`from/to/threadId`。[S] `references/openclaw/src/channels/plugins/types.core.ts:385-396`

### 2.3 平台专属操作

Capability 包含 `reactions/edit/unsend/reply/threads/media/blockStreaming` 等声明。[S] `references/openclaw/src/channels/plugins/types.core.ts:303-319`

具体 action 则通过 `ChannelMessageActionAdapter` 的 `supportsAction`、`prepareSendPayload` 与 `handleAction` 暴露；Adapter 可决定本地执行还是 gateway 执行。[S] `references/openclaw/src/channels/plugins/types.core.ts:725-769`

因此 edit、reaction、typing、streaming 不是 Core 的“通用消息表字段”，而是“统一能力声明 + Adapter 实现”的组合。Telegram 的 draft streaming、typing 和 tool progress 即在 Adapter reply pipeline 外围完成。[S] `references/openclaw/extensions/telegram/src/bot-message-dispatch.ts:927-950`

## 3. 入站、Agent、异步回流和出站

### 3.1 入站到 Agent

Plugin SDK 导出 `buildChannelInboundEventContext`、debounce、mention gating、`runChannelInboundEvent` 等通用入口。[S] `references/openclaw/src/plugin-sdk/channel-inbound.ts:1-205`

`runChannelInboundEvent` 的共享链路负责先记录 session，再调度 reply；Telegram 调用时将自己的 `ingest`、`resolveTurn` 和平台 `deliver` 注入进去。[S] `references/openclaw/src/channels/message/inbound-reply-dispatch.ts:84-111`；`references/openclaw/extensions/telegram/src/bot-message-dispatch.ts:1881-1910`

这说明 Channel 将“平台消息”送进 session/Agent runtime，但它不是聊天记录的唯一所有者。

### 3.2 异步任务与结果回流

OpenClaw 有多种不同的“异步”机制，不能混为一个通用 A2A 恢复承诺：

| 场景 | 关联信息 | 是否持久化 | 重启语义 |
|---|---|---|---|
| 主 session 最终回复 | `route`、`deliveryContext`、`pendingFinalDeliveryText` | `sessions.json` | 有针对性的待发送最终回复恢复 |
| OpenClaw subagent | requester/child session key、run 状态、结果 | `state/subagents/runs.json` | 有扫描 interrupted session 并 synthetic resume 的实现 |
| managed task / task flow | task/flow、requester origin、delivery state | `state/openclaw.sqlite` | 可重载记录；具体恢复取决于 task runtime |
| 实时 Agent event / approval waiter | run context、listener、pending approval | 内存 Map/Set | 进程重启丢失 |

`SessionEntry` 保存 `route`、`deliveryContext`、`lastChannel`、`lastTo`、`lastAccountId`、`lastThreadId`，也保存 pending final delivery 与 restart recovery 字段。[S] `references/openclaw/src/config/sessions/types.ts:204-403`

主 Agent 在真正发送前持久化 pending final delivery 文本与 delivery context，成功后清除。这是专门实现的投递恢复能力，而非仅有 sessionId 就自然拥有的能力。[S] `references/openclaw/src/agents/agent-command.ts:846-907`；`references/openclaw/src/agents/agent-command.ts:2079-2218`

subagent registry 是 JSON 文件；gateway restart 后会扫描 `abortedLastRun` 的 active run，并用 synthetic resume message 重新发起子 Agent turn。[S] `references/openclaw/src/agents/subagent-registry.store.ts:1-218`；`references/openclaw/src/agents/subagent-orphan-recovery.ts:1-250`

本次未从 Channel 主链路确认一个“通用远端 A2A Agent 完成后由远端自行决定 Channel 路由”的实现。已有源码反而表明 route/delivery context 是 OpenClaw 本地 session/task 状态；远端执行方不应拥有 Channel 路由权。[S]

## 4. 消息、会话与状态所有权

### 4.1 Session 与 transcript

- 每个 Agent 的 session store 位于 `agents/<agent>/sessions/sessions.json`。[S] `references/openclaw/src/config/sessions/paths.ts:16-37`
- session transcript 是同目录下的 `<sessionId>.jsonl`，每条追加为一行 JSON；session 文件本身按 `0600` 权限创建。[S] `references/openclaw/src/config/sessions/transcript.ts:25-42`；`references/openclaw/src/config/sessions/transcript-jsonl.ts:1-57`
- transcript append 有进程内 per-file queue，另有跨进程 session write lock。[S] `references/openclaw/src/config/sessions/transcript-append.ts:151-184`
- `sessions.json` 的更新使用独占写和原子替换。[S] `references/openclaw/src/config/sessions/store.ts:886-1030`

因此，OpenClaw 的 Channel Adapter 不是“聊天历史事实来源”。它会有短期缓冲、去重、连接、draft、fence 等状态，但可重放对话历史归属于 session transcript。

### 4.2 运行态并不等于无状态

Adapter 不是完全无状态：Telegram 有 media/text buffer 与 reply fence；Slack 有内存 hot dedupe；Gateway 为账号保留 task、abort signal 和 reconnect 状态。它们用于实时处理，而非替代 session/task 的持久事实。[S] `references/openclaw/extensions/telegram/src/bot-handlers.runtime.ts:1870-2090`；`references/openclaw/extensions/slack/src/monitor/inbound-delivery-state.ts:1-137`；`references/openclaw/src/gateway/server-channels.ts:520-663`

## 5. 持久化矩阵

| 数据 | 实际形态 | 业务意义 |
|---|---|---|
| Channel/账号配置 | `~/.openclaw/openclaw.json` | 配置事实；启动时解析账号 |
| 凭据 | state/credentials 等文件目录 | 凭据存储，不进入通用消息合同 |
| session 索引、route、delivery context | 每 Agent `sessions.json` | session 与回复路由状态 |
| 聊天/Agent transcript | `agents/<agent>/sessions/<session>.jsonl` | 对话历史、tail 和导出来源 |
| 插件去重 | SQLite plugin state + 内存热缓存 | 例如 Slack 入站 24h 去重 |
| 通用持久任务/flow | `state/openclaw.sqlite` | task、requester origin、delivery state、flow 状态 |
| 持久投递队列 | `state/openclaw.sqlite` | pending/failed delivery queue |
| subagent registry | `state/subagents/runs.json` | 内部 subagent 运行关联 |
| exec approval | `Map` + timer | 仅进程内 pending/resolved grace period |
| Agent event stream | `Map` / listeners | UI/运行时观察，不是持久 EventLog |
| 运行日志 | 滚动 `.log` 文件 | 诊断日志，不是业务事实来源 |
| 附件内容 | 短期本地 media store | 临时消费，不是长期归档 |

关键证据：

- state SQLite 真实位置为 `<state>/state/openclaw.sqlite`。[S] `references/openclaw/src/state/openclaw-state-db.paths.ts:25-29`
- Slack 的入站去重默认 TTL 为 24 小时，并写入 plugin state；该 state 由 shared SQLite 读写。[S] `references/openclaw/extensions/slack/src/monitor/inbound-delivery-state.ts:5-137`；`references/openclaw/src/plugin-state/plugin-state-store.sqlite.ts:1-180`
- delivery queue row 显式保存 `sessionKey/channel/target/accountId/retryCount`，并从 SQLite 加载 pending/failed 条目。[S] `references/openclaw/src/infra/delivery-queue-sqlite.ts:1-220`
- task registry 将 task、requester session、origin、状态和 delivery state 存在 SQLite。[S] `references/openclaw/src/tasks/task-registry.store.sqlite.ts:1-180`
- 通用 exec approval manager 只有 `private pending = new Map`；本次未发现对应持久化实现。[S] `references/openclaw/src/gateway/exec-approval-manager.ts:42-240`
- Agent event bus 也是全局 singleton 的 Map/Set，不能被当作可 replay 的 EventLog。[S] `references/openclaw/src/infra/agent-events.ts:147-355`
- 默认运行日志是滚动本地 `.log`，与 session JSONL/SQLite 分开。[S] `references/openclaw/src/logging/log-file-path.ts:1-45`

## 6. 附件处理

| 平台 | 初始标识 | Adapter 处理 | Agent 最终看到 | 安全/时效 |
|---|---|---|---|---|
| Telegram | `file_id`，再取 `file_path` | 用 Bot API token 下载，`saveRemoteMedia` 写入 store | 本地 `path` + MIME | 字节上限、重试、SSRF policy；token 不交给 Agent |
| Slack | `url_private(_download)`、`file.id` | 私有 URL 可刷新，带授权下载后暂存 | 本地 `path` + MIME | Slack 域 allowlist、SSRF、idle/总超时 |
| 飞书 | `image_key` 或 `message_id + file_key` | 调平台 API 读取 buffer，保存 media store | 本地 `path` + MIME | Adapter 保留平台凭据；资源键由 Adapter 解释 |
| Discord | CDN attachment URL | 优先下载并暂存；失败时可退回 URL | 通常路径，失败可为 URL | CDN allowlist、SSRF policy、大小限制 |

### 6.1 通用 media store

media store 默认最大 5MB、TTL 2 分钟，路径和 mediaId 做 traversal 防护，读取也有字节边界。它是短期 staging cache，而非附件归档。[S] `references/openclaw/src/media/store.ts:26-33`；`references/openclaw/src/media/store.ts:49-95`；`references/openclaw/src/media/store.ts:520-597`

### 6.2 各平台链路

- Telegram：`file_id -> getFile.file_path -> Bot API URL -> saveRemoteMedia -> local path`。[S] `references/openclaw/extensions/telegram/src/bot/delivery.resolve-media.ts:194-320`
- Telegram 的单附件和 media group 分支会先判断未 @ 的群消息是否跳过，再执行 `resolveMedia` 下载。[S] `references/openclaw/extensions/telegram/src/bot-handlers.runtime.ts:850-1030`；`references/openclaw/extensions/telegram/src/bot-handlers.runtime.ts:1950-2025`
- Slack：私有 URL 可通过 `files.info(file.id)` 刷新；下载带授权头并调用 `saveRemoteMedia`。[S] `references/openclaw/extensions/slack/src/monitor/media.ts:281-353`；`references/openclaw/extensions/slack/src/monitor/media.ts:404-459`
- 飞书：解析 `image_key/file_key`，使用 `messageId + fileKey` 由平台 API 拉取，保存为本地 media。[S] `references/openclaw/extensions/feishu/src/bot-content.ts:305-487`
- Discord：下载失败时允许退回原 attachment URL，因此 OpenClaw 也并非所有分支只传本地文件。[S] `references/openclaw/extensions/discord/src/monitor/message-media.ts:298-348`

Slack、飞书是否在每一种附件分支中都严格于 allowlist/mention gate 后下载，本次未追完所有事件分支，不能从 Telegram 的顺序外推。[未确认]

出站附件与入站附件并非同一套统一抽象：Core 提供 capability/action/reply pipeline，具体上传、链接发送、平台媒体格式仍由 Adapter 决定。[S] `references/openclaw/src/channels/plugins/types.core.ts:725-769`

## 7. 对 HuanLink 当前疑问的建议

| 问题 | 建议 | 证据与边界 |
|---|---|---|
| Channel 是否持久化聊天消息？ | P0 不必复制一份 Channel 聊天消息库。 | [I] OpenClaw 将 transcript 放进 Agent session，而非 Channel Core；若 HuanLink 日后要独立 replay/eval，再记录最小标准化 EventLog。 |
| Agent/session 能否独立拥有历史？ | 可以，且建议如此。Core 保留 conversation route，不成为模型历史唯一拥有者。 | [S] OpenClaw 将 transcript、sessionId、模型配置和 route 放入 session state。 |
| 只持久化 taskId/externalTaskId/sessionId/route 是否足够？ | 对仅当前进程 Demo 足够；对重启后完成回流不够。还需状态、时间、目标 Agent、完整 route、delivery status、结果或可重新拉取结果的定位信息。 | [S] OpenClaw task/delivery row 还保存 status、origin 与重试信息。 |
| `publicUrl | channelResource` + `route.channelId + resourceId -> openAttachment` 是否合理？ | 合理，应保持。 | [I] 比将 token、私有 URL、绝对路径塞入 Core 更清晰；这是 HuanLink 的轻量边界，不是 OpenClaw 的直接实现。 |
| `resourceId` 应如何存在？ | 选可序列化、Adapter 定义、Core 不解析的 opaque handle；允许单 ID 或复合 key。 | [I] Telegram `file_id`、Slack `file.id`、飞书 `message_id + file_key` 都可由 Adapter 重新解释。纯内存登记 ID 会锁死重启能力。 |
| B04 是否无 DB、无附件复制？ | 当前 Demo 保持。 | [D][I] D11 已明确无持久附件复制；OpenClaw 的复制是为本地路径、视觉/音频处理和 sandbox，HuanLink 不需预先照搬。仍必须提供 `maxBytes + timeout + AbortSignal + stable errors`。 |
| 何时真正需要 SQLite/数据库和恢复？ | 当任务跨进程、需要可靠重试/取消/去重、审批审计、多个 Channel/账号，或承诺完成结果原路送达时。 | [S] OpenClaw 的 SQLite 用于 plugin state、task/flow 与 delivery queue，而非“有 Channel 就先建 DB”。 |

### 7.1 HuanLink 当前状态对照

- 当前 QQ Runtime 的 route、上下文和 egress 串行尾链是内存状态；关闭时 abort active controller，不提供重启恢复。[S] `apps/server/src/phase4-qq-runtime.ts:53-189`；`apps/server/src/phase4-qq-runtime.ts:192-228`
- Codex A2A Adapter 使用 SDK `InMemoryTaskStore`，外部 task 不跨重启存在。[S] `apps/codex-a2a-adapter/src/server.ts:51-55`
- D11 对 `publicUrl | channelResource`、`openAttachment`、不持久化附件的描述是设计计划，不应写成已接入运行能力。[D] `docs/dev/D11-channel-contract-v1-implementation-plan.md:1-280`

## 8. 未确认事项

1. OpenClaw 每一种 Channel 的所有附件分支是否都在 allowlist/mention gate 后下载。
2. OpenClaw 是否存在独立于 subagent/task-flow 的、完整通用 A2A 远端任务恢复链路；本次 Channel 主链路未确认。
3. 哪些具体 Channel 已将最终发送实际接入 SQLite delivery queue；基础设施存在，不可据此宣称所有平台发送均持久重试。
4. 插件 approval 是否存在插件自定义持久化实现；通用 exec approval manager 本身明确是内存态。
