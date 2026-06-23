# Vercel AI SDK 核心能力调研

调查日期：2026-06-23

资料范围：以官方 `ai-sdk.dev` 文档为主，当前文档页显示为 `v6 (Latest)`。本报告只关注 Vercel AI SDK 的核心能力和对 Huaness Lite 的接入边界，不展开 Eve 框架，也不把 AI SDK 当成完整 harness/runtime 介绍。

## 一句话结论

Vercel AI SDK 的本质是一个 TypeScript AI 应用工具箱：它把多模型调用、流式输出、结构化输出、工具调用、轻量 agent loop、前端聊天 UI、MCP 接入、memory/provider/middleware/telemetry 等能力统一成一套 API。

对 Huaness Lite 来说，它最适合放在 `ModelClient` / provider adapter 层；不要让它接管 Huaness 自己的 `AgentLoop`、`ToolGateway`、`PolicyEngine`、`EventLog`、Replay/Eval。

## 核心能力总览

| 能力 | 代表 API / 模块 | 解决什么问题 | 对 Huaness Lite 的价值 | 主要边界 |
| --- | --- | --- | --- | --- |
| Provider 抽象 | `gateway`, provider packages, `customProvider`, `createProviderRegistry`, `wrapLanguageModel` | 用统一接口调用 OpenAI、Anthropic、Google、xAI、Bedrock、OpenAI-compatible 等模型 | 很适合做 `AiSdkModelClient`，减少多模型适配成本 | 模型别名、默认 provider、provider options 不应散落在业务代码里 |
| 文本生成 | `generateText`, `streamText` | 非流式/流式文本生成，返回 text、usage、finishReason、steps、response messages | P0 最可用能力；可把每次 model step 映射进 EventLog | 不要直接把 SDK result 当 Huaness run trace 的唯一事实源 |
| 结构化输出 | `Output.object`, `Output.array`, `Output.choice`, `Output.json` | 用 Zod / JSON Schema 约束模型输出，并做类型校验 | 适合用于计划生成、分类、工具参数解释、eval 样本抽取 | v6 官方文档主要把结构化输出并入 `generateText` / `streamText` 的 `output` 属性 |
| 工具调用 | `tool`, `inputSchema`, `execute`, `strict`, `needsApproval` | 定义工具 schema，让模型产出 tool call，并可自动执行或等待审批 | 可以复用 schema 和 tool call 解析，但执行必须回到 Huaness `ToolGateway` | 危险工具不应由 SDK 自动执行；审批语义要归 Huaness 管 |
| 多步调用 | `stopWhen`, `stepCountIs`, `hasToolCall`, `onStepFinish`, `prepareStep` | 在工具调用后自动继续下一步，直到停止条件满足 | 可作为 Huaness loop 设计参考；P0 可借鉴停止条件和 step callback | `ToolLoopAgent` 会隐藏部分 loop 细节，不适合作为 Huaness 核心 loop 的唯一实现 |
| Agent 封装 | `ToolLoopAgent` | 封装 LLM + tools + loop + context + stop condition | 适合学习和做小 demo | Huaness 要做 harness/agent runtime，核心 loop 应自己掌控 |
| 前端 UI | `useChat`, `useCompletion`, `useObject`, UI message streams | 快速做聊天、completion、结构化对象流式 UI | P1 做 Web UI 时很有价值 | P0 core 不依赖 UI hooks；QQ/CLI/HTTP channel 不该被 UI 形态绑定 |
| MCP 接入 | `@ai-sdk/mcp`, `createMCPClient`, `mcpClient.tools()` | 把 MCP server 的 tools/resources/prompts 转成 AI SDK 可用工具 | P1 可作为外部工具生态接入路径 | MCP client 的 tool discovery 要经过 Huaness tool registry / policy 过滤 |
| Memory | Anthropic memory tool, Letta, Mem0, Supermemory, Hindsight, custom memory tool | 给 agent 增加长期记忆和检索能力 | 可参考“memory 是工具或 provider 层能力”的划分 | Huaness 的长期记忆不能直接交给外部 provider 黑箱控制 |
| RAG 检索相关 | `embed`, `embedMany`, `rerank` | embedding、批量 embedding、搜索结果重排 | 后续做 memory/search/eval 数据集时可用 | P0 agent loop 不必先接 embedding；先把 event trace 做稳 |
| 多模态生成 | `generateImage`, experimental `transcribe`, experimental `generateSpeech` | 图片、语音转文字、文字转语音等 | 非核心能力，可作为 tool/channel 扩展 | experimental 能力不要进核心抽象 |
| Middleware | `wrapLanguageModel`, built-in middleware | 在模型调用外层做 guardrails、RAG、缓存、日志、默认参数 | 可用来包模型默认参数、日志或 provider 修正 | Policy/Safety 不应只靠 middleware；Huaness 仍要有显式 PolicyEngine |
| Observability | `experimental_telemetry`, lifecycle callbacks, `fullStream` | OpenTelemetry、step/tool 生命周期、完整流事件 | 可辅助调试和事件采集 | telemetry 是观测工具，不是可重放 run log |
| Testing | `MockLanguageModelV3`, `MockEmbeddingModelV3`, `simulateReadableStream` | 不调用真实模型也能测生成/流式逻辑 | 很适合 Huaness P0 单测 | Huaness 仍需要自己的 fake model / fake tool gateway 测核心 loop |

