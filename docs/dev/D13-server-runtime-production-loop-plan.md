# HuanLink Server Runtime 正式闭环实施计划

> **状态：已确认（2026-08-09）。** 本计划用于激活
> [`31-huanlink-autumn-recruiting-value-first-candidate-roadmap.md`](./31-huanlink-autumn-recruiting-value-first-candidate-roadmap.md)
> 中的 P0 与相邻 P0.5。本文完成不代表代码、正式入口或真实 QQ 闭环已经完成。

## 1. 目标结果

在不改变 Channel 已确认职责的前提下，把当前分散存在的 Conversation Store、MainAgent、AgentCall、A2A、Codex Adapter 和当前会话 `reply` 组合进正式 Server 入口，恢复一条当前架构下可运行、可验证的最小闭环：

```text
真实 QQ / OneBot
-> Channel Adapter
-> Channel Runtime
-> SessionIngressCoordinator
-> ConversationSessionStore
-> MainAgent
-> AgentCall
-> 标准 A2A
-> Codex A2A Adapter
-> codex app-server
-> Artifact / 终态
-> MainAgent re-entry
-> 显式 reply
-> 原 QQ 会话
-> 平台自身消息回流并关联 Session
```

P0 完成后应证明当前正式入口能够处理一次真实请求，而不是只证明各局部组件存在。P0.5 紧随 P0 完成 SQLite 生产接线，但不把 Conversation 持久化扩大为 Agent Run、A2A Task 或出站投递的自动恢复。

## 2. 文档关系与当前事实

- 本计划经确认后，是 Server Runtime 正式闭环模块的当前 `Dxx`；其活动 `Bxx` 高于普通编号候选路线和历史阶段计划。
- [`D11-channel-contract-v1-implementation-plan.md`](./D11-channel-contract-v1-implementation-plan.md) 已完成 Channel Contract、OneBot Adapter、Channel Runtime、名单热重载和正式 Channel-only 入口；Channel 不写 Session、不去重、不决定 Agent 触发。
- [`D12-sqlite-conversation-store-implementation-plan.md`](./D12-sqlite-conversation-store-implementation-plan.md) 已完成 Core `ConversationSessionStore`、In-memory/SQLite 实现、migration、事务和文件重开测试；正式 Server 尚未创建或关闭 SQLite Store。
- `apps/server/src/main.ts` 当前只记录统一下游事件，并明确记录 `message_queue_deferred`；正式入口没有创建 Phase3 Runtime 或 Conversation Store。
- `apps/server/src/phase3-runtime.ts` 已组合 MainAgent、AgentCall、A2A Transport、状态查询、`input-required` 续跑和终态 re-entry，但没有连接正式 Channel 入口。
- `reply`、`onebot_standard` 和开关控制的 `onebot_privileged` 已是经过测试的可组合 Tool；其中 Store 依赖仍使用 In-memory 具体类型。
- 当前没有 Session 上下文投影器；`OpenAiAgentsRuntime` 只接收一次文本输入，不能把“Store 中存在历史”写成“模型已经获得历史”。
- 当前 Conversation Store 记录 Channel 消息以及部分 Channel Tool Call/Result，但尚未统一记录 MainAgent 的 `submit`、`status` 和 `continue` Tool 历史。
- 当前 Codex Adapter 的 JSON loader 已存在，但该进程的 `main.ts` 仍使用遗留环境变量和硬编码分支边界。本计划不把完整多项目 Adapter 配置迁移隐式塞入 Server Runtime；真实 smoke 必须显式使用受控工作区，若现有 Adapter 入口阻塞验收，应停下建立独立 Adapter 计划。

## 3. 已确认的产品与运行语义

### 3.1 Channel 与下游边界

- Channel Adapter 负责协议接入；Channel Runtime 负责 Adapter 注册、名单、能力检查、同 route 保序、生命周期和事件转发。
- 所有通过 Channel 名单的普通消息、`mention`、`command` 和 Bot 自身消息都进入统一下游；Channel 不根据 trigger 或 `sender.isSelf` 丢弃。
- `SessionIngressCoordinator` 是本计划新增的唯一 Session 入站编排入口。它负责 Store 写入、重复判断、自身消息关联、当前触发策略和 MainAgent 调度，不把这些职责塞回 `ChannelRuntime`。
- Session ID 继续由完整 route 稳定生成；`channelId` 只表示 Channel 实例，群聊/私聊位置由完整 route 表达。

### 3.2 当前触发策略与未来门禁边界

P0 不实现消息聚合队列，也不实现门禁 Agent。当前策略为：

1. 先调用 `appendChannelMessage`；
2. `duplicate` 或 `associated` 不启动 MainAgent；
3. `sender.isSelf === true` 只写入或完成关联，不启动 MainAgent；
4. 非自身 `mention | command` 在成功 `appended` 后立即启动 MainAgent；
5. 其他普通消息只写入 Session，不启动 fresh turn。

