# HuanLink A2A-First 真实 Demo 计划

> **执行说明：** 本文是 Demo 阶段的方向与验收计划，不是最终架构规范。实现细节允许根据 A2A v1.0 SDK、Codex app-server 和真实 QQ 环境的反馈调整，但不能把真实链路替换为 mock。
>
> **For agentic workers:** 实施时按阶段推进，每个阶段先形成可运行结果再进入下一阶段。不要在 Demo 跑通前扩展成通用平台。

**Goal:** 在真实 QQ 群中，由 HuanLink 通过标准 A2A v1.0 协议异步调用 Codex，允许 Codex 在独立 `spike/demo-v0` 分支执行真实代码任务，并在完成后由 MainAgent 结合最新群聊上下文返回结果。

**Architecture:** HuanLink 负责 QQ 群聊入口、MainAgent、AgentCall、异步回流和最终回复；独立的 Codex A2A Adapter 对外提供标准 A2A Server，对内通过 stdio 驱动官方 `codex app-server`。两者只通过 A2A 协议通信，不共享 Codex 内部类型。这里的集成边界是 app-server 协议，不是 Codex CLI 终端界面或 Codex 桌面应用 UI。

**Tech Stack:** TypeScript/Node.js、pnpm workspace、OpenAI Agents JS、A2A Protocol v1.0、`@a2a-js/sdk@1.0.0-beta.0`、官方 `codex app-server`、真实 QQ、LLBot/NapCat 共用的 OneBot 兼容接口与协议。

---

## 1. Demo 要证明什么

这次 Demo 的重点不是证明“机器人能在群里回复”，而是验证下面这个当前不确定性最高的链路：

```text
现有 Agent 产品
-> 经过独立 A2A Adapter
-> 加入 HuanLink 的 Agent 协作网络
-> 被 MainAgent 异步调度
-> 将执行结果重新带回真实群聊
```

只要 Codex 能通过这条链路完成真实代码任务，HuanLink 的核心方向就成立：

> HuanLink 是面向群聊入口的 A2A Agent Orchestrator / Gateway，而不是另一个自研通用 Agent Loop。

## 2. 最终演示场景

用户在真实 QQ 群中发送：

```text
@HuanLink 让 Codex 在 HuanLink 项目里完成一个明确的小型代码任务
```

系统执行：

```text
QQ 消息
-> HuanLink Channel Adapter
-> MainAgent 理解任务
-> 发起 AgentCall
-> HuanLink A2A Client 调用 Codex Agent Card 声明的能力
-> Codex A2A Adapter 创建标准 A2A Task
-> Adapter 启动或复用 codex app-server
-> Codex 在 spike/demo-v0 分支执行真实代码修改
-> A2A Task 持续产生状态和 Artifact
-> HuanLink 立即向群里返回 taskId/已受理状态
-> Task 完成后触发 MainAgent 新 turn
-> MainAgent 读取当时最新群聊上下文
-> 将结果摘要回复到真实 QQ 群
```

最终结果至少包含：

- A2A `taskId`
- 成功、失败或取消状态
- Codex 的结果摘要
- 变更文件列表
- diff 摘要或可定位的 Artifact
- HuanLink 发回 QQ 群的最终消息

## 3. 进程与模块边界

```text
apps/server
  HuanLink 主服务
  - QQ ingress/egress
  - MainAgent
  - AgentCall
  - A2A Client
  - task completion re-entry
  - minimal EventLog

apps/codex-a2a-adapter
  独立进程
  - Agent Card
  - A2A v1.0 Server
  - A2A Task 生命周期
  - Codex app-server client
  - A2A <-> Codex 事件映射

codex app-server
  官方进程
  - thread / turn
  - coding agent runtime
  - command/file/tool items
  - approval / interrupt
  - streamed events
```

硬边界：

- HuanLink 不直接调用 Codex app-server。
- Codex Adapter 不读取 QQ 群聊状态。
- Codex app-server 不感知 A2A 和 QQ。
- `@a2a-js/sdk` 类型限制在 A2A integration 和 Adapter 内部。
- HuanLink core 使用自己的 `AgentCall` 语义，通过 integration 映射到 A2A。

## 4. A2A v1.0 合规范围

P0 必须实现：

- 标准 Agent Card 发现。
- 明确声明 A2A Protocol v1.0。
- 至少一种标准 transport，首选 JSON-RPC over HTTP。
- `SendMessage`：提交任务并返回 `Task`。
- `GetTask`：查询当前状态。
- `SubscribeToTask` 或标准流式消息：接收异步状态更新。
- `CancelTask`：取消正在执行的 Codex turn。
- 标准 Task 状态转换。
- `Artifact` / artifact update：返回代码任务产物。
- 使用 A2A Inspector 或 TCK 做兼容性验证。

