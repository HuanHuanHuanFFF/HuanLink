# 31. HuanLink 秋招价值优先候选路线

> **文档状态：候选路线（2026-08-08）。价值优先的开发方向已经确认，但具体模块的排期与激活尚未确认；本文不构成任何模块的实施授权。** 本文只用于比较后续投入方向；在用户明确选定模块前，不改变现有 `Dxx/Bxx` 的优先级。选定后仍需为该模块建立或更新独立 `Dxx`，重新审计代码、测试和真实运行证据，再分批实施。
>
> **定位边界：** HuanLink 是面向本地单用户的异构 Agent 协作与 A2A 外层编排项目。QQ 与 Codex 是第一个真实验证场景，不是项目的最终产品边界。

## 1. 方向变化

后续开发不再以“先补齐完整基础设施”为默认顺序，而采用以下优先级：

1. 先恢复一条当前架构下可运行、可演示的基本闭环；
2. 再优先实现对真实使用、秋招简历和面试展开有直接价值的功能或模块；
3. 只有当真实功能被阻塞、或实际运行证据证明有必要时，才补相应可靠性和基础设施；
4. 不把局部合同、单元测试或历史 Demo 证据写成当前正式入口已经可用。

本路线追求的是“更多有证据的有效能力”，不是功能数量本身。每个候选模块都应尽量形成：

```text
真实问题
-> 可解释的关键设计
-> 可运行功能
-> 自动化验证
-> 真实演示或日志证据
-> 可用于简历与面试的准确结论
```

## 2. 当前事实基线

### 2.1 已有真实证据

历史 Demo 曾真实完成：

```text
真实 QQ
-> DeepSeek MainAgent
-> HuanLink AgentCall
-> 标准 A2A
-> Codex A2A Adapter
-> 官方 codex app-server
-> 真实代码修改与 Artifact
-> MainAgent 终态回流
-> 原 QQ 群
```

[`23-a2a-first-real-demo-plan.md`](./23-a2a-first-real-demo-plan.md) 记录了真实任务、A2A Task、Codex thread/turn、Artifact、代码 diff 和群内回流。它证明技术方向曾经跑通，但不能代替当前正式入口的重新验收。

### 2.2 当前正式入口

Channel 重构后，当前正式进程只完成：

```text
QQ / OneBot
-> Channel Adapter
-> Channel Runtime
-> 名单过滤与同 route 保序
-> 统一下游日志出口
```

当前 `apps/server/src/main.ts` 明确记录 `message_queue_deferred`；`ServerRuntime` 不保存 Session、不选择 Agent，也不判断消息是否触发 Agent。因此，当前源码没有一条由正式 `main.ts` 启动的 QQ → MainAgent → A2A → Codex → `reply` 完整链路。

[`D11-channel-contract-v1-implementation-plan.md`](./D11-channel-contract-v1-implementation-plan.md) 已证明当前 Channel Runtime 与正式入口代码完成，并完成 QQ → Channel 下游出口的真实 smoke；它也明确把 Session 写入、Agent 调度和新架构全链路验证后移。

### 2.3 可直接复用的组件

| 能力 | 当前证据 | 当前缺口 |
|---|---|---|
| Channel Runtime | 正式入口、名单过滤、route 保序、Channel-only QQ smoke | 没有下游编排接线 |
| Conversation Store | In-memory 已有；SQLite 合同、migration、事务和重开测试已完成 | 正式 Server 未构造、未管理生命周期 |
| MainAgent / AgentCall | `phase3-runtime.ts` 已组装 MainAgent、AgentCall、A2A Transport、Task 查询/续跑和终态 re-entry | 正式 `main.ts` 未创建或调用该 Runtime |
| Current-session `reply` | Tool 合同、可信 route、单次发送和自身消息关联已有测试 | 正式 Runtime 未注入 Store 和 Channel Adapter |
| A2A / Codex Adapter | Agent Card、Task、订阅、查询、取消、Artifact、真实 Codex app-server 执行已有代码和历史证据 | 当前正式 Channel 入口未连接；Adapter 仍有 Demo 配置边界 |
| 本地配置 | MainAgent、Channel 和 A2A Agent 的静态配置、引用和密钥环境变量合同已存在 | MainAgent 密钥与 Agent 配置尚未用于正式 Runtime 接线 |
| 可观测性 | Server/Adapter JSONL 与关联 ID 已存在 | 没有面向用户的当前任务视图，当前新链路也没有完整事件证据 |