`SessionIngressCoordinator` 必须保留一个可替换的下游调度边界，使未来能够在不修改 Channel 和 Store 合同的情况下变为：普通消息进入每 Session 的短时队列，由门禁 Agent 判断是否唤醒；`mention | command` 绕过门禁，立即刷新该 Session 的待处理消息并交给 MainAgent。

本计划不提前建立空队列、队列配置、watermark、overflow、重试或门禁 Agent 合同。未来能力必须以独立计划进入。

### 3.3 活动异步 Tool Task 上限

- “异步 Tool Task”特指 Tool 选择异步模式、已立即返回 `accepted`，但后台操作仍继续执行的顶层任务；普通 `Promise` Tool 或显式 `blocking` 模式若等待完成后才返回最终 Result，仍属于阻塞完成路径，不创建模型可查询的异步 Task。
- 异步 Tool 必须先完成 Tool 存在性检查、参数解析与校验，并构造出完整的执行请求，才允许调用外部 Handler/Transport。此前任何失败都必须在当前 Tool 调用内立即失败；并发限额所需的内部预占可以存在，但失败后必须转为 `rejected` 并释放名额，不得伪装为 `accepted` 或进入异步回流队列。限额和 AgentCall 受理前失败继续返回稳定的 HuanLink 结构化错误；未知 Tool 与参数校验错误当前沿用 SDK 错误合同。
- 外部已经受理后的 `failed | canceled | rejected` 与成功终态采用同一 Session 排队回流机制；它们不打断当前 MainAgent Run，轮到执行时再读取来源 Tool Call、当前公开 Task 状态和最新上下文。只有受理前失败立即返回，不产生第二次回流。
- 每个 Session 的活动异步 Tool Task 数量可配置，默认上限为 `2`。
- 限制语义按 HuanLink 可观察的顶层异步 Tool Task 计算；AgentCall/A2A 只是当前第一个 Task 类型，不按 MainAgent turn、普通同步 Tool 或外部 Agent 内部子线程计算。
- `submitting`、`unknown`、`submitted`、`working`、`input-required` 和 `auth-required` 等所有非终态都占用名额；只有 `completed`、`failed`、`canceled` 和 `rejected` 释放名额。
- `continue_task` 继续原 Task，不新增名额；terminal re-entry 本身也不新增名额。
- 不同 Session 独立计数；同一外部 Task 内部的 Codex 子线程、子 Agent 或 Tool 并行不计入 HuanLink 上限。
- 同一 Session 的多个 Task 终态按 HuanLink 实际观察顺序串行 re-entry；每个 Task 各自决定是否显式 `reply`，但本阶段不承诺不同 Task 的后台完成顺序，也不把后来到达的普通消息自动归属于某个既有 Task。
- 并发提交必须先原子预占名额；达到上限时不得调用外部 Transport，而应返回稳定的结构化错误，由 MainAgent 决定如何说明或等待。
- P0 仍显式选择一个 Codex A2A Agent；默认上限为 2 是为了允许同一 Session 存在两个顶层外部 Task，并为后续多 Agent 协作保留空间，不代表 D13 已实现多 Agent 路由。

配置固定放在独立的 `.huanlink/config/server/orchestration.json` 中，由 `config.json.server.orchestration` 显式引用，而不是混入 MainAgent 模型文件或 Agent Adapter 配置：

```json
{
  "version": 1,
  "defaultAgentId": "codex-local",
  "taskPolicy": {
    "maxActiveTasksPerSession": 2
  }
}
```

`maxActiveTasksPerSession` 为必填正整数，仓库默认配置写 `2`；缺少或非法时启动失败，不使用第二配置根、目录扫描或其他隐式来源。

### 3.4 回复与消息事实

- MainAgent 普通 final text 不自动发送到外部 Channel；只有显式调用 `reply` 才产生公开发送。
- 初始受理与 terminal re-entry 都必须以成功调用 `reply` 作为用户可见验收，内部 final text 或 silent outcome 不算“已经回复 QQ”。
- `reply` 使用 Session 固定 route，不允许模型任意改写当前会话目标。
- 成功发送回执只登记待关联信息，不伪造公开消息；等平台自身消息回流后，再形成公开 Session 消息并按 `channelId + messageId` 去重、关联。
- 不自动重试具有外部副作用的 Tool；明确失败返回 `error`，已派发但无法确认的情况返回 `uncertain`。

### 3.5 最小上下文语义

