# HuanLink Core 自研能力保留 / 删除 / 适配层调查

调查日期：2026-07-09

## 结论先行

当前 `packages/core/src` 里最应该收缩的是旧路线下的 **自研通用 Agent Loop**，不是所有 core 代码。

HuanLink 已经转向：

```text
HuanLink owns outer orchestration
OpenAI Agents JS owns inner single Agent Run
```

所以建议：

- 删除或废弃 `AgentLoop`、`ModelClient`、`ToolGateway`、`PolicyEngine` 这条自研 inner loop 链路。
- 保留 `AgentRuntime` 这种框架无关的单次 run 适配合同。
- 保留并改造 `EventLog / Replay`，但事件语义从 `agent_loop/tool_gateway` 改成 HuanLink 外层事件。
- 保留 `RuntimeLogger / RuntimeConfig / ids / errors / SimpleLruMap` 这类外层基础设施。
- `packages/integrations/openai-agents` 是正确方向，但当前只包装了文本 `finalOutput`，P0 需要继续扩成真正的 `LocalAgentRuntimeAdapter`。

一句话：

```text
不要再维护 HuanLink 自己的通用 run loop；
保留 HuanLink 对“何时 run、为什么 run、异步任务如何回流、事件如何落盘”的控制权。
```

## 依据范围

本报告只基于当前本地仓库和本地参考源码：

- `docs/dev/20-huaness-p0-boundary-refinement.md`
- `docs/dev/21-framework-selection-for-huaness-p0.md`
- `docs/dev/19-openai-agents-js-architecture-analysis.md`
- `packages/core/src`
- `packages/integrations/openai-agents`
- `references/openai-agents-js`

当前本地 `@openai/agents` 参考版本为 `0.12.0`，见：

- `references/openai-agents-js/packages/agents/package.json`
- `references/openai-agents-js/packages/agents-core/package.json`

## 1. OpenAI Agents JS 已提供的能力

| 能力 | 本地证据 | 判断 | 对 HuanLink 的含义 |
| --- | --- | --- | --- |
| Agent definition | `references/openai-agents-js/packages/agents-core/src/agent.ts` | 官方主路径 | HuanLink 不需要自研通用 Agent 定义模型。 |
| Agent run / Runner | `references/openai-agents-js/packages/agents-core/src/run.ts` 的 `Runner` | 官方主路径 | 单次 MainAgent / SpecialistAgent run 应交给它。 |
| Run loop | `references/openai-agents-js/packages/agents-core/src/runner/runLoop.ts`、`turnPreparation.ts`、`turnResolution.ts` | 内部实现完整 | HuanLink 不应继续维护 `packages/core/src/loop/agent-loop.ts`。 |
| Tool loop | `references/openai-agents-js/packages/agents-core/src/tool.ts`、`runner/toolExecution.ts` | 官方核心能力 | 普通同步工具应优先用框架工具系统。 |
| Tool approval / interrupt | `tool.ts` 里的 `needsApproval`，`runner/toolExecution.ts`，`result.ts` 的 `interruptions` | 成熟能力 | 普通工具审批可走框架；HuanLink 仍要记录外层审批事件。 |
| Session | `references/openai-agents-js/packages/agents-core/src/memory/session.ts` | 可插拔接口 | 内层 agent history 可用框架 session；群聊 buffer/context 不应交给它。 |
| RunState resume | `references/openai-agents-js/packages/agents-core/src/runState.ts`，当前 schema `1.13` | 版本化、完成度高 | approval/resume 可借框架；不要把它当 HuanLink 的唯一恢复事实源。 |
| Streaming | `references/openai-agents-js/packages/agents-core/src/events.ts`、`result.ts`、`runner/streaming.ts` | 官方主路径 | 可直接接入 HuanLink outbound streaming/event bridge。 |
| Handoff | `references/openai-agents-js/packages/agents-core/src/handoff.ts`、`extensions/handoffPrompt.ts` | 官方主路径 | 本地 agent 内部 handoff 可用；HuanLink 的 A2A/AgentCall Router 仍应自有。 |
| Agents as tools | `references/openai-agents-js/packages/agents-core/src/agentTool*.ts`、`examples/agent-patterns/agents-as-tools.ts` | 官方模式 | P0 本地垂类 Agent 可优先包成 tool 或 adapter，但异步 AgentCall 不要被等同为普通 tool。 |
| Guardrails | `references/openai-agents-js/packages/agents-core/src/guardrail.ts`、`runner/guardrails.ts` | 官方主路径 | 可用于内层输入/输出保护；外层 ResponseGate 仍归 HuanLink。 |
| Tracing | `references/openai-agents-js/packages/agents-core/src/tracing/*`、`runner/tracing.ts` | 官方主路径 | 可采集为 debug 线索，但不能替代 HuanLink JSONL EventLog。 |
| Replay/debug | `RunResult.history`、`RunResult.newItems`、`RunState`、tracing | 有结果和状态，不是独立 EventLog | HuanLink 仍需自己的外层 replay 事实源。 |
| AI SDK bridge | `references/openai-agents-js/packages/agents-extensions/src/ai-sdk`、`docs/src/content/docs/extensions/ai-sdk.mdx` | 官方 extension | 后续多 provider 可从 OpenAI Agents JS 的 Model 层接 Vercel AI SDK。 |