[`D12-sqlite-conversation-store-implementation-plan.md`](./D12-sqlite-conversation-store-implementation-plan.md) 只证明 Core Store 已完成。它不证明服务重启后能恢复 Agent Run、A2A Task 或出站投递。

## 3. 候选模块的排序标准

候选模块按以下问题排序，不以“基础设施是否完整”排序：

1. **基本可用性：** 是否补上真实用户路径中的断点；
2. **可展示性：** 是否能在短演示中被直接看见，而不只存在于底层代码；
3. **差异化：** 是否强化异构 Agent、A2A、异步任务、上下文或授权等核心定位；
4. **面试深度：** 是否能解释状态所有权、协议边界、失败语义和取舍；
5. **证据质量：** 是否能留下测试、真实 Task、Artifact、diff、日志或截图；
6. **投入产出：** 是否复用现有代码，并避免为了一个功能先建设大而全的平台。

下列工作默认不单独获得高优先级：只增加抽象层、只增加配置项、只补齐“以后可能需要”的可靠性、没有真实消费者的通用框架，以及无法形成独立验收结果的重构。

## 4. 候选优先级总览

| 优先级 | 候选结果 | 主要价值 | 进入条件 |
|---|---|---|---|
| P0 | 当前正式架构的最小 QQ → MainAgent → A2A → Codex → `reply` 闭环 | 恢复基本功能，形成所有后续模块的演示底座 | 选为当前模块并建立聚焦 `Dxx` |
| P0.5 | SQLite Conversation Store 接入正式 Server 生命周期 | 复用已完成投入，形成可解释的会话持久化与去重证据 | 与 P0 相邻接线，不扩大为 Agent/A2A 自动恢复 |
| P1 | 异步任务体验、AgentCall/A2A 历史与本地项目/Agent 配置 | 从技术 Demo 变成可查询、可手动对账、可重复使用的本地产品能力 | P0 有新鲜真实证据，且 P0.5 的正式 SQLite 接线与生命周期已完成 |
| P2 | 第二个真实 A2A Agent 与能力路由 | 直接强化“异构 Agent 协作”差异化 | 配置和单 Agent 闭环稳定；用户选择第二 Agent |
| P2 | 聚焦的权限审批回流 | 展示 Agent 安全、授权绑定和同任务恢复 | 单任务 `input-required` 闭环稳定；单独确认安全边界 |
| P3 | 任务观测台 / 任务时间线 | 提升演示效果和诊断能力，串起多类 ID、状态与 Artifact | 先定义最小读模型，不先建设完整前端平台 |
| P3 | 多 Agent 实现—审查协作流 | 展示多 Agent 分工、结果聚合和外层编排 | 至少两个真实 Agent 或两个可清楚区分的执行角色 |
| 按需 | 队列、恢复、轮转、备份、Broker 等基础设施 | 解决已经出现的可靠性或容量问题 | 有真实故障、指标或产品承诺作为触发证据 |

同一优先级不是并行实施授权。用户每次只选择一个当前模块，再为它建立 Dxx 和小批次。

## 5. P0：恢复当前架构的最小真实闭环

### 5.1 用户可见结果

第一目标不是新增更多底层能力，而是让用户可以再次完成：

1. 在允许的 QQ 会话中通过明确命令或 @HuanLink 发起请求；
2. HuanLink 将真实消息写入对应 Session；
3. MainAgent 判断是否委派代码任务；
4. AgentCall 通过标准 A2A 调用已配置的 Codex Agent；
5. 群内获得受理状态和任务 ID；
6. 用户可以查询任务状态，任务需要输入时可以继续原任务；
7. Codex 返回 Artifact、变更和测试结果；
8. MainAgent 通过显式 `reply` Tool 将结果发回原会话。