- route 与 Channel 固定信息保存在 Session metadata，不在每条模型输入中重复浪费上下文。
- Channel 消息投影至少包含简短发送者身份、原始消息内容、是否为自身消息、引用关系和内容省略标记。
- Tool Call 与 Tool Result 在 Store 中继续保持结构化事实；投影给模型时使用确定性、可追溯的表示，不降级为无法配对的自然语言摘要。
- Projector 不绑定或反复读取完整 Session，而是只接收一个游标化上下文窗口：固定 metadata、可选的已持久化摘要及其 `throughEntryIndex`，以及该游标之后按稳定顺序读取的时间线条目。尚无压缩 checkpoint 时，游标位于 Session 起点，窗口包含当前全部条目。
- B03 只建立上述窗口、游标和投影边界，不实现 token 上限检测、摘要生成或 checkpoint 推进。后续压缩必须原子保存 `summary + throughEntryIndex`，只有摘要写入成功才能推进游标；原始 Session 事实不因压缩删除。
- `submit`、`status`、`continue`、`reply` 和注入的 OneBot Tool 都必须通过统一的协议无关 `SessionToolHistoryRecorder` 保存 Tool Call/Result；Integration 只接收 recorder hook 和运行上下文，不直接选择 SQLite、文件路径或 Server 配置。
- recorder 必须从 SDK Tool 执行边界取得稳定的 `toolCallId`，在外部派发前记录 Call，并为成功、业务错误、异常和取消都记录可配对 Result；若当前 SDK 接口无法提供稳定 ID，B03 必须停下报告，不能伪造 ID 或降级为无法配对的文本。
- Tool 定义及 Handler 继续由代码注册，不作为数据库配置保存；Tool 调用历史由 Conversation Store 保存。有效参数保持现有结构化格式；SDK 无法解析或校验的原始参数以明确的 raw 形式进入 Session，但不得进入普通日志。
- Tool Call 写入失败时不得执行对应 Tool；外部操作已确认成功但 Result 历史写入失败时，仍返回真实成功结果并附带 `historyWarning`，不能改报失败或 `uncertain` 来诱导重试。
- 所有选择异步模式并立即返回的 Tool 共用协议无关 `AsyncToolTask`；AgentCall 是当前第一个具体类型，普通同步或 `blocking` Tool 不创建模型可查询的异步 Task。创建成功时，原 Tool Call 的直接 Result 只返回 `{ status: "accepted", taskId, state }`；只有已经完成外部接受标记的 Task 后续进入 `completed | failed | canceled | rejected` 终态时才产生新的同 Session re-entry，本地接受前的 `rejected` 只释放预占。终态不重复写成旧 Tool Call 的第二个 Result，也不打断正在运行的 MainAgent turn。
- HuanLink `taskId` 是唯一对模型公开的任务查询 ID；SDK `toolCallId` 只关联来源 Call，A2A `taskId` 只保留为 AgentCall 内部的 `a2aTaskId`。`get_task_status` 与 `continue_task` 均接收 HuanLink `taskId`，不要求模型理解外部协议 ID。
- Task 保存 `(sessionId, sourceRunId, sourceToolCallId)` 来源定位，不复制整段 Session。终态真正取得同 Session 调度槽位后，Store 定向返回原 Tool Call 及其稳定 `entryIndex`，再与 Context Window 的 `throughEntryIndex` 比较；不扫描窗口，也不依赖摘要猜测原指令。
- B04 的 Task 状态仍只在进程内持有；B05-A 新增通用 Task 与 AgentCall 私有外部引用的 SQLite 持久化，但不自动恢复 watcher、重新派发或调用 A2A `GetTask`。Conversation 原始 Tool Call/Result 继续持久化，压缩只推进投影游标而不删除这些事实。
- HuanLink 自有 `runId` 与 `taskId` 使用 UUID；`toolCallId`、A2A `taskId` 和平台 `messageId` 保留真实来源 ID，不改为数据库自增 ID。Conversation 时间线继续使用每 Session 的稳定顺序键，而不是把顺序绑定到全局自增主键。
- P0 不实现自动上下文压缩、摘要 checkpoint、token 预算策略或长期记忆。若当前窗口超出模型限制，必须明确报错，不能暗中截断并破坏 Tool 配对。
- fresh turn、`input-required` 续跑和 terminal re-entry 必须共用同一个按 Session 串行的 Agent turn 调度边界；Phase3 不得让 re-entry 绕过该边界直接并发调用 MainAgent。
- 同 Session 的输入必须在真正取得调度槽位后再读取最新上下文窗口；排队时不得预先捕获一份随后变旧的投影。不同 Session 仍可并行。

## 4. 本计划负责与不负责

### 本计划负责

- Server 总 Runtime 组合对象与正式 `main.ts` 接线；
- Channel 下游 `SessionIngressCoordinator`；
- 当前触发策略与未来队列/门禁替换边界；
- 每 Session 活动异步 Tool Task 上限及默认值 `2`；
- 显式 `agentId` 选择、MainAgent 模型密钥解析和 A2A 目标预检；
- 最小 Session 上下文投影与 MainAgent Tool Call/Result 历史；
- Phase3/MainAgent/AgentCall/A2A/re-entry 与当前会话 `reply` 组合；
- 现有 OneBot Tool 的正式注入；
- `reply` 和 OneBot Tool 对 `ConversationSessionStore` 合同的依赖替换；
- SQLite Store 的生产路径、构造、关闭和重开验收；
- Fake 全链路、自动化回归、压力审查与用户授权后的真实 smoke。

### 本计划不负责