## 2. 完成度和可靠性判断

### 可以作为 P0 生产依赖的主能力

这些能力在包结构、文档、示例和源码里都是主路径：

- `Agent`
- `Runner.run(...)`
- function tools
- streaming result
- handoff
- session interface
- tracing
- approval / interruption / resume

HuanLink 可以依赖这些能力，但要通过自己的 adapter 包起来。

### 可以用，但不要让它拥有 HuanLink 主权

这些能力很强，但不应成为 HuanLink 外层事实源：

- `RunState`
- framework session
- framework tracing
- framework handoff
- `agent.asTool()`

原因是它们服务的是 **一次或一组 SDK run 内部的状态机**，而 HuanLink 还要表达：

- 群聊消息何时 flush
- Gate 为什么放行或等待
- AsyncGateway 任务状态
- AgentCall 是否过期
- task 完成后为什么唤醒 MainAgent
- 最终是否发送群聊回复

这些不是 OpenAI Agents JS 的业务语义。

### 需要谨慎的能力

- AI SDK bridge：它是官方 extension，但属于 provider/model 适配层，不是整个 runtime 的替代。
- sandbox / shell / apply_patch：OpenAI Agents JS 有相关能力，但 HuanLink 当前 P0 是群聊 orchestrator，不应过早接重型 sandbox。
- replay/debug：框架有 `history/newItems/tracing/RunState`，但没有 HuanLink 所需的 JSONL-first run archive。

## 3. 当前 HuanLink core 模块分类

### 3.1 保留

| 文件或模块 | 建议 | 理由 |
| --- | --- | --- |
| `packages/core/src/runtime/agent-runtime.ts` | 保留并扩展 | 这是正确的框架无关 adapter 合同，应该成为 OpenAI Agents JS、未来其他框架、本地/远端 AgentCall 的边界。 |
| `packages/integrations/openai-agents/src/openai-agents-runtime.ts` | 保留并增强 | 已经把 `@openai/agents` 包到 core `AgentRuntime` 后面，方向正确。 |
| `packages/core/src/events/event-log.ts` | 保留 | HuanLink 外层需要自己的事件写入/读取边界。 |
| `packages/core/src/events/jsonl-event-log.ts` | 保留 | JSONL 仍适合作为 P0 source of truth。 |
| `packages/core/src/events/in-memory-event-log.ts` | 保留 | 测试和 adapter spike 仍有价值。 |
| `packages/core/src/events/event-file-paths.ts` | 保留 | run 文件路径和 path guard 属于 HuanLink 外层存储能力。 |
| `packages/core/src/events/event-json-codec.ts` | 保留但后续改 schema | codec 有价值，但当前只校验旧 agent-loop 事件集合。 |
| `packages/core/src/replay/*` | 保留但重写语义 | Replay 是 HuanLink 自己的核心能力；只是当前 RunView 仍围绕旧 tool loop。 |
| `packages/core/src/logging/*` | 保留 | 结构化 runtime log 与 agent 框架不冲突。 |
| `packages/core/src/runtime/runtime-config.ts` | 保留但删除 `agent.defaultMaxSteps` | 配置层有价值，但旧 loop 的 maxSteps 不应继续是 core 默认配置。 |
| `packages/core/src/shared/*` | 保留 | ids、错误规整、LRU 都是基础工具。 |

