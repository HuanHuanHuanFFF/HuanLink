# OpenAI Agents JS 架构分析

调查日期：2026-07-05

资料范围：

- 本地 `references/openai-agents-js` 源码、`docs/`、`examples/`
- 官方文档对照：OpenAI Agents JS 文档与 `AI SDK` extension 文档

本报告只回答你当前最关心的问题：

1. 这个框架从架构上到底是什么。
2. 它轻不轻，runtime 主权在谁手里。
3. 自定义到什么程度，会不会卡住 `Huaness Lite`。
4. 异步工具、长时工具、审批恢复是怎么做的。
5. 能不能接入 Vercel AI SDK 做多 provider / 多模型。
6. 从学习架构和项目落地两方面，应该 Adopt / Adapt / Avoid 什么。

## 一句话结论

`openai-agents-js` 不是“几个 helper”，而是一套已经拥有自己 `run loop / tool execution / session / approval / tracing` 的 agent runtime 框架。

对 `Huaness Lite` 来说，它最适合：

- 学习一套工业化 agent runtime 的边界划分
- 借 `Model` / `ModelProvider` 思路
- 借审批中断恢复语义
- 借它和 Vercel AI SDK 的官方桥接

但**不适合直接把顶层 `Runner` 当成 Huaness Lite 的核心 runtime**。

## 0. 先把边界说清楚

这次分析里有一个很关键的边界：

```txt
“支持自定义”
不等于
“核心 loop 仍然由你掌控”
```

`openai-agents-js` 的 public API 看起来很轻：

- `new Agent(...)`
- `run(agent, input)`

但往里看，真正拥有执行主权的是：

- `Runner`
- `RunState`
- `toolExecution`
- `Session`
- `Tracing`

所以它不是一个“只管模型调用的底层库”，而是一个**已经带运行时立场**的框架。

## 1. 它的最小使用路径是什么

最小使用路径非常直接。

### 1.1 对外入口

对外包装层在：

- `references/openai-agents-js/packages/agents/src/index.ts`

这里做了两件事：

1. 默认安装 `OpenAIProvider`
2. 默认安装 tracing exporter

然后再把 `@openai/agents-core` 的 API 导出给应用层。

这说明 `@openai/agents` 本身已经不是纯类型层，而是带默认 runtime 选择的外壳。

### 1.2 最小 public API

最小 public API 是：

- `Agent`: `references/openai-agents-js/packages/agents-core/src/agent.ts`
- `run()` / `Runner`: `references/openai-agents-js/packages/agents-core/src/run.ts`

最小示例在：

- `references/openai-agents-js/examples/basic/hello-world.ts`

最短心智模型就是：

```txt
定义 Agent
-> 调 run() 或 Runner.run()
-> 框架自己执行 loop
-> 返回 RunResult / StreamedRunResult
```

### 1.3 包分层

从仓库结构看，它大致分四层：

| 层 | 路径 | 作用 |
| --- | --- | --- |
| 对外包装 | `packages/agents` | 默认 OpenAI provider + tracing exporter + core re-export |
| 核心 runtime | `packages/agents-core` | `Agent`、`Runner`、`RunState`、tools、sessions、guardrails、tracing |
| OpenAI provider 实现 | `packages/agents-openai` | 默认 OpenAI 模型/provider 支持 |
| 扩展层 | `packages/agents-extensions` | AI SDK bridge、AI SDK UI、sandbox provider 等 |

所以这个项目不是“一个包”，而是：

```txt
默认 OpenAI runtime 外壳
  -> agent runtime core
    -> provider / extension
```

## 2. 这个框架从架构上到底怎么跑

最重要的文档是：

- `references/openai-agents-js/docs/src/content/docs/guides/running-agents.mdx`

官方在这里把 loop 说得很直接：

1. 调当前 agent 的 model
2. 看 LLM response
3. 如果是 final output 就结束
4. 如果是 handoff 就切 agent
5. 如果是 tool call 就执行工具并把结果回写
6. 继续下一轮，直到完成或到达 `maxTurns`

也就是说，它的核心 loop 是：

```txt
model
-> inspect response
-> final output / handoff / tool call
-> mutate run state
-> next turn
```

这条链路不是你自己写 while-loop，而是框架在 `Runner` 内部接管。

### 2.1 核心运行时对象

#### `Agent`

文件：

- `references/openai-agents-js/packages/agents-core/src/agent.ts`