- 消息聚合队列、门禁 Agent、定时刷新、overflow 或持久消息队列；
- 多 Agent 动态路由、能力选择、任务拆分与结果聚合；
- Agent Run 或 A2A Task 跨重启自动恢复；
- 自动 `GetTask` 对账、自动重建 watcher 或自动重新提交；
- 可靠出站投递、自动重试或 exactly-once；
- 完整权限审批中心；
- 完整上下文压缩、长期记忆、检索或向量数据库；
- 管理后台、Web UI 或任务观测台；
- 完整 Codex Adapter 多项目路由与第二个真实 Agent；
- 日志轮转、SQLite backup/checkpoint/retention 或外部 Broker；
- 与 P0/P0.5 无关的工业化扩展和全盘重写。

## 5. 目标职责结构

```text
apps/server/main.ts
└─ HuanLinkServerRuntime                 进程组合、预检、启动和关闭
   ├─ ServerRuntime / ChannelRuntime     Channel 接入、名单和 route 保序
   ├─ SessionIngressCoordinator          Session 写入与当前触发策略
   ├─ SessionContextProjector            确定性模型上下文投影
   ├─ ConversationSessionStore           Conversation 事实合同
   │  └─ SqliteConversationSessionStore  正式生产实现
   ├─ Phase3HuanLinkRuntime              MainAgent turn、AgentCall 和 re-entry
   ├─ AsyncToolTaskService               通用延迟 Task、查询与终态通知
   ├─ AsyncToolTaskLimit                 每 Session 顶层延迟 Task 预占与释放
   └─ Channel Tools                      reply / onebot_standard / privileged 开关
```

职责约束：

- `apps/server` 是组合根，可以选择配置、Store 实现和 Adapter；可复用的协议无关状态与并发语义应放在 `packages/core`。
- `packages/integrations` 只封装 OpenAI Agents、A2A 和 OneBot 外部协议；不得选择本地数据库路径或读取 Server 配置树。
- Codex workspace、branch、模型和 executable 继续属于 Codex Adapter，不进入 MainAgent 或 Core。
- `ChannelRuntime` 不新增 Session、Agent、A2A 或数据库依赖。

## 6. B01：总 Runtime 骨架与配置冻结

### 修改

- 新建 Server 总 Runtime，使用依赖注入持有 Channel Runtime、Conversation Store 和 Phase3 Runtime；第一版测试使用 Fake 组件。
- 定义启动预检、运行和关闭顺序，并以 Fake 预检器锁定“所有预检通过后才启动 Channel”的生命周期；B01 不解析真实密钥、不访问 A2A 网络，也不启动正式 Channel。
- 在唯一配置树中接入 `./server/orchestration.json`，实现必填 `defaultAgentId` 和 `maxActiveTasksPerSession`；仓库默认值写 2。
- 静态解析显式 `defaultAgentId`，要求目标 Agent 存在、启用、transport 为 A2A，并校验其 origin、skillId 与 `apiKeyEnv` 引用名称；不得隐式选择第一个 enabled Agent。
- 暂不修改正式 `main.ts`，先建立可测试组合缝隙。

### 验收

- 缺少默认 Agent、Agent 被禁用、ID 不存在、transport 错误、上限非法或配置引用缺失时，静态预检明确失败；B01 不把真实环境变量或远端连通性作为本批验收。
- Runtime 部分构造或部分启动失败时，已取得资源按逆序关闭且错误可观察。
- 配置仍只有一个固定入口和一棵显式引用树。

### 停点

B01 完成测试与压力审查后报告文件范围和实际结果，等待用户确认后再提交、推送和进入 B02。

## 7. B02：SessionIngressCoordinator

### 修改

- 新建唯一入站 Coordinator；把 Channel Runtime 的有序事件出口接到该对象，不修改 Channel 合同。
- 实现 `appendChannelMessage` 结果、自身消息和当前 trigger 策略。
- 将 Channel 入站 `AbortSignal` 传递给 MainAgent 调度；关闭后不得开始新 turn。
- 普通消息只写 Store；非自身 `mention | command` 成功写入后调用可注入的 MainAgent runner。
- 只定义可替换调度边界，不实现队列和门禁 Agent。

### 验收

- 普通、mention、command、自身、duplicate、associated 和冲突消息均有行为测试。
- 同一 route 继承 Channel Runtime 顺序；不同 route 不被全局锁串行化。
- Store 写入失败时不启动 MainAgent；MainAgent 失败不回滚已观察到的平台消息事实。
- 关闭期间不产生新的 MainAgent turn，已开始操作按 AbortSignal 协作取消。

### 停点

B02 完成测试与压力审查后报告；不得顺手实现队列、watermark 或门禁 Agent。

### B02 后置命名收敛

- 当前只有一套正式 Channel 合同，因此移除 Core、OneBot 集成与 Server
  引用中的 `V1/v1` 后缀，不保留兼容别名。
- 这次只调整文件名、公开符号和引用；不改变 Channel 数据结构、运行行为、
  EventLog Schema 3.0、SQLite 迁移版本或 OneBot 11 协议名称。

## 8. B03：上下文投影与完整 Tool 历史

### 修改