### 3.2 删除

| 文件或模块 | 建议 | 理由 |
| --- | --- | --- |
| `packages/core/src/loop/agent-loop.ts` | 删除 | 这是自研通用 loop，和 OpenAI Agents JS `Runner`/run loop 重复。 |
| `packages/core/src/loop/types.ts` | 删除或迁移到 adapter 输入 | `AgentRunInput/AgentRunResult` 属于旧 loop 语义，和新的 `AgentRuntimeInput/Result` 重叠。 |
| `packages/core/src/model/types.ts` | 删除 | `ModelClient/ModelMessage/ModelResponse` 是自研模型层，和 OpenAI Agents JS `Model/ModelProvider`、Vercel AI SDK provider 层重复。 |
| `packages/core/src/model/fake-model-client.ts` | 删除 | 只服务旧 fake loop。 |
| `packages/core/src/tools/tool-gateway.ts` | 删除 | 普通 tool loop、tool execution、approval、timeout 应交给 OpenAI Agents JS。 |
| `packages/core/src/tools/echo-tool.ts` | 删除 | 旧 mock demo 工具。 |
| `packages/core/src/tools/types.ts` | 删除或仅保留为外层 AsyncGateway 新类型 | 当前 `ToolCall/ToolResult/Tool` 是旧 inner loop 类型。 |
| `packages/core/src/policy/allow-policy-engine.ts` | 删除 | 旧 mock policy。 |
| `packages/core/src/policy/types.ts` | 删除或重命名为外层 approval policy | 当前 `PolicyEngine` 用在 `ToolGateway`，和框架 approval/guardrails 重复。 |
| `packages/core/src/demos/mock-agent-run.ts` | 删除或移到 legacy doc | 它演示的是旧自研 loop，不再符合项目方向。 |

删除不是马上机械删除文件，而是先让新 adapter spike 替代测试覆盖后，再按顺序移除导出和测试。

### 3.3 改成适配层

| 文件或模块 | 建议 | 理由 |
| --- | --- | --- |
| `packages/core/src/runtime/agent-runtime.ts` | 改成 `LocalAgentRuntimeAdapter` 风格 | 当前只有 `input -> output`，需要表达 stream、interruptions、usage、framework events、raw run id 等可选字段。 |
| `packages/integrations/openai-agents/src/openai-agents-runtime.ts` | 从文本结果适配器升级为 OpenAI Agents adapter | 当前只要求 `finalOutput` 是 string；下一步应支持 streaming、maxTurns、session、abort、interruptions、run metadata。 |
| `packages/core/src/context/static-context-assembler.ts` | 改成外层 prompt/context builder 或删除 | 框架内部会组装 model input；HuanLink 只应准备“本次 run 输入材料”，而不是自定义 ModelMessage。 |
| `packages/core/src/context/types.ts` | 改成 `AgentRunInputBuilder` / `MainAgentInputAssembler` | P0 仍需要把群聊 buffer、assetId、task result、latest context 组装成框架输入。 |
| `packages/core/src/events/types.ts` | 改成 HuanLink 外层事件 schema | 当前事件类型是 `model.requested/tool.requested/observation.appended`，应转向 `message.received/buffer.flushed/gate.decided/agent_run.started/agent_call.created/task.completed/reply.sent`。 |
| `packages/core/src/replay/create-run-view.ts` | 改成外层 RunView reducer | 当前聚合 tool call；未来应聚合 group turn、AgentCall、AsyncGateway task、reply decision。 |
| `packages/core/src/replay/types.ts` | 改成 outer run / group turn / task view | 当前状态只有 `running/completed/failed/cancelled/max_steps_exceeded`，缺少 `waiting_task/interrupted/skipped_reply` 等外层状态。 |
| `packages/core/src/index.ts` | 清理导出 | 不应继续公开 `AgentLoop/FakeModelClient/ToolGateway/PolicyEngine`。 |

