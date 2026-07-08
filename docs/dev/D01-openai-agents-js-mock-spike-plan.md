# OpenAI Agents JS Mock Spike 实施计划

## 目标

在不影响群聊、A2A、EventLog 等外层能力的前提下，将 OpenAI Agents JS 作为可替换的单次 Agent Run 运行时接入 HuanLink。

## 架构

```text
packages/core
  -> AgentRuntime

packages/integrations/openai-agents
  -> OpenAiAgentsRuntime
  -> @openai/agents Runner
```

Core 只拥有框架无关的输入输出合同。OpenAI Agents JS 的 `Agent`、`Runner`、`ModelProvider` 等类型只能出现在适配包中。

## Task 1：定义 Core 运行时合同

新增最小 `AgentRuntime` 接口：

```ts
type AgentRuntimeInput = {
  runId: RunId
  sessionId: SessionId
  input: string
  signal?: AbortSignal
}

type AgentRuntimeResult = {
  output: string
}

type AgentRuntime = {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>
}
```

要求：

- 从 Core 公共入口导出。
- 不导入任何 OpenAI Agents JS 类型。
- 先写类型使用测试并确认失败，再实现接口。

## Task 2：新增 OpenAI Agents JS 适配包

新建 `packages/integrations/openai-agents`，依赖：

- `@huaness-lite/core`
- `@openai/agents`

实现 `OpenAiAgentsRuntime`：

- 构造时接收 SDK `Agent` 和可选 `Runner`。
- 默认创建关闭 tracing 的 `Runner`。
- `run()` 调用真实 `Runner.run()`。
- 将 HuanLink 的文本输入和 `AbortSignal` 转交给 SDK。
- 只返回框架无关的文本结果。
- 最终输出不是字符串时明确报错。

## Task 3：Mock 集成测试

测试中实现最小自定义 `Model` / `ModelProvider`，不访问真实 API。

至少验证：

- 真实 SDK `Runner + Agent` 能通过适配器完成一次 run。
- mock 模型输出被映射为 `{ output: string }`。
- `AbortSignal` 被传入 SDK 执行路径。
- Core 公共类型中没有 OpenAI Agents JS 依赖。

## 非目标

本阶段不实现：

- tools
- streaming
- session
- approval / interruption
- EventLog bridge
- A2A
- 真实 OpenAI API
- 删除旧 AgentLoop

## 验收

运行：

```powershell
corepack.cmd pnpm typecheck
corepack.cmd pnpm test
corepack.cmd pnpm build
```

要求全部通过，并确认 OpenAI Agents JS 依赖只存在于 `packages/integrations/openai-agents`。
