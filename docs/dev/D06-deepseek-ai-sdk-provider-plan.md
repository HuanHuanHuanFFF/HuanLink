# DeepSeek AI SDK Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在不改变现有 OpenAI Agents JS Agent Loop、AgentCall/A2A 或 QQ 异步链路的前提下，由 Vercel AI SDK 配置 DeepSeek 官方 `deepseek-v4-flash`，并让生产入口使用该模型。

**方案：** `apps/server` 创建一个 provider-only 模型绑定：`@ai-sdk/deepseek` 负责 DeepSeek 配置，AI SDK middleware 恢复 bridge 丢失的严格工具标记，`@openai/agents-extensions/ai-sdk` 再把模型交给现有 `Agent`。工具定义、Runner、turn 推进和异步回流仍由现有代码负责。

**技术栈：** TypeScript、Vitest、OpenAI Agents JS 0.12、Vercel AI SDK 6、DeepSeek AI SDK provider 2、Node.js Chat Completions-compatible fetch。

## 实施约束

- 只接入 DeepSeek 一个 provider，不建设 provider registry、fallback 或 AI Gateway。
- 不使用 AI SDK `ToolLoopAgent`、`generateText`、`streamText` 或第二份 `tool()` 定义。
- `.env` 只写本地空 Key 占位且不得提交；错误、测试和日志不得输出 Key。
- 文档与代码分别提交；Phase 4 仍需真实 DeepSeek smoke 和真实 QQ 闭环后才算完成。

## Task 1：固定兼容依赖

**文件：**

