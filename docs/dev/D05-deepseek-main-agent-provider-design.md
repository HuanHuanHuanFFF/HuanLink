# DeepSeek MainAgent Provider Design

**状态：** 方案已确认，待实施
**日期：** 2026-07-13

## 目标

在不改变 Phase 4 QQ、AgentCall、A2A 和 Codex app-server 链路的前提下，让真实 HuanLink MainAgent 使用 DeepSeek 官方 `deepseek-v4-flash`，从而不依赖 OpenAI API Key 完成真实 QQ Demo。

## 设计决策

- 保留 OpenAI Agents JS 的 `Agent`、`Runner` 和现有工具循环，只替换默认模型提供方。
- 使用 `OpenAIProvider` 连接 DeepSeek 官方 OpenAI 兼容接口，并设置 `useResponses: false`，明确走 Chat Completions。
- 默认模型固定为 `deepseek-v4-flash`。
- 使用 `https://api.deepseek.com/beta`。现有 `submit_codex_agent_call` 由 Zod 生成严格工具 schema，而 DeepSeek 的严格工具调用要求 Beta 端点和 `strict: true`。
- 默认关闭 DeepSeek 思考模式，优先降低 MainAgent 路由与回执延迟；请求显式携带 `thinking: { type: "disabled" }`。
- DeepSeek 只负责 MainAgent 的理解、工具选择和结果组织；Codex Adapter 的模型、认证和 app-server 调用保持不变。

```text
QQ / OneBot 11
  -> HuanLink MainAgent
  -> OpenAI Agents JS Runner
  -> OpenAIProvider (Chat Completions)
  -> DeepSeek V4 Flash
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

- `HUANLINK_MAIN_AGENT_PROVIDER` 在本次 Demo 中只接受 `deepseek`；不提前建设通用 provider registry。
- 模型和端点提供上述默认值，但保留环境变量，便于后续升级与真实环境切换。
- `DEEPSEEK_API_KEY` 必须非空，缺失时启动立即失败；错误和日志不得包含 Key。
- 仓库只提交 `.env.example` 的空占位；本地 `.env` 由用户填写真实 Key，且不进入 Git。

## 运行语义

外层异步语义不变：MainAgent 调用 `submit_codex_agent_call` 后，`executionMode: "async"` 立即返回受理结果；Codex 终态再触发 fresh MainAgent turn，并结合当时最新群聊上下文回复原 QQ 群。提供方切换不会改变 task ID、会话路由或 A2A 合同。

## 错误与安全边界

- 配置错误在连接 QQ 和接收任务前暴露。
- DeepSeek 的鉴权、限流、协议和工具 schema 错误作为 MainAgent run 失败处理，不伪装成任务已受理。
- 不在日志、异常文本、测试快照或 Artifact 中输出 API Key。
- 不增加自动 fallback；失败应可见，避免 Demo 中静默切换到未配置的模型。

## 验证与验收

1. 单元测试覆盖配置默认值、缺失 Key、provider 注入和敏感信息不泄漏。
2. 保持现有 MainAgent/AgentCall 测试通过，并运行全仓 `test`、`typecheck`、`build`。
3. 用户填写 Key 后，先运行可选启用的真实 DeepSeek smoke，确认模型真实调用 `submit_codex_agent_call`，而不是只生成说明文字。
4. 再继续 Phase 4 真实 QQ smoke：群内触发后收到 task ID，Codex 终态结合最新上下文返回同一群。

验收结果必须证明真实 DeepSeek MainAgent 完成了一次工具调用；无需 `OPENAI_API_KEY`，且现有真实 A2A/Codex 链路不回退为 mock。

## 非目标

- 多供应商注册表、自动路由、fallback、重试策略或成本治理。
- QQ 侧模型选择、模型别名和管理界面。
- 修改 Codex app-server 的模型或认证方式。
- 扩展 Phase 4 的 OneBot 协议范围或改变 Phase 5 边界。

## 官方依据

- [DeepSeek API 快速开始](https://api-docs.deepseek.com/)
- [DeepSeek 模型与定价](https://api-docs.deepseek.com/quick_start/pricing?article_id=article_1779470751466_8)
- [DeepSeek Tool Calls 与 strict mode](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