## 1. Provider 和模型调用抽象

AI SDK 的第一个价值是 provider abstraction。官方文档把 AI SDK 定义为可以在 React、Next.js、Vue、Svelte、Node.js 等环境里构建 AI 应用和 agents 的 TypeScript toolkit，并明确分成两大库：

- AI SDK Core：统一的模型调用、结构化输出、工具调用、agent 能力。
- AI SDK UI：框架无关的聊天和生成式 UI hooks。

模型可以通过三种方式接入：

- 直接使用字符串模型名，例如 `model: "anthropic/claude-sonnet-4.5"`，默认走 AI Gateway。
- 使用 provider package，例如 `@ai-sdk/openai`、`@ai-sdk/anthropic`。
- 用 `customProvider` / `createProviderRegistry` 自己做模型别名、默认参数、可用模型白名单、OpenAI-compatible provider。

对 Huaness Lite 的意义：

- P0 可以定义 `AiSdkModelClient implements ModelClient`，内部用 AI SDK 调模型。
- Huaness 自己的配置里只暴露 `modelId`、`provider`、`temperature`、`maxOutputTokens` 这类稳定字段。
- AI SDK 的 provider registry 可以作为实现细节，不要泄漏到 AgentLoop 里。

推荐边界：

```txt
Huaness AgentLoop
  -> Huaness ModelClient interface
    -> AiSdkModelClient
      -> Vercel AI SDK provider / gateway / registry
```

## 2. 文本生成和流式生成

AI SDK Core 的基础入口是：

- `generateText`：一次性生成文本，也支持 tool call 和多步执行。
- `streamText`：流式生成文本和 tool call，适合交互式聊天、CLI、Web UI、频道输出。

`streamText` 的重要返回形态：

- `textStream`：只消费文本 delta。
- `fullStream`：消费完整事件流，包括 start、text delta、tool call、tool result、error、abort 等。
- `onFinish`：结束时拿到 text、usage、finishReason、response messages、steps、totalUsage。
- `onStepFinish`：每个 step 完成后拿到 stepNumber、text、toolCalls、toolResults、finishReason、usage。

对 Huaness Lite 的意义：

- P0 如果要支持“边生成边输出”，应优先使用 `streamText`。
- 如果要做 EventLog，`fullStream` 和 `onStepFinish` 都可以作为事件采集点。
- 但 EventLog 不能只记录 AI SDK 的 callback；Huaness 要在自己的 loop 外层记录 `model_request`、`model_delta`、`model_response`、`tool_call_requested`、`tool_result_observed` 等语义事件。

推荐 P0 事件映射：

```txt
streamText.start        -> model_step_started
text-delta              -> model_text_delta
tool-call               -> tool_call_proposed
tool-result             -> tool_result_observed
finish                  -> model_step_finished
error / abort           -> model_step_failed / run_cancelled
```

## 3. 结构化输出

AI SDK v6 官方文档的结构化输出重点已经并入 `generateText` / `streamText` 的 `output` 属性，而不是单独强调旧式的 object generation 函数。

主要输出类型：

- `Output.text()`：普通文本。
- `Output.object({ schema })`：按 schema 生成对象。
- `Output.array({ element })`：按 element schema 生成数组。
- `Output.choice({ options })`：从固定字符串集合中选择。
- `Output.json()`：只校验 JSON 合法性，不校验字段结构。

它可以和 tool calling 合并在同一次请求中。官方文档也提示：结构化输出在多步执行模型里算一个 step，所以和工具调用混用时要考虑 `stopWhen`。

Huaness 可用场景：

- planner 输出结构化 plan。
- classifier 判断用户意图或 channel 类型。
- eval 把一次 run 转成结构化样本。
- tool 参数修复或解释。

不建议 P0 过度使用的场景：

