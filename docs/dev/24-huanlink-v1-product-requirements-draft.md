# HuanLink v1.0 产品需求草稿

> **状态：草稿。** 本文只记录当前已经形成的产品方向，不是最终架构规范。
>
> `23-a2a-first-real-demo-plan.md` 仍是当前 Demo 的主计划。本文不会自动扩大 Phase 3～Phase 5 的实现和验收边界。

## 1. 产品定位

HuanLink v1.0 面向群聊中的多 Agent 协作：MainAgent 保持原会话响应，长任务在后台执行，完成后结合最新会话上下文回到原会话。

v1.0 先形成可用的本地单用户产品能力，不提前建设完整权限平台、多租户系统或工业化任务基础设施。优先验证真实 Channel、真实 MainAgent、标准 A2A 和真实外部 Agent 的协作体验。

## 2. Channel 与会话

- 第一条真实 Channel 使用 QQ，并对接 LLBot/NapCat 共用的 OneBot 11 兼容接口。
- 先适配 WebSocket；HTTP 作为后续 Transport，不改变上层消息语义。
- 第一版只响应明确 `@HuanLink` 或明确命令。
- 后台任务受理和终态结果都必须回到原会话。
- 任务完成时读取最新会话上下文，再触发一次新的 MainAgent turn。

## 3. Tool 与后台任务

### 3.1 三类执行方式

HuanLink 不把所有 Tool 永久改成后台执行，而是按工作性质区分：

| 类型 | 适用场景 | 执行方式 |
|---|---|---|
| 普通 Tool | 计算、读取少量信息等快速操作 | 当前 MainAgent turn 直接等待结果 |
| Task-backed Tool | 部署、下载、等待 CI 等单一长操作 | 通过统一任务服务选择后台或等待 |
| 子 Agent Task | 查日志、分析、修改、测试等多步自主工作 | 独立 Agent thread 在后台持有上下文和 Tool Loop |

有前后依赖的步骤允许在子 Agent 内顺序等待；这种等待不能阻塞 MainAgent 和其他会话。互不依赖的 Tool 可以由所属 Agent 并行调用。

### 3.2 调用模式

Task-backed Tool 支持统一调用模式：

```ts
executionMode: "async" | "blocking"
```

- `async`：创建任务并快速返回 `accepted + taskId`；MainAgent 看到回执后继续当前 turn。任务进入终态后，再触发新的 MainAgent turn。
- `blocking`：创建同样的任务，但当前 MainAgent turn 等到终态并直接使用最终结果。它不能阻塞服务进程、其他会话或其他后台任务。
- `blocking` 的终态只交给当前 turn 消费，不再额外触发终态回流；`async` 才在终态触发新的 turn。
- 每个支持该能力的 Task-backed Tool 声明默认模式。长耗时 Tool 默认 `async`，快速普通 Tool 继续直接等待。
- 用户明确要求“等待完成后再继续”时，MainAgent 可以覆盖 Tool 的默认模式。
- v1.0 不根据预计耗时自动猜测模式。

`executionMode` 是 HuanLink 的调用控制信息，不属于具体 Executor 的业务参数。未发布旧值 `background/wait` 不保留兼容。

### 3.3 统一任务生命周期

HuanLink 需要一个协议无关的任务生命周期能力，至少负责：

- 创建并返回统一的 HuanLink `taskId`。
- 记录 `submitted / working / input-required / completed / failed / canceled` 等必要状态。
- 支持按 `taskId` 查询和取消。
- 接收进度、结果和错误，并保证终态只回流一次。
- 保存原 `sessionId`，将终态重新路由到原会话。
- 区分 HuanLink `taskId` 与 A2A 等外部系统的 `externalTaskId`；产品默认只展示 HuanLink `taskId`。

Demo 和初始 v1.0 可以使用内存状态，不要求服务重启后恢复。

### 3.4 终态回流与连续任务

- `async` 任务进入终态后，HuanLink 将任务结果和最新会话上下文一起送入新的 MainAgent turn，并把本轮结果发回原会话。
- 如果用户已经在上下文中明确、无歧义地授权了下一步，MainAgent 可以在该终态 turn 中继续提交新的 AgentCall；续派固定使用 `async`，沿用同一 `sessionId/contextId`，但必须产生新的 HuanLink taskId 和外部 taskId。
- 第一步完成消息必须同时报告本步结果；如果已续派，还必须报告新任务的受理 ID。后续每个任务进入终态时继续独立回到原会话。
- 如果下一步缺少实质性选择或授权，MainAgent 应询问用户，不能自行补全需求。
- 已经受理或完成的任务不再视为待执行下一步；MainAgent 不能重复提交已完成任务，也不能发明后续任务。
- v1.0 先由 MainAgent 结合完整上下文判断是否续派，不建设持久化工作流图、授权消费状态机或通用编排 DSL。

