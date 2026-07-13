# DeepSeek MainAgent Provider Design

**状态：** 代码已实施，待真实 DeepSeek 与 QQ smoke
**日期：** 2026-07-13

## 目标

在不改变 Phase 4 QQ、AgentCall、A2A 和 Codex app-server 链路的前提下，让 Vercel AI SDK 负责 MainAgent 的模型提供方配置，并通过 DeepSeek 官方 `deepseek-v4-flash` 完成真实 QQ Demo。现有 OpenAI Agents JS agent loop 保持不变，运行时不再依赖 OpenAI API Key。

## 设计决策

- 保留 OpenAI Agents JS 的 `Agent`、`Runner`、RunContext 和现有工具循环。
- 使用 OpenAI Agents 官方 `@openai/agents-extensions/ai-sdk` bridge，把 Vercel AI SDK 模型适配为现有 `Agent` 可使用的模型。
- 使用 `@ai-sdk/deepseek` 的 `createDeepSeek` 负责 DeepSeek API Key、Base URL、模型 ID 和供应商特有选项。
- 本阶段不使用 AI SDK 的 `ToolLoopAgent`、`generateText` 或 `streamText`，也不重写 `OpenAiAgentsRuntime` 的 agent loop。
- 默认模型固定为 `deepseek-v4-flash`。
- 使用 `https://api.deepseek.com/beta`。现有 `submit_codex_agent_call` 仍由 OpenAI Agents JS 定义严格 Zod 工具 schema，真实 smoke 必须验证 bridge 到 DeepSeek 的严格工具调用可用。
- 固定使用 `@openai/agents-extensions@0.12.0`、`ai@6.0.224` 和 `@ai-sdk/deepseek@2.0.47`，与仓库现有 `@openai/agents@0.12.0` 保持同代兼容，不为本次接入升级整套 Agent SDK。
- 当前 AI SDK bridge 转换 OpenAI Agents 工具时不会保留 `strict` 标记；在 DeepSeek AI SDK 模型外包一层仅修正工具描述的 model middleware，把现有函数工具恢复为 `strict: true`。该 middleware 不执行工具、不推进 turn，也不形成第二套 agent loop。
- 默认关闭 DeepSeek 思考模式，优先降低 MainAgent 路由与回执延迟；模型提供方配置显式传递 `thinking: { type: "disabled" }`。
- DeepSeek 只负责 MainAgent 的理解、工具选择和结果组织；Codex Adapter 的模型、认证和 app-server 调用保持不变。
- AI SDK bridge 当前是 beta 能力，因此依赖版本必须明确固定，并以真实 DeepSeek 工具调用作为接入验收，不能只依赖类型检查。

```text
QQ / OneBot 11
  -> HuanLink MainAgent
  -> OpenAI Agents JS Runner
  -> @openai/agents-extensions/ai-sdk
  -> @ai-sdk/deepseek
  -> DeepSeek V4 Flash (official API)
  -> submit_codex_agent_call
  -> AgentCall / A2A / Codex app-server
```

## 配置合同

```dotenv
HUANLINK_MAIN_AGENT_PROVIDER=deepseek
HUANLINK_MAIN_AGENT_MODEL=deepseek-v4-flash
HUANLINK_DEEPSEEK_BASE_URL=https://api.deepseek.com/beta
DEEPSEEK_API_KEY=
```

- `HUANLINK_MAIN_AGENT_PROVIDER` 在本次 Demo 中只接受 `deepseek`；它选择 AI SDK provider，但不提前建设通用 provider registry。
- 模型和端点提供上述默认值。模型 ID 与 provider ID 分离，为后续基础模型选择保留清晰合同。
- `DEEPSEEK_API_KEY` 必须非空，缺失时启动立即失败；错误和日志不得包含 Key。
- 仓库只提交 `.env.example` 的空占位；本地 `.env` 由用户填写真实 Key，且不进入 Git。

## 运行语义

外层异步语义不变：MainAgent 调用 `submit_codex_agent_call` 后，`executionMode: "async"` 立即返回受理结果；Codex 终态再触发 fresh MainAgent turn，并结合当时最新群聊上下文回复原 QQ 群。AI SDK 只位于模型解析边界，不接管 AgentCall、task ID、会话路由或 A2A 合同。

现有 OpenAI Agents tool 仍是唯一工具定义；不复制一份 AI SDK `tool()`。bridge 负责在 Agents SDK 与 AI SDK model 之间转换消息、工具调用和 provider 配置。

## 错误与安全边界

- 配置错误在连接 QQ 和接收任务前暴露。
- DeepSeek 的鉴权、限流、bridge 兼容性、协议和工具 schema 错误作为 MainAgent run 失败处理，不伪装成任务已受理。
- 不在日志、异常文本、测试快照或 Artifact 中输出 API Key。
- 不增加自动 fallback；失败应可见，避免 Demo 中静默切换到未配置的模型。
- 不接入 Vercel AI Gateway；Demo 直接使用用户提供的 DeepSeek 官方 API Key。

## 验证与验收

1. 单元测试覆盖配置默认值、缺失 Key、AI SDK 模型注入、思考模式关闭和敏感信息不泄漏。
2. bridge 测试确认现有 OpenAI Agents Runner 与 RunContext 仍执行同一个 `submit_codex_agent_call`，并检查发往 DeepSeek 的请求包含 `strict: true`，不引入第二套 agent loop。
3. 保持现有 MainAgent/AgentCall 测试通过，并运行全仓 `test`、`typecheck`、`build`。
4. 用户填写 Key 后，先运行可选启用的真实 DeepSeek smoke，确认 `deepseek-v4-flash` 经 bridge 真实调用 `submit_codex_agent_call`，而不是只生成说明文字。
5. 再继续 Phase 4 真实 QQ smoke：群内触发后收到 task ID，Codex 终态结合最新上下文返回同一群。

验收结果必须证明真实 DeepSeek MainAgent 经 Vercel AI SDK provider bridge 完成了一次工具调用；无需 `OPENAI_API_KEY`，且现有 OpenAI Agents loop 与真实 A2A/Codex 链路不回退为 mock。

## 非目标

- 多供应商注册表、自动路由、fallback、重试策略或成本治理。
- QQ 侧模型选择、模型别名和管理界面。
- 用 AI SDK `ToolLoopAgent` 替换 OpenAI Agents JS，或把工具改写为 AI SDK `tool()`。
- Vercel AI Gateway、AI SDK UI、流式 Web UI 和部署到 Vercel。
- 修改 Codex app-server 的模型或认证方式。
- 扩展 Phase 4 的 OneBot 协议范围或改变 Phase 5 边界。

## 官方依据

- [OpenAI Agents SDK：AI SDK Integration](https://openai.github.io/openai-agents-js/extensions/ai-sdk/)
- [Vercel AI SDK：DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)
- [DeepSeek API 快速开始](https://api-docs.deepseek.com/)
- [DeepSeek 模型与定价](https://api-docs.deepseek.com/quick_start/pricing?article_id=article_1779470751466_8)
- [DeepSeek Tool Calls 与 strict mode](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