- 不要让结构化输出替代事件日志。
- 不要把所有 agent 内部状态都强行塞成一次模型输出对象。
- replay/eval 应依赖 Huaness EventLog，而不是依赖某次结构化输出。

## 4. 工具调用和审批

AI SDK 的工具定义核心字段：

- `description`：给模型看的工具描述。
- `inputSchema`：Zod 或 JSON Schema，同时给模型和运行时校验使用。
- `execute`：可选 async function。存在时，模型调用工具后 SDK 可以自动执行。
- `strict`：provider 支持时启用严格工具调用。
- `needsApproval`：工具执行前需要审批，可为 boolean 或基于输入动态判断的函数。

关键机制：

- 工具如果有 `execute`，默认会自动执行。
- 工具如果没有 `execute`，可以把 tool call 转发给客户端、队列或自己的执行器。
- 设置 `needsApproval` 后，`generateText` / `streamText` 不会真正暂停，而是返回 `tool-approval-request` part；应用收集用户审批后，把 `tool-approval-response` 加回 messages，再调用一次模型。

对 Huaness Lite 的核心建议：

P0 不要让 AI SDK 直接执行 shell/write/network 等危险工具。更适合的接法是：

```txt
AI SDK tool schema
  -> model proposes tool call
    -> Huaness validates tool name + args
      -> PolicyEngine approval
        -> ToolGateway executes with timeout/path guard/output truncation
          -> Huaness appends observation
            -> next model step
```

也就是说，AI SDK 可以帮你：

- 暴露工具 schema。
- 解析 tool call。
- 做基础 schema validation。
- 提供 approval request 的参考格式。

但 Huaness 必须自己负责：

- 工具是否存在。
- 当前 run/channel/user 是否允许调用。
- 参数是否越权。
- 是否需要用户审批。
- 执行超时、输出截断、workspace path guard。
- 所有 tool request/result/error 的 EventLog。

## 5. 多步执行和 AgentLoop

AI SDK 的多步能力主要有两层：

第一层是 `generateText` / `streamText` 的 `stopWhen`：

- 默认一次模型调用。
- 如果设置 `stopWhen`，并且模型产出 tool call，SDK 会执行工具、把结果回传给模型，继续下一 step，直到无 tool call 或停止条件满足。
- 常用条件包括 `stepCountIs(n)`、`hasToolCall(toolName)`，也可以自定义 stop condition。

第二层是 `ToolLoopAgent`：

- 把 LLM、tools、loop、context management、stopping conditions 封装成一个类。
- 默认最大 20 steps。
- 支持 `agent.generate()` 和 `agent.stream()`。
- 支持 `prepareStep` 在每个 step 前改模型、改 tool choice、限制 active tools、调整 messages。

`prepareStep` 对 Huaness 的启发很大：

- 可以做动态模型选择。
- 可以做每步可用工具限制。
- 可以做上下文裁剪/压缩。
- 可以按历史 steps 调整 prompt/messages。

但 P0 不建议直接把 `ToolLoopAgent` 当 Huaness core：

- 它会隐藏部分 loop 决策。
- Huaness 需要精确记录每个 run event。
- Huaness 需要自己的 approval/policy/tool gateway。
- Huaness 需要 replay/eval，不能依赖 SDK 内部 steps 作为唯一语义模型。

更好的 P0 方式：

```txt
Huaness owns loop:
  while not stopped:
    context = ContextAssembler.build(runState)
    response = AiSdkModelClient.step(context, toolSchemas)
    EventLog.append(model events)
    if response.toolCalls:
      for call in response.toolCalls:
        ToolGateway.execute(call)
        EventLog.append(tool events)
        runState.addObservation(...)
      continue
    else:
      finish
```

P1 可以评估：

- 在非危险工具、demo、临时脚本里用 `ToolLoopAgent`。
- 或用 `ToolLoopAgent` 包一层 Huaness tool gateway，但必须先确认事件、审批、replay 语义不丢。

## 6. 前端 UI 能力

AI SDK UI 提供三个核心 hooks：

- `useChat`：管理实时聊天消息、输入、loading、error、stream。
- `useCompletion`：管理 completion prompt 和输出流。
- `useObject`：消费结构化 JSON/object stream。

它支持 React、Vue、Svelte、Angular、SolidJS。官方还提供 message persistence、resume streams、chatbot tool usage、generative UI、transport、stream protocols 等页面。

对 Huaness Lite：

- P0 不需要 AI SDK UI。
- P1 如果做 Web 控制台，可以用 `useChat` 快速接一个 `/api/chat` 或 `/runs/:id/stream`。
- UI message stream 可以作为展示层协议，但不能替代 Huaness core event protocol。