`Agent` 持有的主要是定义层信息：

- name
- instructions
- model / modelSettings
- tools
- handoffs
- guardrails
- `toolUseBehavior`

它更像“配置好的 agent definition”，不是执行器。

#### `Runner`

文件：

- `references/openai-agents-js/packages/agents-core/src/run.ts`

`Runner` 才是真正的 orchestrator。它统一持有：

- modelProvider
- global modelSettings
- input/output guardrails
- tracing
- sessionInputCallback
- callModelInputFilter
- toolExecution config
- toolNotFoundBehavior
- sandbox config

所以 `Runner` 本质上是：

```txt
全局 run orchestrator + runtime policy holder
```

#### `RunState`

文件：

- `references/openai-agents-js/packages/agents-core/src/runState.ts`

`RunState` 是中断、恢复、继续执行的状态载体。

它不是简陋的“history 数组”，而是一个比较重的 runtime snapshot，负责保存：

- 当前 agent
- 当前 step
- conversation context
- pending approvals
- nested agent-tool resume data
- usage
- generated items
- tool-related state

这说明框架对“长生命周期 run”是认真设计过的。

#### `Session`

文件：

- `references/openai-agents-js/packages/agents-core/src/memory/session.ts`

`Session` 是可插拔的持久化历史接口。它定义了：

- `getItems()`
- `addItems()`
- `popItem()`
- `clearSession()`
- 可选的 history rewrite / compaction hook

这层是可自定义的，但**会话管理语义仍然是框架定义的**。

## 3. 它轻不轻

答案要分两层。

### 3.1 从使用者角度看，轻

因为最小上手真的很简单：

```ts
const agent = new Agent({ ... });
const result = await run(agent, input);
```

而且官方文档反复强调：

- primitives 少
- 上手快
- TypeScript-first

这点从 `README.md` 和 `docs/src/content/docs/index.mdx` 都能看出来。

### 3.2 从 runtime ownership 角度看，不轻

因为它内建了很多一等能力：

- built-in agent loop
- tools
- handoffs / agents as tools
- sessions
- approvals / human-in-the-loop
- tracing
- sandbox runtime

这些不是“可有可无的插件”，而是框架本体的一部分。

所以更准确的话是：

```txt
API 轻
runtime 不轻
```

对于 `Huaness Lite` 来说，这意味着：

- 如果你想快速搭一个能跑的 agent app，它不重
- 如果你想自己掌控 runtime 主链路，它偏重

## 4. 自定义到什么程度

这个问题必须拆开回答。

### 4.1 能自定义的部分

#### 模型层

文件：

- `references/openai-agents-js/packages/agents-core/src/model.ts`

它明确定义了：

- `Model`
- `ModelProvider`

其中：

- `Model` 负责 `getResponse()` / `getStreamedResponse()`
- `ModelProvider` 负责 `getModel(modelName?)`

这说明模型层是明确可替换的。

#### 工具层

文件：

- `references/openai-agents-js/packages/agents-core/src/tool.ts`

你可以自定义：

- function tool
- shell / computer / apply_patch
- `needsApproval`
- `isEnabled`
- `timeoutMs`
- `timeoutBehavior`
- input/output guardrails
- `customDataExtractor`

这层的可定制性其实很高。

#### session 层

文件：

- `references/openai-agents-js/packages/agents-core/src/memory/session.ts`

你可以自定义 session 的存储和 history rewrite 行为。

#### tracing / lifecycle

文件：

- `references/openai-agents-js/packages/agents-core/src/tracing/*`
- `references/openai-agents-js/packages/agents-core/src/lifecycle.ts`

说明观测和生命周期 hook 也是开放的。

#### 每次 model call 前后的窄扩展点

文档：

- `references/openai-agents-js/docs/src/content/docs/guides/running-agents.mdx`

这里开放了几个很关键但“窄”的扩展口：

- `sessionInputCallback`
- `callModelInputFilter`
- `toolErrorFormatter`
- `reasoningItemIdPolicy`

这些很适合做局部调整。

### 4.2 会卡住的部分

#### 主 loop 不开放

我没找到公开的 loop strategy / step scheduler / turn resolver 替换口。

真正的控制流在：

- `references/openai-agents-js/packages/agents-core/src/run.ts`
- `references/openai-agents-js/packages/agents-core/src/runner/*`

这意味着你可以配它，但不容易“改它怎么跑”。

#### tool execution pipeline 是内建的