- 定义游标化 Session Context Window，并新建只依赖该窗口的确定性 Projector；当前无 checkpoint 时从 Session 起点读取，后续压缩可以替换窗口来源而不修改 MainAgent 与 Tool 接线。
- 固定发送者、原始内容、引用、内容省略、自身消息与跨 Session 来源的最小表示；固定 route 只在必要的上下文头部出现一次。
- 定义协议无关 `SessionToolHistoryRecorder`，并把它注入 MainAgent 的 submit/status/continue、reply 与 OneBot Tool 执行边界，使所有 Tool Call/Result 都进入同一 Session 时间线。
- 保证真实 Tool Call ID、Tool 名称、结构化或 raw 参数与 Result 配对保留；不得把敏感值写入普通日志。
- 为 AgentCall 增加 `sourceToolCallId` 关联，但不在 B03 新建任务持久化表或重复 Session 任务状态。
- 调整按 Session 串行的 turn 调度，使 terminal re-entry 与 fresh turn 在取得执行槽位后读取同一份最新上下文窗口。

### 验收

- 给定相同上下文窗口，投影结果稳定；固定 metadata 只出现一次，游标之前的原始条目不会被重复投影，消息与 Tool Call/Result 顺序可追溯。
- Tool Result 始终紧邻对应 Tool Call；重复记录幂等或明确冲突，不静默覆盖。
- submit/status/continue、reply 与 OneBot Tool 均覆盖成功、业务错误、抛错、取消、非法 raw 参数和历史写入失败；每条 Result 都可用 SDK `toolCallId` 找到唯一 Call。
- Tool Call 历史写入失败时没有外部派发；外部操作已成功但 Result 写入失败时仍返回真实成功结果及 `historyWarning`，不自动重试。
- 普通日志只记录长度、数量和关联 ID，不记录完整消息、Tool 参数、附件 URL 或资源 key。
- 阻塞前一同 Session turn 后再加入新消息或 AgentCall 终态，后续 turn 只能在前一 turn 结束后启动，并在启动时看到最新窗口；不同 Session 不被全局阻塞。
- 现阶段不宣称使用 SDK 原生持久 Session；若采用文本投影，文档和测试必须准确说明该边界。

### 停点

如果保持完整 Tool 配对需要改变 OpenAI Agents SDK Session 模型、提前实现压缩/checkpoint，或引入未确认的上下文截断策略，停止并向用户报告，不在 B03 暗中扩张。

### 已完成事实与修正入口

- 提交 `df31f16` 与 `8b4564e` 已完成 Context Window、Projector、统一 Tool 历史、`sourceToolCallId`、同 Session 调度和最新上下文读取；这些能力继续保留。
- 当前运行代码仍把 HuanLink Task 等同于 AgentCall，提交回执中的本地 `agentCallId`、远端 `taskId` 与状态查询结果命名不一致；普通延迟 Tool 也没有统一任务注册入口。
- 该缺口不回滚 B03 已完成能力，统一放入 B04 的协议无关 Task 改造；B04 完成前不得声称普通异步 Tool 已支持统一 `taskId`、状态查询或终态回流。

## 9. B04：通用异步 Tool Task 与 A2A/reply 正式组合

### 修改