推荐边界：

```txt
Huaness EventLog / RunStream
  -> API adapter
    -> AI SDK UI compatible stream, if needed
      -> Web UI useChat/useObject
```

## 7. MCP 接入

AI SDK 通过 `@ai-sdk/mcp` 支持 MCP：

- `createMCPClient` 创建 client。
- 支持 HTTP、SSE、stdio、自定义 transport。
- 官方建议生产环境优先 HTTP transport；stdio 只适合本地 server。
- `mcpClient.tools()` 可以把 MCP tools 转成 AI SDK tools。
- 可以自动 discovery，也可以显式定义 schemas 来获得类型安全和工具白名单。
- MCP resources/prompts 也可以被列出和读取，但 resources 是 application-driven context，不是模型自主调用工具。

对 Huaness Lite：

- MCP 是很适合 P1 的工具生态入口。
- 但 `mcpClient.tools()` 不能直接全量暴露给模型。
- 应该先进入 Huaness `ToolRegistry`，再经过 capability scope、policy、approval、event trace。

推荐接法：

```txt
MCP server
  -> MCP adapter discovers tools/resources
    -> Huaness ToolRegistry normalizes descriptors
      -> PolicyEngine filters allowed tools
        -> Model sees selected tool schemas
```

## 8. Memory 能力

AI SDK 的 memory 文档不是给一个内置统一 MemoryStore，而是给三种路径：

- Provider-defined tools：例如 Anthropic memory tool，模型通过结构化命令管理 `/memories` 目录。
- Memory providers：例如 Letta、Mem0、Supermemory、Hindsight，把长期记忆交给外部 provider/service。
- Custom tool：自己定义 `view/create/update/search` 等 memory 操作，或提供受限 bash-backed memory。

这说明 AI SDK 对 memory 的定位偏“工具/provider 能力”，不是 harness 自己的长期经验资产系统。

对 Huaness Lite：

- P0 可以不接 memory provider，先做好 run/event log。
- 如果要做近期记忆，建议由 Huaness 自己组装进 context，而不是交给 provider 黑箱。
- 如果后续做 self-improve，memory 写入必须走 review/approval/pending，而不是让模型直接持久化任意内容。

推荐 P0：

```txt
ContextAssembler
  -> explicit recent run summary
  -> selected user/channel memory
  -> selected project notes
  -> model messages
```

P1/P2 再考虑：

- custom memory tool。
- local file memory。
- external provider memory。
- embedding/rerank 检索。

## 9. Embedding、Reranking 和 RAG 周边

AI SDK Core 包含：

- `embed`：单条 embedding。
- `embedMany`：批量 embedding，支持 `maxParallelCalls`。
- `rerank`：对搜索结果做 query/document 相关性重排。

这些能力更适合：

- 长期 memory 检索。
- 文档/代码片段检索。
- eval 样本搜索。
- self-improve candidate 检索。

P0 不必先接，因为 Huaness 当前最关键的是：

1. agent loop 可控。
2. tool execution 可审计。
3. event trace 可回放。
4. context assembly 可解释。

等 EventLog 和 ContextAssembler 稳定后，再接 embedding/rerank 会更自然。

## 10. 多模态能力

AI SDK Core 还包含一些非文本能力：

- `generateImage`：基于 image model 生成图片，返回 base64 / Uint8Array。
- experimental `transcribe`：音频转文字。
- experimental `generateSpeech`：文字转语音。
- 文档导航中还列出 video generation。

对 Huaness Lite：

- 这些不属于 agent/harness P0 核心。
- 适合以后作为 tool 或 channel extension。
- experimental 能力不要进入核心接口，避免版本变动拖累主链路。

## 11. Middleware、Telemetry、Error 和 Testing

Middleware：

- `wrapLanguageModel` 可以拦截/修改模型调用。
- 官方提到可用于 guardrails、RAG、caching、logging。
- 内置 middleware 包括 reasoning 提取、JSON 提取、模拟 streaming、默认参数、tool input examples 等。

Telemetry：

- AI SDK telemetry 基于 OpenTelemetry。
- 通过 `experimental_telemetry` 开启。
- 可以控制是否记录 inputs/outputs，提供 `functionId`、metadata、custom tracer、telemetry integrations。

Error handling：

- 普通错误用 `try/catch`。
- `fullStream` 支持 `error`、`abort`、`tool-error` parts。
- `onAbort` 可处理 stream abort cleanup。

Testing：