文件：

- `references/openai-agents-js/packages/agents-core/src/runner/toolExecution.ts`

你可以：

- 配审批
- 配 guardrail
- 配超时
- 配并发数

但执行总调度本身不是 public abstraction。

#### 没有独立的 EventLog 抽象

我没有在源码里看到类似：

```txt
EventLog
EventWriter
ReplayStore
```

框架更偏向：

- `RunResult.newItems`
- `RunResult.history`
- `rawResponses`
- tracing spans

这说明它有 observability，但没有你现在想要的那种“JSONL-first、可重放、可审计”的独立事件事实源。

#### 没有显式 central PolicyEngine

policy 语义分散在：

- `needsApproval`
- guardrails
- `toolErrorFormatter`
- `callModelInputFilter`

这对一般应用没问题，但对你想做的 `Huaness Lite`，会显得不够中心化。

### 4.3 对 Huaness Lite 的真实含义

如果你要自己拥有这些模块：

- `AgentLoop`
- `ToolGateway`
- `PolicyEngine`
- `EventLog`
- `SessionRunManager`

那就**不要直接 adopt 顶层 `Runner`**。

## 5. 异步工具、长时工具、审批恢复

这是它做得比较成熟的一块。

### 5.1 异步工具支持

文件：

- `references/openai-agents-js/packages/agents-core/src/tool.ts`

function tool 的 `execute` 本身就是 async。

并且还支持：

- `timeoutMs`
- `timeoutBehavior`
- `timeoutErrorFunction`
- `ToolCallDetails.signal`

所以常规 async tool 完全没问题。

### 5.2 并发执行

文件：

- `references/openai-agents-js/packages/agents-core/src/runner/toolExecution.ts`
- `references/openai-agents-js/packages/agents-core/src/run.ts`

框架支持：

- function tool 并发执行
- `toolExecution.maxFunctionToolConcurrency` 控制每轮本地 function tool 的并发数

官方文档还明确说明：

- 这是 SDK-side function tool concurrency
- 不等于 provider-side parallel tool calls

这点边界是清楚的。

### 5.3 审批中断与恢复

文档：

- `references/openai-agents-js/docs/src/content/docs/guides/human-in-the-loop.mdx`

这是它非常强的一块。

流程是：

1. tool 将要执行
2. `needsApproval` 判断需要审批
3. 不执行 tool，而是记录 `RunToolApprovalItem`
4. run 暂停，返回 `interruptions`
5. 你调用 `result.state.approve(...)` / `reject(...)`
6. 再把 `result.state` 传回 `runner.run(agent, state)` 继续

而且这套机制不只适用于顶层 tool，也适用于：

- handoff 后的 agent
- `agent.asTool()` 内部的 nested run

这说明它的 approval/resume 语义是 run-wide 的，而不是某个局部 hack。

### 5.4 长时间暂停

文档同样确认：

- `result.state.toString()`
- `RunState.fromString(...)`

所以它支持长时间暂停后恢复。

但这里要注意一个边界：

**它强的是 approval-based interruption，不是通用后台任务 job orchestration。**

也就是说：

- “等人审批，明天继续” 很成熟
- “起一个长后台任务，未来某个外部事件回来后自动回写同一个 run” 不是它当前最强的主场

## 6. 和 Vercel AI SDK 的关系

这部分是这次最值得注意的点之一。

### 6.1 不是猜测，是官方 extension

文档：

- `references/openai-agents-js/docs/src/content/docs/extensions/ai-sdk.mdx`

实现：

- `references/openai-agents-js/packages/agents-extensions/src/ai-sdk/index.ts`

核心函数：

- `aisdk(...)`
- `AiSdkModel implements Model`

这说明它不是“顺便兼容一下”，而是官方明确提供了一个：

```txt
Vercel AI SDK model -> OpenAI Agents JS Model
```

的适配层。

### 6.2 这层到底接在哪

接在 `Model` 这一层。

也就是说，不是：

```txt
整个 runtime 换成 AI SDK
```

而是：

```txt
openai-agents-js runtime
  -> Model interface
    -> AiSdkModel
      -> Vercel AI SDK provider/model
```

这点和你前面理解的 `ModelClient` / provider adapter 边界是一致的。

### 6.3 多 provider / 多模型

示例目录：

- `references/openai-agents-js/examples/ai-sdk`
- `references/openai-agents-js/examples/model-providers`

其中 `examples/ai-sdk/index.ts` 直接演示了：