### 3.4 暂缓决定

| 文件或模块 | 建议 | 理由 |
| --- | --- | --- |
| OpenAI Agents JS `Session` 是否由 HuanLink 实现 | 暂缓 | P0 可以先无 session 或用框架 memory session；等群聊上下文策略稳定后再决定。 |
| OpenAI Agents JS `RunState` 是否持久化到 HuanLink EventLog | 暂缓 | approval/resume 时可能需要存 `state.toString()`，但不要过早绑定具体 schema。 |
| 内层 tool approval 是否统一映射到 HuanLink approval center | 暂缓 | P0 可以先用框架 `needsApproval`；P1 再把审批面统一。 |
| `agent.asTool()` vs HuanLink `AsyncGateway AgentCall` | 暂缓 | P0 异步 AgentCall 不应被普通 tool call 吃掉；但同步本地 specialist 可以先用 `asTool()` 做 spike。 |
| OpenAI Agents JS tracing 是否导入 JSONL | 暂缓 | P0 先记录外层事件和关键 SDK result；P1 再考虑 trace/span 映射。 |
| sandbox / shell / apply_patch 工具 | 暂缓 | 当前定位是群聊 orchestrator，先不把安全复杂度拉进来。 |

## 4. 与框架重复的 HuanLink 自研能力

### 4.1 重复度最高：AgentLoop

`packages/core/src/loop/agent-loop.ts` 现在做了：

```text
context assemble
-> modelClient.complete
-> parse toolCalls
-> toolGateway.execute
-> append tool observation
-> repeat until final answer / maxSteps / cancel / error
```

这正是 OpenAI Agents JS 的 `Runner` 和内部 run loop 已经提供的东西。

保留它会带来两个坏处：

- HuanLink 需要维护一套不如框架成熟的 parallel runtime。
- 后续工具、approval、streaming、session、handoff 都会出现两套语义。

结论：删除。

### 4.2 重复度高：ModelClient

`packages/core/src/model/types.ts` 定义了自己的：

- `ModelMessage`
- `ModelResponse`
- `ModelClient.complete(...)`

但 OpenAI Agents JS 已有：

- `Model`
- `ModelProvider`
- `ModelRequest`
- `ModelResponse`

并且它还有 AI SDK bridge。HuanLink 不应继续维护自己的通用 LLM client 层。

结论：删除。多 provider 交给 OpenAI Agents JS ModelProvider 或 AI SDK bridge。

### 4.3 重复度高：ToolGateway / PolicyEngine

当前 `ToolGateway` 负责：

- tool lookup
- policy decision
- tool execution
- event logging
- error result normalization

OpenAI Agents JS 已经在 `tool.ts` / `runner/toolExecution.ts` 提供：

- function tool
- shell / computer / apply_patch 等工具类型
- async execute
- AbortSignal
- timeout
- input/output guardrails
- `needsApproval`
- function tool concurrency
- tool result normalization
- approval interruption

HuanLink 不应继续自研普通 tool loop。

但注意：HuanLink 的 `AsyncGateway` 不是普通 ToolGateway。它的职责是：

```text
启动长生命周期 AgentCall
-> 立即返回 taskId
-> 后台运行
-> 完成后唤醒 MainAgent 新 turn
```

这个不等同于 OpenAI Agents JS 的普通 tool execution。

结论：

- 当前 `ToolGateway` 删除。
- 新建 `AsyncGateway`，只管异步 AgentCall 生命周期。
- 普通工具交给 OpenAI Agents JS。

## 5. 框架已有但 HuanLink 仍应保留外层抽象的能力

### 5.1 EventLog

OpenAI Agents JS 有：

- `RunResult.history`
- `RunResult.newItems`
- `RunResult.interruptions`
- `StreamedRunResult`
- tracing spans
- `RunState`

但这些都不是 HuanLink 的外层事实源。

HuanLink EventLog 应记录：

- 群聊消息进入
- buffer 刷新
- Gate 决策
- MainAgent run 开始/结束
- MainAgent 是否决定回复
- AgentCall 创建
- task 状态变化
- task 完成后唤醒
- 最终回复发送/跳过
- 框架 run 的摘要、error、usage、interruptions