- B04-A：在 Core 新建进程内 `AsyncToolTaskService`，实现 HuanLink `taskId` 分配、按 Session 原子预占、状态更新、查询、终态去重与释放；只有显式选择异步模式并立即返回的 Tool 才注册 Task。
- B04-A：固定通用状态为 `submitting | unknown | submitted | working | input-required | auth-required | completed | failed | canceled | rejected`，仅后四项为终态。`get_task_status` 固定返回 `{ status: "not-found", taskId }`，或返回包含 `taskId`、`kind`、`toolName`、`state`、`createdAt`、`updatedAt`、可选 `statusMessage` 与受控 `payload` 的 `found` 结果；每种 kind 必须显式提供模型可见投影，原始内部 `payload/statusMessage` 不得由 Service 直接回显，公开 `payload` 不得包含 SDK `toolCallId`、A2A `taskId` 或敏感原始参数。
- B04-A：终态事实先保存并释放名额，再通知下游 re-entry；listener 失败不得回滚已观察的终态，也不得静默吞掉，必须通过错误回调或调用方异常变得可观察。
- B04-A：Task 来源固定保存 `sessionId + sourceRunId + sourceToolCallId`；为 `ConversationSessionStore` 增加按该复合键定向读取原 Tool Call 的只读接口。In-memory 可按现有 timeline 查找，SQLite 复用现有复合查询键，不新增 migration。
- B04-A：提供一个非 A2A 的 Fake 延迟 Tool 公共接缝测试，证明 Task 能力不是 AgentCall 的改名；本计划不新增第二个真实生产 Tool。
- 后续接入普通异步 Tool 时，必须显式注册 Task kind、模型可见状态投影和执行/继续能力，并复用本节统一的 HuanLink `taskId`、Session 隔离、限额、状态查询与排队回流合同；不得让任意普通 Tool 因为返回 `Promise` 就自动注册为异步 Task。
- B04-B：将 AgentCall 的异步模式接入通用 Task Service，公开返回统一为 `{ status: "accepted", taskId, state }`；HuanLink `taskId` 复用现有本地 AgentCall UUID，不再形成第三个模型可见 ID，A2A ID 仅在 AgentCall 内部与脱敏日志中保留为 `a2aTaskId`。
- B04-B：显式 `blocking` 模式不注册通用 Task，正常完成时直接返回最终 Result，不返回 `accepted`，也不产生 terminal re-entry；若远端进入 `input-required | auth-required`，尽力取消远端任务并返回稳定的 `blocking-interrupted` 结果，不临时升级为异步 Task。
- B04-B：把 `get_task_status` 改为只按当前 Session 的 HuanLink `taskId` 查询任意 Task；`continue_task` 同样接收该 ID，但只有支持继续的 AgentCall 类型可执行。AgentCall 的模型可见状态只投影 `statusMessage`、问题与产物，不公开原始输入或任何内部 ID。
- B04-B：Task 终态不补写原 Tool Call 的第二个 Result；`input-required` 与 terminal re-entry 都在同 Session 队列取得槽位后，组合“定向取回的原 Tool Call + 当前 Task 结果 + 最新上下文”发起 re-entry。
- B04-B：当前只识别并保存 A2A `auth-required` 状态，不实现凭证协商、认证恢复或凭证转发；这些能力留给后续独立认证模块。
- B04-C：将配置字段从 `agentCallPolicy` 收敛为 `taskPolicy`，不保留旧别名；Server 从唯一配置树注入默认上限 2。
- B04-C：让 Store 的来源 Tool Call 精确查询同时返回稳定 `entryIndex`；re-entry 只比较该位置与 Context Window 的 `throughEntryIndex`。来源位置位于游标之前时补入一次，否则依赖 Window 的“包含游标后全部条目”不变量直接使用，禁止为判断来源是否存在而遍历整个窗口。
- B04-C：将 A2A 派发结果显式区分为 `not_dispatched | accepted | dispatch_uncertain`。只有本地能够证明没有派发时才释放 Task 并允许立即失败；请求已经交给远端但响应丢失、解码失败或无法确认时保留 HuanLink Task 为 `accepted + unknown`，占用名额、禁止自动重试并等待后续对账。
- 保持当前单个显式 Codex Agent 目标；不实现多个 Agent 的动态路由。
- 从正式配置构造 DeepSeek MainAgent model binding，只在真正接线时解析 API Key。
- 在 Channel 启动前验证 A2A origin 可发现、Agent Card 可读取、目标 skill 可用。
- 将同一 Store、当前 Session 的有序 Adapter 和 Logger 注入 `reply` 与 OneBot Tools。
- `onebot_standard` 正式可用；`onebot_privileged` 仅在现有显式无保护开关开启时注册，并记录当前没有审批防护。
- 保留 `input-required` 继续原任务、终态 re-entry、一次发送和无自动重试语义。
- 将 fresh turn、`input-required` 续跑和 terminal re-entry 全部提交给同一个按 Session 串行的 Agent turn 调度器；禁止 re-entry 直接绕过调度器调用 MainAgent。

### 验收

- 同 Session 前两个活动 Task 可提交；第三个在任何外部 Handler/Transport 调用前收到结构化上限错误。
- 不同 Session 独立计数；Task 终态释放；`unknown`、`input-required` 和 `auth-required` 等非终态占位；`continue_task` 不新增名额。
- 外部接受前的明确失败必须把预占 Task 转为 `rejected` 并释放名额，且不得产生 terminal re-entry；已接受后的未知结果不得自动重试。
- Tool 不存在、参数非法或执行请求未完成构造时，必须在调用任何外部 Handler/Transport 前于当前 Tool 调用内立即失败；只有外部已经受理的 Task 才能返回 `accepted`，其后观察到的错误终态按同 Session 顺序 re-entry。
- 并发提交不能越过上限；外部 Agent 内部子线程不影响计数。
- 普通同步 Tool 不产生 Task；Fake 非 A2A 延迟 Tool 与 AgentCall 使用同一 `taskId`、查询和限额合同。
- `blocking` AgentCall 直接返回最终 Result，不返回 `accepted`、不进入 `get_task_status` 工作流，也不在完成后产生第二次 re-entry。
- 提交、查询和继续的模型可见输入输出不包含 SDK `toolCallId` 或 A2A `taskId`；使用这些内部 ID 查询应返回 `not-found`。
- 对不支持继续的 Task，`continue_task` 稳定返回 `{ status: "unsupported", taskId, operation: "continue" }`，不伪装成 `not-found` 或模糊状态错误。
- 来源 Tool Call 即使位于 Context Window 游标之前，终态 re-entry 仍能按复合键定向取回精确原指令，并同时读取轮到执行时的最新上下文；是否补入只由来源 `entryIndex` 与压缩游标决定，不扫描 Window。来源位于游标之前时只补入一次并明确标为来源 Call，否则不重复附加。
- 来源 Tool Call 缺失时必须 fail-closed，记录包含 Session、HuanLink `taskId` 和错误阶段的脱敏错误，不启动 MainAgent、不猜测来源且不自动重试。
- 同一 Session 的两个 Task 同时进入终态时，按观察顺序串行 re-entry，二者的 Tool 历史和 `reply` 关联不能串线。
- fresh mention/command 与同 Session 的 terminal 或 `input-required` re-entry 交错到达时也必须串行执行，并在轮到各自执行时读取最新 Session 投影。
- 初始受理与 terminal re-entry 的成功场景都实际调用 `reply`；只返回 final text 不算外部成功。
- A2A 预检失败时 Channel 尚未启动；运行期 A2A 失败保留明确错误语义。
- A2A 请求已经交给远端后出现响应丢失或响应校验失败时，不得降级成可安全重试的受理前失败；返回 HuanLink `taskId` 与 `unknown` 状态，且不创建第二个远端任务。