### 5.2 推荐的最小语义

- Channel 继续只负责平台接入、名单和顺序，不在其中加入 Agent 策略；
- 下游先调用 `appendChannelMessage`；只有返回 `appended`、`sender.isSelf === false` 且 trigger 为 `mention | command` 时，才允许进入 MainAgent；
- `duplicate` 与 `associated` 一律不触发 Agent；Bot 自身消息只用于发送关联和上下文记录；
- 第一版普通消息只进入 Session，不触发 fresh turn；
- MainAgent 普通最终文本不自动发到 QQ，只有显式 `reply` 调用产生公开消息；
- 第一版显式选择一个 Codex A2A Agent，不暗中选择“第一个 enabled Agent”；
- 继续复用 `AgentTurnScheduler` 和 Channel Runtime 现有同 Session 顺序保护，不先增加新消息队列。

P0 不承诺同一 Session 内多个 working AgentCall 的并行结果归属。进入实施前必须冻结单 Session 活动任务策略；推荐第一版只允许一个活动 AgentCall：`input-required` 消息继续原任务，working 期间的新请求只允许查询、取消或补充原任务，不提交替代 AgentCall。terminal re-entry 与新入站消息继续通过同 Session scheduler 串行，并读取同一份最新上下文。

这些是候选默认值。成为当前计划时，应在聚焦 Dxx 中再次确认，但不应为了讨论完整策略阻塞最小闭环。

### 5.3 建议实施切片

#### 切片 A：最小组合对象

- 在 Server 组合层持有 Channel Runtime、Conversation Store 和 MainAgent/AgentCall Runtime；
- 统一管理启动、关闭、Abort 和错误上报；完成配置、密钥和 Agent 预检后才启动 Channel；
- 关闭时先停止新入站并中止或排空 Channel handler，再关闭 Phase3 的 AgentCall/re-entry，最后关闭持久 Store；
- 将入站 `AbortSignal` 传给 `runMainAgent`，避免关闭后继续启动新工作；
- 不把 Session、Agent 或 A2A 职责塞回 `ChannelRuntime`；
- 第一条组合测试可使用 In-memory Store，先证明运行链路。

#### 切片 B：入站与触发策略

- Channel 消息先进入 Store，处理 appended、duplicate 和自身消息 associated；
- 只对满足最小触发规则的消息运行 MainAgent；
- 为 Session 构造可追溯的最新上下文；
- 覆盖重复消息、自身消息、普通消息、命令和 mention 的行为测试。

#### 切片 C：A2A 与当前会话回复

- 从正式配置显式取得 MainAgent 模型和目标 Codex Agent；
- 只在 Runtime 真正接线时解析 MainAgent 密钥；
- 启动 Channel 前校验目标 `agentId` 已启用、A2A origin 可发现、Agent Card 与目标 skill 可用；密钥不得进入日志；
- 将有序 Channel Adapter 与 Store 注入 `reply` Tool；
- 保留 task status、cancel、input-required continuation 和 terminal re-entry 的既有语义；
- 不自动重试具有外部副作用的 Tool。

#### 切片 D：当前架构验收

- Fake Channel → Store → MainAgent → Fake A2A → `reply` → self-message association 的组合测试；
- 初始受理与 terminal re-entry 都必须观察到显式 `reply` Tool、可信 route 和发送回执；只有内部 final text 或 silent outcome 不能算“成功回群”；
- format、build、test、typecheck 全部通过；
- 用户授权后执行真实 QQ、真实 MainAgent、真实 A2A HTTP、真实 Codex app-server 和真实代码修改 smoke；
- Codex smoke 使用独立受控工作区和允许修改的测试项目，固定分支与版本门禁，并核对运行前后 Git 边界；不得默认修改正式 Server 工作树；
- 用关联 ID 核对受理、Task、Codex thread/turn、Artifact、终态 re-entry 和当前会话回复；
- 历史 Demo 日志只作对照，不能冒充这次新架构的证据。