- OpenRouter
- OpenAI
- Anthropic
- Google

都可以通过 `aisdk(...)` 包成 `AiSdkModel`，再交给 `Agent`。

这说明：

**如果你只是想借它的 model/provider 生态，它是能吃 Vercel AI SDK 的。**

### 6.4 限制

官方文档明确写了几条：

- adapter 仍是 beta
- 要求 AI SDK provider 暴露 `specificationVersion` v2 或 v3
- deferred Responses tool-loading flows 不支持
- OpenAI 模型优先建议直接走默认 OpenAI provider，而不是 AI SDK adapter

所以这块能用，但不能当成完全无边界。

## 7. 这个框架能不能满足你刚才问的那些问题

这里直接用结论表。

| 关心点 | 结论 | 说明 |
| --- | --- | --- |
| 能不能快速上手 | `可以` | 最小 API 很轻，`Agent + run()` 即可 |
| 能不能做多 agent / handoff | `可以` | 这是框架核心能力 |
| 能不能做异步工具 | `可以` | async execute、timeout、abort、并发都支持 |
| 能不能做审批中断恢复 | `可以，而且很成熟` | 这是它最强的部分之一 |
| 能不能接入 Vercel AI SDK | `可以，而且是官方桥接` | `aisdk()` / `AiSdkModel` |
| 能不能统一多 provider / 多模型 | `可以` | 通过 AI SDK bridge 或自定义 `ModelProvider` |
| 能不能完全保留你自己的 loop 主权 | `不合适` | `Runner` 已经拥有核心执行权 |
| 能不能完全按你自己的 EventLog 语义来 | `不合适` | 有 tracing / results，但没有独立 EventLog 核心抽象 |
| 能不能做中心化 PolicyEngine | `不自然` | policy 逻辑分散在 approval / guardrails / filters |
| 能不能直接变成 Huaness Lite 核心 | `不建议` | 太容易把 runtime 主权交出去 |

## 8. 从学习架构的角度，最值得学什么

这套框架最值得学的，不是“拿来直接用”，而是它的边界划分。

### 8.1 `definition` 和 `execution` 分离

- `Agent` 负责定义
- `Runner` 负责执行

这是很清楚的架构分层。

### 8.2 `Model` / `ModelProvider` 独立成接口

这层抽象非常适合你学习：

- runtime 不直接绑死某个厂商
- provider 解析和 run orchestration 分离

### 8.3 `RunState` 作为中断恢复载体

这是它最有工业感的地方之一。

不是简单存 history，而是明确把：

- approvals
- nested run state
- current step
- context

都放进可恢复状态。

### 8.4 approval 设计是 run-wide 的

不是某个 tool 自己暂停自己，而是整个 run 的 interruption surface 统一上浮。

这个思路对你做群聊 runtime 很有参考价值。

### 8.5 “窄扩展口” 风格

它不是给你一个超级大的 runtime plugin API，而是给：

- `sessionInputCallback`
- `callModelInputFilter`
- `toolErrorFormatter`

这种局部、窄、明确的切入点。

这是一种很成熟的工程风格。

## 9. 对 Huaness Lite 的建议

### Adopt

- `Model` / `ModelProvider` 的分层思路
- approval interruption / resume 语义
- `Session` 接口形状
- tool timeout / abort / concurrency 设计
- AI SDK bridge 的集成方式

### Adapt

- `RunState` 的“可恢复状态机”思路
- `callModelInputFilter`
- `toolErrorFormatter`
- `sessionInputCallback`
- `result.history / previousResponseId / conversationId / session` 这几种状态策略的分工

### Avoid

- 不要把 `Runner` 当成 Huaness Lite 的核心 runtime
- 不要把 tracing 直接当 `EventLog`
- 不要把 approval/guardrail 拼起来就当完整 `PolicyEngine`
- 不要把 session/run 主权整体交给框架

## 最短总结

把这次分析压成最短的话：

```txt
openai-agents-js 很适合学一套工业化 agent runtime 是怎么分层的，
也很适合借它的 model/provider、approval/resume、AI SDK bridge。

但如果 Huaness Lite 要自己拥有 AgentLoop、ToolGateway、PolicyEngine、EventLog，
那它不适合直接做你的顶层 runtime。
```

真正适合你的用法更像：

```txt
借它学习边界
+ 借它的一部分抽象
而不是把整个 Runner 接进来当框架底座
```