P0 可以暂缓：

- Push Notification/WebHook。
- gRPC 和多 transport 同时支持。
- Extended Agent Card。
- 多租户。
- 远端公网部署。
- 完整 OAuth/OIDC。
- 跨进程持久化 TaskStore。

第一版 Adapter 只绑定本机地址。无认证模式必须在 Agent Card 中如实声明，不能实现私有鉴权后仍声称标准兼容。

## 5. Codex app-server 映射

| A2A 概念 | Codex app-server |
| --- | --- |
| Agent Card skill | Codex coding capability |
| A2A context | Codex thread |
| A2A Task | Codex turn |
| SendMessage | `thread/start`/`thread/resume` + `turn/start` |
| working | `turn/started` 和 item progress |
| Artifact | agent message、变更文件、diff/执行摘要 |
| completed/failed | `turn/completed` final status |
| CancelTask | `turn/interrupt` |
| input-required | approval 或需要用户补充输入 |

Adapter 维护最小关联关系：

```text
a2aTaskId
<-> contextId
<-> codexThreadId
<-> codexTurnId
<-> workspace / spike/demo-v0 branch
```

Codex app-server 通信优先使用默认 stdio JSONL。当前不依赖其仍处于实验状态的 WebSocket transport。Adapter 启动固定版本的官方 `codex` 可执行程序并使用 app-server 协议，不解析 Codex CLI 终端输出，也不自动化 Codex 桌面应用 UI。

## 6. 分支和代码修改边界

Demo 开发和 Codex 实际操作都在独立 `spike/demo-v0` 分支进行：

```text
main
  -> spike/demo-v0
```

约束：

- Codex 只允许操作配置好的 HuanLink workspace。
- 启动任务前校验当前分支为 `spike/demo-v0`。
- 不允许任务切换到 `main`。
- 不自动 merge 到 `main`。
- 不自动 push。
- 第一版不要求 Codex 自动 commit。
- 最终结果必须报告实际修改文件和 diff 状态。

如果后续并发执行多个 Codex Task，再演进为每任务独立 worktree；首个 Demo 不提前实现该复杂度。

## 7. 实施阶段

### Phase 0：建立 Demo 运行基线

目标：

- 创建并切换到独立 `spike/demo-v0` 分支。
- 确认现有 pnpm workspace、OpenAI Agents JS integration 和测试基线可运行。
- 确认服务器已安装官方 `codex` 可执行程序、ChatGPT 登录可用，并能启动 `codex app-server`。
- 记录 Codex 和 `@a2a-js/sdk` 的精确版本；后续安装时不使用浮动 `next`。

完成标准：

- `corepack pnpm typecheck`
- `corepack pnpm test`
- `corepack pnpm build`
- `codex app-server` 可以启动并完成 initialize handshake。

Phase 0 实际核验记录（2026-07-11）：

- 当前分支为 `spike/demo-v0`，基线提交为 `95414e88d5c57aaf1b6d63cf58fd9018d6250ba9`。
- pnpm workspace 和 OpenAI Agents JS integration 存在；typecheck、14 个测试文件中的 68 个测试以及 build 均通过。
- 当前使用的官方 Codex 可执行程序来自 `codex-cli 0.142.5`，`codex login status` 确认为 ChatGPT 登录。
- `codex app-server` 已通过 stdio JSONL 完成 `initialize` / `initialized` 握手；初始化后的脱敏 `account/read` 成功，进程正常退出。Phase 0 未发起模型 turn。
- 仓库尚未声明、锁定或安装 `@a2a-js/sdk`；核验时 npm `next` 精确解析为 `1.0.0-beta.0`，Phase 1 使用该精确版本。
- 核验结束时工作树干净；没有 commit、merge 或 push。

### Phase 1：先验证标准 A2A Server

目标：

- 新增独立 `apps/codex-a2a-adapter`。
- 使用固定版本 `@a2a-js/sdk@1.0.0-beta.0` 的官方 TypeScript A2A v1 SDK。
- 暴露 Agent Card。
- 实现最小 Task 创建、查询、订阅和取消。
- 暂时用最薄执行器验证协议，不接入 HuanLink。

这一阶段允许执行器返回固定内容，因为它只用于验证标准协议外壳；该固定执行器不能进入最终 Demo。

完成标准：

- 官方 A2A Client 可以从 Agent Card 自动发现 Adapter。
- A2A Inspector/TCK 能识别服务。
- Task 状态能从 submitted 进入 working，再进入终态。
- 取消操作产生标准 canceled 状态。

Phase 1 实际核验记录（2026-07-11）：