### 5.4 P0 明确不做

- 有界消息聚合队列；
- 跨重启恢复 Agent Run 或 A2A Task；
- 出站持久投递和自动重试；
- 多 Agent 动态路由；
- 同一 Session 多个 working AgentCall 的并行提交、结果排序与归属承诺；
- 通用工作流 DSL；
- 完整审批中心；
- 管理后台或完整 Web UI；
- 为非阻塞边界进行大规模重构。

## 6. P0.5：接入已有 SQLite Store

SQLite Store 已经完成，后续只补正式生命周期和调用方替换：

- 将 `reply`、OneBot Tool 等仍直接依赖 In-memory 具体类型的位置改为 `ConversationSessionStore` 合同；
- 默认候选路径为 `.huanlink/data/huanlink.sqlite`，由 Server 创建目录；使用单独的生命周期 owner/factory handle 管理关闭，不把 `close()` 偷偷塞进纯业务 Store 合同；
- 验证正式 Runtime 优雅关闭并重启后，Session、消息去重、Tool 历史和发送关联仍可读取；
- 不恢复旧 Agent Run，不恢复 A2A Task，不重发不确定的消息。

运行前提仍是仓库支持的 Node 24；`node:sqlite` 的版本稳定性继续由 Store 合同封装和兼容测试控制。若后续环境证据不满足要求，再重新评估驱动，不把实现细节泄漏给调用方。

正式 Server 生产入口直接使用 SQLite Store；In-memory 实现只保留给单元测试、Fake Runtime 和隔离测试。P0 的组合测试可以注入 In-memory Store，但真实 Server 验收必须走 SQLite。P0.5 只完成 Conversation 持久化与生命周期，不在这一阶段扩展 AgentCall/A2A Task 持久化或恢复。

## 7. P1：把异步任务变成可重复使用的产品能力

P0 的当前架构闭环和 P0.5 的正式 SQLite 接线、关闭生命周期形成新鲜证据后，再进入 P1。P1 优先把已有任务语义真正交给用户，并增加历史查询与手动对账；不建设自动恢复平台。

### 7.1 任务体验

- 统一展示 HuanLink taskId，外部 A2A taskId 作为诊断信息；
- 支持受理、查询、取消、`input-required`、继续原任务和终态通知；
- 结果按摘要、Artifact、变更文件、diff 和测试证据组织；
- 明确区分 completed、failed、canceled、rejected 与 delivery uncertain；
- 用户查询已有任务时不重新提交任务。

### 7.2 AgentCall/A2A 历史与手动任务对账

本模块的目标是“历史可查询、状态可手动刷新、失败后可显式重试”，不是进程启动后自动恢复任务。

HuanLink Server 侧：

- 在 HuanLink SQLite 中保存 AgentCall 最新快照、Session、目标 Agent、HuanLink taskId 与外部 A2A taskId 映射、状态、时间、错误和 Artifact；
- `get_task_status` 在内存中找不到记录时继续查询持久 Store；
- 提供显式的手动对账操作：读取持久记录，使用原 external taskId 调用 A2A `GetTask`，再更新本地快照；
- 对账得到 working 时，用户可以显式选择在当前进程重新建立 watcher；得到 input-required 时继续原任务；得到终态时由用户决定是否重新触发 MainAgent 总结；
- `not found` 或远端不可达时记录 `recovery_unknown`，禁止自动重新提交；
- 用户明确重试时创建新的 AgentCall/A2A Task，并记录 `retryOf`，不伪装成原任务继续执行。

A2A Adapter 侧：

- 使用 Adapter 自己拥有的 SQLite `TaskStore` 替换 SDK `InMemoryTaskStore`，实现标准 `save/load/list`；
- 允许 Adapter 重启后查询已保存的 A2A Task 历史和终态；
- Adapter 数据文件与 HuanLink Server 的业务表分开拥有，不共享进程生命周期或私有 schema。

本模块明确不做：