- `ai/test` 提供 `MockLanguageModelV3`、`MockEmbeddingModelV3`、`mockId`、`mockValues`。
- `simulateReadableStream` 可以模拟流式响应。
- 这对 Huaness 的 `ModelClient` adapter 测试很有用。

对 Huaness Lite：

- Middleware 可用于模型默认参数、日志、兼容性修正。
- Telemetry 可以辅助观测，但不能代替 Huaness EventLog。
- Error/abort/tool-error 必须映射到 Huaness event schema。
- MockLanguageModel 可以用于 adapter 测试，但核心 loop 测试仍应有 Huaness 自己的 fake model。

## Huaness Lite 接入建议

### P0 应采用

- 用 AI SDK 实现一个 `AiSdkModelClient`。
- 优先支持 `streamText`，同时保留 `generateText` 作为非流式路径。
- Huaness 自己定义稳定的 `ModelMessage` / `ToolCall` / `ToolResult`，在 adapter 内转换成 AI SDK 结构。
- 复用 AI SDK tool schema 能力，但危险工具不直接交给 SDK `execute`。
- 用 AI SDK 的 `fullStream` / `onStepFinish` 辅助采集模型事件。
- 用 `AbortSignal.timeout(...)` 和 Huaness cancellation 机制打通模型调用取消。
- 用 `MockLanguageModelV3` 或自定义 fake model 做 adapter 测试。

### P0 应延后

- `ToolLoopAgent` 作为 Huaness core loop。
- AI SDK UI hooks。
- MCP 自动 discovery 后全量暴露工具。
- Memory provider。
- Embedding/rerank RAG。
- 图片、语音、视频生成。
- experimental telemetry 作为核心 trace。

### P0 应避免

- 把 AI SDK 的 `steps` 当成 Huaness run 的唯一轨迹。
- 让 AI SDK 自动执行 shell/write/network 工具。
- 把 `needsApproval` 当成完整 PolicyEngine。
- 让 AI Gateway/provider registry 决定 Huaness core 架构。
- 让前端 UI message protocol 反向定义 AgentLoop/EventLog。

## 推荐最小集成形态

```ts
export class AiSdkModelClient implements ModelClient {
  async streamStep(request: ModelStepRequest): Promise<ModelStepResult> {
    const result = streamText({
      model: this.resolveModel(request.model),
      system: request.system,
      messages: toAiSdkMessages(request.messages),
      tools: toAiSdkToolSchemas(request.tools),
      abortSignal: request.abortSignal,
      onStepFinish: step => {
        request.events.append({
          type: "model_step_finished",
          stepNumber: step.stepNumber,
          finishReason: step.finishReason,
          usage: step.usage,
        });
      },
    });

    return fromAiSdkStream(result.fullStream);
  }
}
```

关键点不是这段代码本身，而是边界：

```txt
AI SDK 负责：provider 调用、stream 解码、tool schema、基础校验。
Huaness 负责：loop 状态、context 组装、policy/approval、tool gateway、event log、replay/eval。
```

## 当前决策

建议把 Vercel AI SDK 定位为 Huaness Lite 的模型与流式调用基础设施，而不是 agent runtime。

```txt
P0:
  Huaness AgentLoop owns orchestration
  Huaness ToolGateway owns execution
  Huaness EventLog owns truth
  Vercel AI SDK powers ModelClient

P1:
  optional AI SDK UI for Web UI
  optional MCP adapter
  optional embed/rerank

P2:
  optional memory provider
  optional ToolLoopAgent for isolated non-core demos
  optional multimodal tools
```

## 资料链接

- [AI SDK Introduction](https://ai-sdk.dev/docs/introduction)
- [AI SDK Core Overview](https://ai-sdk.dev/docs/ai-sdk-core/overview)
- [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
- [Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Agents Overview](https://ai-sdk.dev/docs/agents/overview)
- [Agents Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [Agents Memory](https://ai-sdk.dev/docs/agents/memory)
- [AI SDK UI Overview](https://ai-sdk.dev/docs/ai-sdk-ui/overview)
- [MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [Provider & Model Management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)
- [Language Model Middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)
- [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [Error Handling](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)
- [Testing](https://ai-sdk.dev/docs/ai-sdk-core/testing)
- [Embeddings](https://ai-sdk.dev/docs/ai-sdk-core/embeddings)
- [Reranking](https://ai-sdk.dev/docs/ai-sdk-core/reranking)
- [Image Generation](https://ai-sdk.dev/docs/ai-sdk-core/image-generation)
- [Transcription](https://ai-sdk.dev/docs/ai-sdk-core/transcription)
- [Speech](https://ai-sdk.dev/docs/ai-sdk-core/speech)