- 已新增独立 `apps/codex-a2a-adapter`，精确安装并锁定 `@a2a-js/sdk@1.0.0-beta.0`；该 app 未依赖 HuanLink core、Codex app-server 或 QQ 链路。
- Adapter 只声明 A2A v1.0 JSON-RPC interface，通过标准 `/.well-known/agent-card.json` 暴露 Agent Card；官方 `ClientFactory.createFromUrl(...)` 可以自动发现并协商到 `1.0`。
- 黑盒测试使用官方 A2A Client 验证了 Task 创建、查询、流式 `submitted -> working -> completed`、artifact 持久化、`SubscribeToTask` 和 `CancelTask -> canceled`。包级共 3 个测试文件、14 个测试通过，typecheck 和 build 通过。
- 编译后的独立进程已通过官方 Client 外部 smoke：初始状态为 `TASK_STATE_SUBMITTED`，取消返回并持久化为 `TASK_STATE_CANCELED`。
- 官方 A2A TCK `5996b79f9cefa6fc390980e383e358a66fb9e49e` 已能发现和测试服务。针对 Agent Card、数据模型、错误处理、transport behavior 和 JSON-RPC 的协议核验为 43 passed、23 skipped、6 deselected，进程退出码为 0。完整 JSON-RPC MUST 运行结果为 68 passed、5 failed、162 skipped、30 deselected；Agent Card 6/6，以及 v1 方法名、错误映射、数据模型和 SSE envelope 等协议检查通过。5 个 pytest 失败来自 Phase 1 固定执行器不按 TCK 专用 messageId 生成其指定的多种 artifact 或直接 Message，不是 Agent Card 或 wire protocol 识别失败；本阶段不为刷 TCK 扩写临时场景业务，也不声称 full MUST 100% 通过。
- 固定执行器仍明确只属于 Phase 1 协议外壳；Phase 2 必须用真实 Codex app-server executor 替换。Phase 1 未 merge、未 push，也未进入 Phase 2。

### Phase 2：接入真实 Codex app-server

目标：

- Adapter 启动和管理官方 `codex app-server` 子进程。
- 完成 initialize/initialized handshake。
- 把 A2A 请求映射成 Codex thread/turn。
- 把 Codex 通知映射成 A2A status/artifact update。
- 把 A2A 取消映射成 Codex turn interrupt。

真实任务选择一个范围小、结果容易验证的 HuanLink 代码修改，不使用 mock model 或 fake executor。

完成标准：

- 通过标准 A2A Client 提交任务。
- 立即获得标准 Task。
- Codex 在 `spike/demo-v0` 分支真实修改文件。
- 客户端能观察进度和终态。
- 最终 Artifact 能说明修改内容。

### Phase 3：HuanLink 原生接入 A2A

目标：

- 在 HuanLink 中增加 A2A Client integration。
- 通过 Agent Card 做能力发现，不硬编码 Codex 私有接口。
- 将 MainAgent 的 Codex 委派能力暴露为异步 AgentCall。
- AgentCall 提交后立即返回 taskId，不阻塞 MainAgent run。
- 后台订阅 A2A Task 状态。

完成标准：

- MainAgent 能决定调用 Codex。
- 首次 run 可以快速结束并返回已受理状态。
- HuanLink 能追踪 `AgentCallId <-> A2A taskId`。
- Task 完成时能触发新的 MainAgent turn。

### Phase 4：接入真实 QQ 群

目标：

- 对接服务器现有 LLBot 或 NapCat 网关暴露的共用 OneBot 兼容接口与协议，增加最薄的 Channel Adapter；不依赖任一网关的私有接口。
- 只支持明确 `@HuanLink` 或明确命令触发。
- 把任务受理和任务完成结果发回原群。
- Task 完成后的新 turn 读取当时最新群聊消息。

暂不实现智能插话、复杂 buffer 和完整 ResponseGate。第一版以明确触发保证链路可控，但不能用 CLI 或测试输入替代 QQ。

完成标准：

- QQ 群中的真实消息触发 MainAgent。
- 群内能收到任务受理消息和 taskId。
- Codex 完成后，群内能收到结合最新上下文生成的最终结果。
- Codex 执行期间，QQ 群消息处理不被阻塞。

### Phase 5：真实闭环验收

使用一个真实、可验证的小型代码任务执行完整演示：

1. 在 QQ 群明确要求 HuanLink 调用 Codex。
2. HuanLink 通过 Agent Card 选择 Codex 能力。
3. A2A Task 创建成功。
4. 群里立即收到受理信息。
5. Codex 在 `spike/demo-v0` 分支完成代码修改。
6. A2A 返回状态与 Artifact。
7. HuanLink 唤醒 MainAgent。
8. MainAgent 结合最新群聊上下文回复。
9. 人工检查实际 diff 与群内摘要一致。