### 停点

若真实 Codex smoke 只能通过修改正式 Server 工作树或依赖未接入的 Adapter JSON 配置才能运行，停止并单独报告 Adapter 入口缺口。

B04 只建立进程内通用 Task。Task SQLite 表与重开语义按 B05-A 实施；重启后自动 `GetTask`、重建 watcher、重投递或恢复 re-entry 仍不在本计划内。

普通异步 Tool 的生产接入属于后续独立计划；B05-A 只持久化通用 Task 事实与提供受限的跨重启查询，不自动恢复执行。

### B04-B 实施结果（2026-08-12）

- AgentCall 的异步提交、状态查询和继续操作已统一使用 HuanLink `taskId`；A2A `taskId` 只留在内部记录。`blocking` 不创建通用 Task，遇到 `input-required | auth-required` 时按计划返回 `blocking-interrupted`。
- 外部受理前失败返回结构化 `task-preaccept-rejected` 并释放名额；外部已经受理但本地关联异常时保留为 `accepted + unknown`，继续占用名额且不自动重试。
- `input-required` 与 terminal 事件已统一从 Task Service 进入同 Session 调度器；轮到执行后才读取来源 Tool Call、公开 Task 状态和最新 Context Window。过期事件会跳过，来源 Call 缺失时 fail-closed。
- In-memory 组合测试已覆盖初始受理和 terminal re-entry 均显式调用 `reply`；当前仍未接正式 `main.ts`、SQLite 生命周期或真实 QQ/Codex smoke，这些边界分别留给 B04-C、B05 和后续真实验收。
- 新鲜验证为全仓 `typecheck`、Prettier 和差异检查通过；按包串行共 `798` 个测试通过、`2` 个既有条件测试跳过。两路独立压力审查修复状态竞态与跨包测试迁移后，未留下 P0/P1/P2。完整根构建在本机仍被 Windows 对既有 `dist` 文件的 `EPERM` 占用锁阻断；Core 与 OpenAI Integration 的独立构建已通过。

## 10. B05：Task 持久化与 SQLite 正式生命周期（P0.5）

### B05-A：通用 Task 持久化

#### 修改

- 新增 `async_tool_tasks` 表，保存 HuanLink `taskId`、Session、来源 Run/Tool Call、kind、toolName、状态、受控 payload、状态说明和时间戳；状态更新与活动名额释放必须在同一 Store 操作中保持一致。
- 为 AgentCall 增加只在内部使用的持久关联，保存 HuanLink `taskId` 与 A2A `taskId` 等未来人工对账所需的最小引用；这些字段不得进入通用公开 Task 投影、普通日志或模型上下文。
- `AsyncToolTaskService` 通过协议无关 Store 读写 Task，而不是自行选择 SQLite 路径；In-memory 实现继续用于单元测试和隔离测试。
- 重开后终态 Task 保持可查询；重启时仍非终态的 Task 对外统一为 `unknown` 并明确标记需要对账，继续占用活动名额。不自动恢复 watcher、不自动 re-entry、不自动重新派发，也不自动调用 A2A `GetTask`。

#### 验收

- SQLite 重开后，终态 Task 的 HuanLink `taskId`、状态和公开结果保持一致；A2A 内部 ID 不会出现在模型可见状态中。
- 重启时非终态 Task 稳定返回 `unknown` 与需要对账的状态说明，且不能被自动重试或误判为终态释放名额。
- 每次状态变化、终态释放、重复终态和冲突更新都有事务与重开测试；数据库失败不得只更新内存而伪造成功状态。
- 本批不提供自动或手动 `GetTask` 对账 Tool；该能力继续按价值优先路线后移。

### B05-B：生产 SQLite 生命周期

#### 修改

- 将 `reply` 与 OneBot Tool 的 Store 类型改为 `ConversationSessionStore` 合同。
- 在 Server 组合根创建 `.huanlink/data`，使用固定路径 `.huanlink/data/huanlink.sqlite` 构造 `SqliteConversationSessionStore`。
- 使用独立 owner/factory handle 管理 SQLite `close()`；不把生命周期方法加入纯业务 Store 合同。
- 正式 `main.ts` 切换到总 Runtime；生产入口直接使用 SQLite，In-memory 只留给单元测试、Fake Runtime 与隔离测试。
- 关闭顺序固定为：停止新 Channel 入站并中止/排空 handler，关闭 Phase3 AgentCall/re-entry，最后关闭 SQLite Store 和 Logger。