所以 `EventLog` 要保留，但 schema 要从 inner loop 改成 outer orchestration。

### 5.2 Replay / Debug View

框架可以还原 SDK run 内部过程，但 HuanLink 要 replay 的是群聊编排链路。

例如：

```text
为什么这条群聊消息没有回复？
为什么这个 task 完成后又发了一次 MainAgent turn？
为什么最终没有把结果发回群里？
```

这些问题不能只靠 OpenAI Agents JS tracing 回答。

### 5.3 AgentRuntime adapter

HuanLink 仍需要自己的 adapter 合同，因为未来可能有：

- OpenAI Agents JS local runtime
- 另一个 TS/JS agent 框架
- Python specialist service
- remote A2A agent
- mock runtime

所以 `AgentRuntime` 不应删除，而是应扩成更稳定的 HuanLink-owned boundary。

### 5.4 ResponseGate / Buffer / AsyncGateway / AgentCall

这些能力 OpenAI Agents JS 不负责，也不应该负责。

它们是 HuanLink 区分于普通 agent app 的核心：

- 群聊时序控制
- 是否值得进入 MainAgent
- 长任务不阻塞群聊
- task 完成后用最新上下文再决策
- 本地/远端 agent 调用语义统一

## 6. P0 / P1 / P2 问题和风险

### P0 必须解决

| 问题 | 风险 | 建议 |
| --- | --- | --- |
| core 仍公开旧 `AgentLoop` | 新代码继续误用旧路线 | 先从 `index.ts` 停止公开旧 loop，新增 adapter-first 示例。 |
| `OpenAiAgentsRuntime` 只支持 string finalOutput | 无法表达 streaming、interruptions、metadata | 扩展 `AgentRuntimeResult`，但保持 P0 字段少。 |
| Event schema 还是 inner loop | EventLog 会记录错层级 | 新增 outer event schema，旧 schema 标记 legacy。 |
| `ToolGateway` 和框架 tool loop 重复 | 两套 approval/tool/error 语义 | 普通工具删除自研 gateway，异步 AgentCall 单独建 `AsyncGateway`。 |
| Replay 仍围绕 tool call | 无法解释群聊决策链 | 重写 `RunView` 为 group turn / AgentCall / task 视角。 |

### P1 应该解决

| 问题 | 风险 | 建议 |
| --- | --- | --- |
| 框架 session 与 HuanLink group context 如何分工 | 上下文被重复存储或污染 | HuanLink 管 group context，框架 session 只管单 agent 局部历史。 |
| OpenAI Agents JS interruptions 如何持久化 | approval 后无法恢复 | EventLog 记录 interruption summary，必要时单独保存 `RunState` snapshot。 |
| Streaming 如何映射到 EventLog | JSONL 过细或丢关键过程 | P0 只记 start/end/error/summary，P1 再引入采样或 chunk summary。 |
| AgentCall 与 `agent.asTool()` 的边界 | 异步任务被普通 tool loop 阻塞 | 同步短任务可 asTool；长任务必须走 AsyncGateway。 |
| 框架 tracing 如何接入 debug UI | tracing 与 EventLog 重复 | EventLog 做事实源，tracing 做内层诊断附件。 |

### P2 再考虑

| 问题 | 风险 | 建议 |
| --- | --- | --- |
| 统一 approval center | 过早抽象导致实现变重 | 等真实危险工具和远端 agent 出现后再做。 |
| sandbox / shell / code tools | 安全复杂度高 | 后置到需要服务器执行真实工具时。 |
| 数据库索引 | schema 频繁变化 | 等 EventLog 语义稳定后再建 SQLite 派生索引。 |
| 跨框架 runtime compatibility | 早期抽象过度 | 先适配 OpenAI Agents JS，第二个框架出现后再抽象。 |
| A2A 完整协议 | 设计不稳定 | P0 只做 AgentCall 语义和一个本地 specialist。 |

## 7. 建议的 cleanup 顺序

### Step 1：冻结旧 loop，不再扩展