- 修改：`apps/server/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] 在 `apps/server` 精确固定 `@openai/agents-extensions@0.12.0`、`ai@6.0.224`、`@ai-sdk/deepseek@2.0.47`。
- [ ] 执行 `corepack.cmd pnpm install`，确认 lockfile 只包含预期依赖变化。
- [ ] 执行 `corepack.cmd pnpm --filter @huanlink/server typecheck`，记录接入代码尚未使用依赖但依赖图可解析。
- [ ] 单独提交：`build(server): 添加 AI SDK DeepSeek 依赖`。

## Task 2：MainAgent 模型配置合同

**文件：**

- 修改：`apps/server/tests/runtime-config.test.ts`
- 修改：`apps/server/src/runtime-config.ts`
- 修改：`apps/server/src/index.ts`
- 修改：`.env.example`
- 本地修改但不提交：`.env`

- [ ] RED：先为 DeepSeek 默认 provider/model/base URL、缺失 Key、非 DeepSeek provider、非 HTTPS base URL 和 Key 不泄漏写测试。
- [ ] 运行 `corepack.cmd pnpm --filter @huanlink/server test -- tests/runtime-config.test.ts`，确认测试因模型配置尚不存在而按预期失败。
- [ ] GREEN：新增 `MainAgentModelConfig` 和启动时解析；`loadPhase4QqRuntimeConfigFromEnv()` 返回 `mainAgentModel`。
- [ ] 将 `.env.example` 改为以下合同，并用同一合同更新被 Git 忽略的本地 `.env`：

  ```dotenv
  HUANLINK_MAIN_AGENT_PROVIDER=deepseek
  HUANLINK_MAIN_AGENT_MODEL=deepseek-v4-flash
  HUANLINK_DEEPSEEK_BASE_URL=https://api.deepseek.com/beta
  DEEPSEEK_API_KEY=
  ```

- [ ] 重跑聚焦测试，确认通过；检查 `git status --short --ignored`，确保 `.env` 不在待提交文件中。
- [ ] 单独提交：`feat(server): 添加 MainAgent 模型配置`。

## Task 3：DeepSeek AI SDK 模型绑定

**文件：**

- 新增：`apps/server/src/main-agent-model.ts`
- 新增：`apps/server/tests/main-agent-model.test.ts`
- 修改：`apps/server/src/main-agent-runtime.ts`
- 修改：`apps/server/src/index.ts`

- [ ] RED：用自定义 fake `fetch` 捕获 DeepSeek 请求；通过真实 AI SDK provider、真实 bridge、真实 OpenAI Agents Runner 和现有 `submit_codex_agent_call` 工具完成“工具调用后返回文本”的两次响应。
- [ ] 断言请求 URL 为 `/beta/chat/completions`、模型为 `deepseek-v4-flash`、`thinking.type` 为 `disabled`、函数工具含 `strict: true`，并断言 fake `AgentCallInvoker` 收到任务。
- [ ] 运行 `corepack.cmd pnpm --filter @huanlink/server test -- tests/main-agent-model.test.ts`，确认因模型绑定尚不存在而失败。
- [ ] GREEN：用 `createDeepSeek` 创建模型；用 `wrapLanguageModel` 的 `transformParams` 只为函数工具恢复 `strict: true`；用 `aisdk(...)` 返回现有 Agent 可用的模型及 provider settings。
- [ ] 为 `createPhase3MainAgentRuntime` 增加可选 `modelBinding`，默认值仅保留给现有注入 Runner 的测试；不得复制工具或 Runner。
- [ ] 重跑聚焦测试和 `corepack.cmd pnpm --filter @huanlink/server typecheck`。
- [ ] 单独提交：`feat(server): 创建 DeepSeek AI SDK 模型绑定`。

## Task 4：注入现有 Phase 4 生产链路

**文件：**

- 修改：`apps/server/src/phase3-runtime.ts`
- 修改：`apps/server/src/phase4-qq-runtime.ts`
- 修改：`apps/server/src/main.ts`
- 修改：对应的 `apps/server/tests/*.test.ts`

- [ ] RED：测试生产组装将模型绑定从 Phase 4 传入 Phase 3/MainAgent，同时保留测试 Runner 注入能力。
- [ ] 运行聚焦测试并确认因传递路径缺失而失败。
- [ ] GREEN：只增加 `modelBinding` 参数传递；`main.ts` 根据已校验配置创建 DeepSeek binding 后再连接 QQ。
- [ ] 运行 `corepack.cmd pnpm --filter @huanlink/server test`、`corepack.cmd pnpm --filter @huanlink/server typecheck`、`corepack.cmd pnpm --filter @huanlink/server build`。
- [ ] 单独提交：`feat(server): 注入 DeepSeek MainAgent 模型`。

## Task 5：真实 DeepSeek 工具调用 smoke

**文件：**

- 新增：`apps/server/vitest.real.config.ts`
- 新增：`apps/server/tests/real/deepseek-main-agent.real.ts`
- 修改：`apps/server/package.json`

- [ ] RED：添加 opt-in smoke，要求 `HUANLINK_REAL_DEEPSEEK_TEST=1` 和 `DEEPSEEK_API_KEY`；固定提示词要求模型调用真实 `submit_codex_agent_call`，但以本地记录型 `AgentCallInvoker` 截止，避免在该测试重复触发 Codex 改码。
- [ ] 未设置 opt-in 时测试必须安全跳过；设置 opt-in 但 Key 缺失时必须给出不含敏感值的明确错误。
- [ ] 添加 `test:real:deepseek` 脚本并运行非 opt-in 路径。
- [ ] 用户填写 Key 后执行：

  ```powershell
  $env:HUANLINK_REAL_DEEPSEEK_TEST='1'
  corepack.cmd pnpm --filter @huanlink/server test:real:deepseek
  ```

- [ ] 只输出脱敏证据：模型 ID、是否发生工具调用、最终文本是否非空；不得输出请求头或完整响应。
- [ ] 单独提交：`test(server): 添加真实 DeepSeek 工具调用 smoke`。

## Task 6：全仓验证与 Phase 4 闸门

- [ ] 执行 `corepack.cmd pnpm test`。
- [ ] 执行 `corepack.cmd pnpm typecheck`。
- [ ] 执行 `corepack.cmd pnpm build`。
- [ ] 执行 `git diff --check`，并审阅 `git status --short`、`git diff --stat` 和待推送提交列表。
- [ ] 确认 `.env`、API Key、QQ 群号和 access token 均未进入提交或测试输出。
- [ ] 真实 DeepSeek smoke 通过后，再启动真实 Codex A2A Adapter、HuanLink server 和 LLBot/NapCat，完成真实 QQ Phase 4 闭环。
- [ ] Phase 4 闭环前不标记阶段完成、不进入 Phase 5；完成后按约定报告实际证据并等待用户确认。

## 需求覆盖自检

- 模型/provider 配置只位于 AI SDK 边界：Task 2、3。
- 现有 Agent Loop 和工具唯一性：Task 3 的真实 Runner/现有工具测试。
- DeepSeek strict 工具调用兼容性：Task 3 的出站请求断言与 Task 5 的真实 smoke。
- 生产 QQ 链路实际使用 DeepSeek：Task 4 注入与 Task 6 真实闭环。
- 敏感信息保护与本地 `.env`：Task 2、5、6。