- 启动时自动扫描或恢复未终态任务；
- 自动恢复 watcher、Codex turn 或 terminal re-entry；
- 自动重新提交未知状态任务；
- 自动重发 Channel 结果；
- exactly-once 或崩溃期间无损恢复。

### 7.3 本地项目与 Agent 配置

- 让用户无需修改源码即可选择已注册项目、工作焦点、MainAgent 模型和目标 Agent；
- 配置只引用稳定 ID，不接受任意绝对路径从 MainAgent 透传；
- HuanLink 管理 Agent 发现和选择，项目、workspace、分支和执行模型仍由对应 Adapter 拥有；
- 先提供清晰配置与诊断结果，不把完整 GUI 作为前置条件。

### 7.4 证据

- 至少两个不同本地项目的真实小任务；
- 一次 async、一次 blocking 或 input-required 的可复验任务；
- 每次结果都能定位 Task、Artifact、diff 和测试；
- HuanLink Server 重启后仍可查询 AgentCall 历史，并能手动 `GetTask` 对账；
- Adapter 重启后仍可查询已保存的 A2A Task；远端不存在或不可达时只报告 `recovery_unknown`；
- 显式重试创建新任务并保留 `retryOf`，不会冒充同一任务自动恢复；
- 无效项目、Agent 或模型配置能给出用户可理解的错误。

## 8. P2：形成真正的异构 Agent 差异化

### 8.1 第二个真实 A2A Agent 与能力路由

目标不是再写一个固定 Tool，而是证明新 Agent 可以通过标准边界接入：

- 读取 Agent Card 和 skill/capability；
- 使用稳定 `agentId` 和显式选择策略；
- MainAgent 能根据任务能力选择或按用户指定目标路由；
- Core 不依赖第二个 Agent 的私有协议类型；
- 新 Agent 的真实结果可以回到同一 Task/Session 体验中。

只有接口、mock、配置文件或第二个 Codex 实例不能单独证明“异构 Agent”。进入本模块前，需要用户选择真实第二 Agent 和可验证场景。

### 8.2 聚焦的权限审批回流

以 [`27-a2a-delegation-context-and-approval-design.md`](./27-a2a-delegation-context-and-approval-design.md) 为设计输入，但只实现一个窄闭环：

- Codex Adapter 接入经 app-server 实际暴露、且可由 Adapter 机械映射的命令、文件、网络或 Tool 提权请求；
- 通过结构化 `input-required` 回传具体审批请求；
- `ApprovalDecision` 只绑定 task、approvalId、决定、有效期和单次消费状态；原待执行操作只由 Adapter 服务端保存；
- 用户拒绝、批准、过期或答非所问时行为明确；
- 批准后只恢复 Adapter 保存的原操作，不接受 MainAgent 重写操作内容；
- 通过一次真实提权、一次拒绝和一次过期/重复消费测试形成证据。

本模块不建设多租户 IAM、通用策略 DSL、完整审批中心或自动批准平台。

## 9. P3：提高展示力并形成多 Agent 场景

### 9.1 最小任务观测台

先定义最小只读任务视图，再决定 CLI、Web 或其他交互形态：

- Session、MainAgent run、AgentCall、A2A Task、Codex thread/turn 的关联时间线；
- 当前状态、等待输入、耗时、错误和 Artifact；
- 只展示已经记录的事实，不从日志文本猜测任务状态；
- 可以从一次真实演示直接生成截图和复盘材料。

它不是通用日志平台，也不要求先建设复杂前端、指标仓库或分布式追踪。

### 9.2 多 Agent 实现—审查协作流

在两个真实能力边界稳定后，再实现一个小而明确的协作模式：

```text
MainAgent 确认目标
-> 实现 Agent 产出变更与证据
-> 审查 Agent 检查 diff、测试和风险
-> MainAgent 聚合分歧与最终结果
```

第一版只支持这一种可解释模式，不抽象通用 DAG 或工作流 DSL。验收必须能看到两个独立 AgentCall、各自产物、审查结论和最终聚合，而不是一个 Agent 在 Prompt 中扮演多个角色。