先在文档和导出层明确：

- `AgentLoop`
- `FakeModelClient`
- `ToolGateway`
- `PolicyEngine`
- `StaticContextAssembler`

都属于 legacy mock runtime，不再作为新开发入口。

### Step 2：先扩 `AgentRuntime` 合同

在删除旧代码前，先让新的 adapter 合同能承载 P0：

```text
runId/sessionId
input
signal
stream optional
final output
interruptions summary
usage/metadata optional
frameworkRunId/frameworkTraceId optional
```

这样后续 OpenAI Agents JS 适配器有位置放数据。

### Step 3：扩 `OpenAiAgentsRuntime`

把当前 `packages/integrations/openai-agents/src/openai-agents-runtime.ts` 从文本 adapter 扩成：

- 支持 `maxTurns`
- 支持 `session`
- 支持 streaming event bridge
- 暴露 `interruptions`
- 把 SDK error 映射成 HuanLink runtime error
- 可选记录 `RunResult.history/newItems` 摘要

### Step 4：新增 outer Event schema

新增 HuanLink 外层事件类型，不要继续沿用旧 `model.requested/tool.requested` 为主语义。

P0 最小事件建议：

```text
message.received
buffer.flushed
gate.decided
agent_run.started
agent_run.completed
agent_run.failed
agent_run.interrupted
agent_call.created
task.state_changed
task.completed
main_agent.woken
reply.sent
reply.skipped
```

### Step 5：重写 replay view

`createRunView` 从 tool-call reducer 改成 group-turn reducer：

```text
group turn
-> gate decision
-> agent run
-> agent call / task
-> wake turn
-> final reply decision
```

### Step 6：移除旧 loop 公开导出

更新 `packages/core/src/index.ts`，停止导出：

- `./loop/agent-loop.js`
- `./loop/types.js`
- `./model/fake-model-client.js`
- `./model/types.js`
- `./tools/tool-gateway.js`
- `./tools/echo-tool.js`
- `./tools/types.js`
- `./policy/allow-policy-engine.js`
- `./policy/types.js`

### Step 7：删除旧测试和 demo

删除或改写这些旧路线测试：

- `packages/core/tests/mock-agent-run.test.ts`
- `packages/core/tests/mock-agent-run-demo.test.ts`
- `packages/core/tests/tool-gateway.test.ts`
- 依赖旧 loop/types/model/tool/policy 的测试

保留并更新：

- EventLog tests
- Replay tests
- Runtime adapter tests
- Config/logger/shared tests

## 8. 最终推荐清单

### 保留

- `AgentRuntime` 合同
- OpenAI Agents JS integration package
- JSONL EventLog
- InMemoryEventLog
- Replay reducer/view，但要改外层语义
- RuntimeConfig，但删旧 agent maxSteps
- RuntimeLogger
- shared utilities

### 删除

- `AgentLoop`
- `ModelClient`
- `FakeModelClient`
- `ToolGateway`
- `Tool` / `ToolCall` / `ToolResult` 旧类型
- `PolicyEngine`
- `AllowPolicyEngine`
- mock agent run demo

### 改成适配层

- `AgentRuntime` -> `LocalAgentRuntimeAdapter`
- `OpenAiAgentsRuntime` -> richer OpenAI Agents adapter
- `ContextAssembler` -> MainAgent input assembler
- `EventLog schema` -> HuanLink outer orchestration event schema
- `Replay RunView` -> group turn / AgentCall / task view

### 暂缓决定

- 框架 session 是否持久化
- `RunState` 是否保存到 HuanLink storage
- tracing 是否导入 JSONL
- `agent.asTool()` 是否作为 P0 specialist agent 入口
- sandbox / shell / apply_patch 工具

## 9. 最短执行建议

下一步最合理的实现顺序是：

```text
先扩 AgentRuntime adapter 合同
-> 扩 OpenAiAgentsRuntime
-> 新增 outer Event schema
-> 用 OpenAI Agents JS 跑一条 MainAgent mock spike
-> 再删旧 AgentLoop/ToolGateway/ModelClient
```

不要先大删代码。先让新链路有可运行替代品，再清旧链路，风险最低。