## 8. Demo 阶段最小 EventLog

EventLog 只服务于看懂真实链路，不在 Demo 前设计完整审计系统。

至少记录：

```text
channel.message_received
main_agent.run_started
agent_call.created
a2a.task_submitted
a2a.task_status_changed
codex.turn_started
codex.turn_completed
agent_call.completed
main_agent.reentered
channel.reply_sent
```

每条事件至少能够关联：

```text
groupId
messageId
agentCallId
a2aTaskId
codexThreadId
codexTurnId
```

流式 token、每个 Codex delta 和完整模型上下文不进入第一版 EventLog。

## 9. 测试和验证策略

测试按风险排序：

1. **A2A 合规测试**
   - Agent Card 可发现。
   - 官方 Client 可调用。
   - Inspector/TCK 通过计划采用的能力集。

2. **Codex 映射测试**
   - task/thread/turn ID 关联正确。
   - Codex completed/failed/interrupted 能映射到 A2A 终态。
   - Artifact 不丢失最终摘要。

3. **HuanLink orchestration 测试**
   - AgentCall 立即返回，不等待 Codex 完成。
   - 完成事件只触发一次 MainAgent re-entry。
   - re-entry 使用最新群聊上下文。

4. **真实端到端验证**
   - 真实 QQ。
   - 真实 MainAgent 模型。
   - 真实 A2A HTTP 通信。
   - 真实 Codex app-server。
   - 真实代码修改。

单元测试通过不能代替最终真实端到端验收。

## 10. 主要风险与控制方式

### A2A TypeScript SDK v1 仍为 alpha

- 固定精确版本，不使用浮动 `next`。
- SDK 类型限制在 integration 内。
- 以 A2A v1.0 规范和 TCK 结果为准，不以 SDK 内部实现为项目合同。

### Codex app-server 协议随版本变化

- 固定 Demo 使用的 Codex 版本。
- 从该版本生成 TypeScript/JSON Schema。
- App-server client 独立封装，不让协议类型扩散到 A2A 层。

### 任务完成后重复唤醒 MainAgent

- 使用 A2A taskId 和终态做幂等判断。
- 同一终态只生成一次 completion event。

### Codex 修改范围失控

- 限制 workspace。
- 强制 `spike/demo-v0` 分支。
- 不自动 commit、merge 或 push。
- 最终人工检查 diff。

### QQ 或模型暂时不可用

- 可以分别运行 A2A/Codex 集成测试定位故障。
- 最终 Demo 仍必须回到真实 QQ 和真实模型，不能以局部测试宣告完成。

## 11. 明确非目标

首个 Demo 不实现：

- 完整群聊智能插话。
- 动态 buffer 算法。
- 多垂类 Agent 路由。
- 多个并行 Codex workspace。
- 自动 merge/push。
- 完整 approval center。
- Task 数据库持久化。
- Push Notification。
- 完整 Replay UI。
- 完整远端 A2A 鉴权体系。
- Claude Code/Gemini CLI Adapter。

这些能力只能在真实 Demo 暴露出对应痛点后进入后续计划。

## 12. Demo 完成定义

只有同时满足下面条件，才能称为 Demo 跑通：

- [ ] 从真实 QQ 群发起任务。
- [ ] HuanLink 使用真实 MainAgent 判断并发起 AgentCall。
- [ ] HuanLink 与 Codex Adapter 之间使用标准 A2A v1.0。
- [ ] Adapter 通过官方 Codex app-server 执行任务。
- [ ] Codex 在 `spike/demo-v0` 分支产生真实代码修改。
- [ ] AgentCall 异步执行且不阻塞群聊。
- [ ] 群里先收到 taskId，再收到最终结果。
- [ ] 最终结果来自 A2A Task/Artifact，而不是旁路读取。
- [ ] A2A Inspector/TCK 验证所声明的能力。
- [ ] 人工核对代码 diff 与群聊回复一致。

## 13. Demo 后再决定的优化

Demo 完成后，用实际运行结果回答：

- A2A TaskStore 是否需要持久化。
- Streaming、Subscribe 和 Push Notification 哪种更适合长任务。
- Codex approval 如何回流到群聊。
- 单群多个任务如何并发。
- 是否需要每任务独立 worktree。
- EventLog 应记录到什么粒度。
- MainAgent 如何选择多个 A2A Agent。
- Agent Card 是否需要缓存和健康检查。
- A2A Adapter 是否拆成独立仓库。

这些问题不再通过提前猜测决定，而由真实 Demo 的痛点决定。