## 10. 按需基础设施清单

下列事项保留为技术债和触发式候选，不自动进入当前计划：

| 能力 | 重新排期的触发条件 |
|---|---|
| 有界内存队列 | 真实连续消息导致不可接受的积压、重复唤醒或不可观测等待 |
| 持久入站队列 | 产品明确要求重启后继续处理已接收但未消费消息 |
| 自动恢复 Agent Task | 产品明确要求启动时自动找回、继续和回流后台任务；P1 的历史查询与手动对账不触发该范围 |
| 可靠出站投递 | 需要 intent/attempt/确认/不确定状态与受控重试 |
| 日志轮转 | 单文件增长已影响日常运行，或发布前需要固定保留策略 |
| SQLite backup/checkpoint/清理 | 数据开始具备不可替代价值，或 WAL/容量出现实际问题 |
| 外部 Broker | 出现多进程、多主机、独立 Worker 或实测单机瓶颈 |
| exactly-once | 有清晰业务定义和可验证的外部副作用边界 |

## 11. 每个模块的成果包

模块只有形成以下成果，才计入“有价值的完成”：

1. 一份经确认的聚焦 Dxx，写清负责与不负责；
2. 小而可审查的实现提交，文档与代码分开；
3. 对应合同、集成或回归测试；
4. 与声明强度匹配的真实 smoke 或运行证据；
5. 一段“问题 → 关键设计 → 验证结果”的简历素材草稿；
6. 明确列出仍未具备的恢复、可靠性、安全或规模边界。

测试数量、运行耗时和成功率只能使用实际记录；没有新鲜证据时，不沿用旧数字作为当前结果。

## 12. 激活本路线时需要确认

当用户准备把本路线排为当前计划时，只需先确认：

1. 当前模块是否选择 P0“最小正式闭环”；
2. 正式配置中通过哪个稳定 `agentId` 显式选择 Codex Agent；
3. P0 是否沿用“非自身 `mention | command` 才触发，普通消息只入 Session”的默认策略；
4. 是否采用“同一 Session 只允许一个活动 AgentCall，working 期间不提交替代任务”的推荐策略；
5. 初始受理和终态回流是否都以显式 `reply` 成功作为 P0 的用户可见验收；
6. 真实 QQ / MainAgent / Codex smoke 的执行窗口和允许修改的测试项目；
7. P0 当前架构闭环和 P0.5 正式 SQLite 接线完成后，是否按本路线进入 P1“AgentCall/A2A 历史与手动任务对账”；
8. P1 完成后，在“第二 Agent、审批回流、任务观测台”中选择下一个高价值模块。

确认后应建立新的聚焦 Dxx。本文仍作为价值排序和候选池，不直接承载具体代码实施细节。

## 13. 与现有文档的关系

- [`23-a2a-first-real-demo-plan.md`](./23-a2a-first-real-demo-plan.md)：历史真实闭环证据；不作为当前入口已连接的证明。
- [`24-huanlink-v1-product-requirements-draft.md`](./24-huanlink-v1-product-requirements-draft.md)：仍提供未被后续决策替代的产品语义。
- [`26-huanlink-v1-development-plan.md`](./26-huanlink-v1-development-plan.md)：历史阶段路线和文档优先级说明；不再规定当前开发顺序。
- [`D11-channel-contract-v1-implementation-plan.md`](./D11-channel-contract-v1-implementation-plan.md)：已完成的 Channel Runtime 结果，以及仍待与 Session/Agent Runtime 组合验证的当前入口边界。
- [`D12-sqlite-conversation-store-implementation-plan.md`](./D12-sqlite-conversation-store-implementation-plan.md)：SQLite Core Store 已完成结果和未接 Server 的边界。
- [`27-a2a-delegation-context-and-approval-design.md`](./27-a2a-delegation-context-and-approval-design.md)：审批模块的分析输入；不授权当前实现。

若本文未来被确认为当前总路线，应同步更新 `24`/`26` 中与开发优先级冲突的状态说明；在此之前不修改这些历史文档。