### 3.5 Executor 边界

统一任务服务管理生命周期，Executor 只负责具体执行：

- `AtomicTaskExecutor`：单个长耗时操作。
- `AgentTaskExecutor`：运行拥有独立上下文和 Tool Loop 的子 Agent。
- 当前真实 Codex A2A 链路是第一个 `AgentTaskExecutor`：HuanLink 委派完整目标，Codex thread 自己完成读取、修改和验证。
- 当前 Demo 不新增通用本地 Worker Agent；只保留后续接入本地或其他远端 Agent 的清晰边界。

不采用一个接收任意 `toolName + args` 的万能异步 Tool，也不为了本能力扩展旧的自建 AgentLoop/ToolGateway。

## 4. Codex A2A Adapter

Codex A2A Adapter 将真实 Codex app-server 适配为标准 A2A Agent。A2A 负责标准通信，Adapter 负责项目、工作目录、模型和本地运行约束等业务能力。

### 4.1 项目选择

- 用户可以从已注册的本地项目中选择目标项目。
- 每个项目使用稳定的 `projectId`，映射到本地 workspace 和分支规则。
- A2A 任务只传 `projectId`，不接受任意绝对路径作为任务目标。
- 项目注册方式暂未冻结，优先考虑本机界面选择 Git 项目并保存本地配置。

### 4.2 工作目录选择

- 用户可以选择项目内相对目录作为可选的 `workingDirectory`。
- `workingDirectory` 是工作焦点，不是硬权限范围。
- Codex 必要时可以修改同一项目中的其他目录，例如根配置、测试或依赖文件。
- Adapter 必须完整报告实际修改文件和 diff，不能把工作焦点描述成实际修改边界。
- Adapter 只做基础路径检查：目录必须存在、位于目标项目内部，并且不能通过路径解析逃逸项目。

### 4.3 模型选择

- 用户选择真实的 `modelId`，任务传输中只写模型 ID。
- 产品界面默认直接显示模型原名。
- 用户可以为模型配置本地别名；存在别名时显示别名，否则显示模型原名。
- 别名只属于展示配置，不改变真实模型身份，也不参与 A2A 任务判断。

```text
displayName = alias ?? modelId
```

### 4.4 自动化结果

- 保留标准 A2A 任务提交、订阅、查询、取消、终态和 Artifact。
- 支持通过 `contextId` 复用 Codex thread，承载后续要求和纠正。
- 任务结果应包含摘要、实际变更文件、diff、执行过的验证和自动 Review 结论。
- 自动 Review 负责发现不合理修改和质量问题，但不替代 Adapter 的基础路径与运行约束。

### 4.5 最小机械兜底

- 任务只能操作已注册项目。
- 分支规则由项目配置决定，任务不能任意切换分支。
- 不自动 commit、merge 或 push。
- 同一 workspace 不允许多个修改任务同时执行；采用拒绝还是简单队列后续再定。
- 本地版本默认仍只监听 loopback 地址。

## 5. A2A 目标信息

目标信息可以放入标准 A2A Message 的 metadata 或结构化 Part，不新增自定义传输协议。自然语言任务仍作为标准文本内容传递。

```json
{
  "projectId": "huanlink",
  "workingDirectory": "apps/codex-a2a-adapter",
  "modelId": "gpt-5.4-mini"
}
```

## 6. v1.0 暂不建设

- `scopePaths`、文件级 ACL 和“修改焦点目录外文件即失败”。
- 每任务独立 worktree。
- 完整审批中心和权限回流。
- 多租户、远程公网鉴权和组织级策略。
- 服务重启后的任务与 thread 持久化恢复。
- 模型档位、自动路由、成本策略和故障转移。
- 复杂并发调度和持久化任务队列。
- 自动 commit、push 或 merge。
- 通用本地 Worker Agent 和递归创建子 Agent。

## 7. 后续需要验证

- 项目注册使用本机界面、配置文件还是两者并存。
- 项目注册信息和模型别名保存在哪里。
- 可选模型列表由 Codex app-server 动态提供，还是由 Adapter 配置维护。
- 自动 Review 在 app-server 上采用什么稳定调用方式。
- 同一 workspace 已有任务时采用立即拒绝还是简单排队。
- 哪些 Task-backed Tool 允许用户覆盖默认 `executionMode`。