#### 验收

- 真实临时 SQLite 文件完成启动、消息写入、Tool 历史、发送回执、关闭、重开和自身消息关联测试。
- 重启后 Session、消息去重、Tool 历史与 pending delivery 可读；重复消息不产生第二个 fresh turn。
- 不恢复旧 MainAgent Run，不自动查询或续跑 A2A Task，不自动重发任何消息。
- 重启前返回的 HuanLink `taskId` 可按 B05-A 查询持久化状态；非终态只返回 `unknown` 与需要对账，不得据此自动探测外部 Task、重建 watcher 或触发 re-entry。
- 创建目录、migration 或 Runtime 启动失败时不留下仍被占用的数据库句柄。

### 停点

B05-A 完成后先单独报告 Task 的真实持久化与重开边界；B05-B 完成后再报告生产 SQLite 生命周期。不能把 Task 可查询写成任务已自动恢复。

## 11. B06：整体回归、压力审查与真实验收

### 自动化验收

1. Fake Channel -> Store -> MainAgent -> Fake A2A -> `reply` -> self-message association 组合测试。
2. trigger、自身消息、duplicate、associated、冲突事实和关闭 Abort 回归。
3. 通用异步 Tool Task 的统一 ID、状态查询、每 Session 上限、并发预占、终态释放与跨 Session 隔离测试。
4. fresh turn 与 terminal re-entry 的上下文和 Tool 历史测试。
5. SQLite 关闭重开、去重、Tool 历史和 pending 关联测试。
6. `reply`、OneBot standard/privileged 开关、错误与 `uncertain` 回归。
7. 根 `format:check`、全仓 build、test、typecheck 和 `git diff --check`。
8. 至少两路独立压力 Reviewer 检查状态所有权、关闭竞态、并发上限、投递语义、日志脱敏和范围越界；修复确认问题后重新验证。

### 真实 smoke

只有用户再次授权并提供执行窗口后才运行。至少证明：

- 允许 QQ 会话中的 `mention` 或 `command` 进入正式 SQLite Session；
- MainAgent 通过显式 `codex-local` AgentCall 发出真实 A2A 请求；
- Codex Adapter 在独立受控工作区调用真实 codex app-server，产生允许范围内的代码变更、Artifact 与测试结果；
- 群内收到初始受理、HuanLink task ID 和终态 `reply`；
- 平台自身消息回流后只形成一条公开消息并关联原 Tool Call；
- 用 sessionId、runId、HuanLink taskId、内部 A2A taskId、Codex thread/turn、Artifact 和 messageId 串联脱敏日志；
- 日志不泄漏模型 Key、OneBot Token、完整 CQ、附件 URL、资源 key 或完整 Tool 参数。

历史 Demo 与 Channel-only smoke 只能作对照，不能代替这次正式架构的新鲜证据。

## 12. 提交、推送与模块门

- 文档与代码分开提交；D13 计划、每批实施结果和代码不得混在同一提交。
- 每个 Bxx 只完成本批目标；定向测试和压力审查通过后先报告，等待用户确认再 commit/push。
- 精确暂存本计划范围，始终排除用户的 `docs/dev/dev daily.md` 和任何未授权 reference 变化。
- 未经用户确认不得创建 PR、进入下一 Bxx 或合并到 `main`。
- 任何真实外部 Channel、模型、A2A 或 Codex smoke 都需要当次明确授权；测试成功不自动授权外部操作。
- 若实现证据与本文冲突，先更新事实并报告，不通过扩大代码来维持错误计划。

## 13. 完成定义

只有同时满足以下条件，才可报告 D13 完成：

- 正式 `main.ts` 不再是 Channel-only 日志出口，而是装配完整 Server Runtime；
- Channel 仍保持纯平台接入、名单和顺序边界；Session/Agent 决策只存在于下游 Coordinator；
- 当前触发策略与未来队列/门禁替换边界有自动化证据；
- 每 Session 活动异步 Tool Task 上限可配置且默认 2，并发不能越界；普通同步 Tool 不占用名额；
- AgentCall 与 Fake 非 A2A 延迟 Tool 共用 HuanLink `taskId`、状态查询和终态回流合同，模型不需要使用 SDK 或 A2A 内部 ID；
- MainAgent fresh turn、AgentCall、A2A、terminal re-entry 与显式 `reply` 形成组合闭环；
- 模型上下文包含可追溯 Channel 消息和结构化配对的 Tool Call/Result，且没有冒充完整 SDK Session；
- 正式入口使用 SQLite，关闭重开后 Conversation 事实仍可读；
- 全仓验证与压力审查无未解决 P0/P1/P2；
- 用户授权后的真实 QQ/Codex smoke 留下可串联的新鲜证据；
- 明确报告仍不具备消息门禁 Agent、队列、任务自动恢复、可靠投递、多 Agent 路由和 exactly-once。
