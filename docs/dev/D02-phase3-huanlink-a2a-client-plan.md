# Phase 3 HuanLink A2A Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task by task, and keep the Phase 3 gate from `23-a2a-first-real-demo-plan.md`.

**Goal:** 让 HuanLink 的真实 MainAgent 能通过标准 A2A Agent Card 发现 Codex 能力，异步提交 AgentCall，立即返回受理结果，并在远端 Task 进入终态后只触发一次新的 MainAgent turn。

**Architecture:** Core 只拥有协议无关的 AgentCall 生命周期、双向 ID 关联和终态通知；新的 A2A Client integration 独占 `@a2a-js/sdk` 类型并负责 Agent Card、Task 提交和订阅；OpenAI Agents integration 提供真实 function tool；`apps/server` 只组装 MainAgent 首次运行与完成后再入。Phase 3 不接 QQ，不引入项目/模型选择、持久化、worktree 或审批回流。

**Tech Stack:** TypeScript/Node.js、Vitest、OpenAI Agents JS 0.12.0、`@a2a-js/sdk@1.0.0-beta.0`、pnpm workspace。

---

## Task 1：Core 异步 AgentCall 生命周期

**Files:**

- Create: `packages/core/src/agent-call/types.ts`
- Create: `packages/core/src/agent-call/agent-call-service.ts`
- Modify: `packages/core/src/shared/ids.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/agent-call-service.test.ts`

1. 先写失败测试，覆盖提交只等待远端 Task 创建、`AgentCallId <-> taskId` 双向查询、后台状态更新以及重复终态只通知一次。
2. 定义框架无关的 capability、request、Task snapshot、artifact、transport 和 AgentCall record；不引用 A2A SDK 类型。
3. 实现内存态 `AgentCallService`：先保存映射再启动受监管 watcher，捕获后台异常，首个终态胜出，并允许注册终态 listener。
4. 增加取消和显式关闭；Phase 3 不做跨进程恢复。
5. 运行：`corepack.cmd pnpm --filter @huanlink/core test -- agent-call-service.test.ts`。

## Task 2：标准 A2A Client integration

**Files:**

- Create: `packages/integrations/a2a-client/package.json`
- Create: `packages/integrations/a2a-client/tsconfig.json`
- Create: `packages/integrations/a2a-client/tsconfig.build.json`
- Create: `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- Create: `packages/integrations/a2a-client/src/index.ts`
- Create: `packages/integrations/a2a-client/tests/a2a-agent-call-transport.test.ts`
- Modify: `pnpm-lock.yaml`

1. 先用受控标准 A2A Server 写黑盒失败测试，证明客户端从 `/.well-known/agent-card.json` 发现能力，而不是硬编码 Codex 私有接口。
2. 精确依赖 `@a2a-js/sdk@1.0.0-beta.0`，通过 `ClientFactory.createFromUrl(origin)` 协商标准 transport，并校验 v1.0、streaming 与目标 skill。
3. 使用 `SendMessage(returnImmediately: true)` 创建 Task；若返回直接 Message 则明确失败，因为 AgentCall 必须取得 taskId。
4. 使用 `resubscribeTask` 观察状态，终态后以 `GetTask` 的完整 snapshot/artifacts 为真值；处理“订阅前已终态”的 `UnsupportedOperationError -> GetTask` 竞态。
5. 把 A2A TaskState、文本 Artifact 映射为 Core 类型，不把 SDK 类型导出到 integration 之外。
6. 运行：`corepack.cmd pnpm --filter @huanlink/integration-a2a-client test`。

## Task 3：OpenAI Agents 异步委派 tool

**Files:**

- Create: `packages/integrations/openai-agents/src/agent-call-tool.ts`
- Modify: `packages/integrations/openai-agents/src/openai-agents-runtime.ts`
- Modify: `packages/integrations/openai-agents/src/index.ts`
- Modify: `packages/integrations/openai-agents/package.json`
- Modify: `packages/integrations/openai-agents/tests/openai-agents-runtime.test.ts`
- Create: `packages/integrations/openai-agents/tests/agent-call-tool.test.ts`

1. 先写失败测试，证明 `runId/sessionId` 通过 SDK `RunContext` 传给 tool。
2. 用真实 `tool()` 创建 `submit_codex_agent_call`，模型参数只包含代码任务文本，内部关联 ID 从 RunContext 取得。
3. tool 调用 Core 的 submitter，只等待 A2A 受理，返回包含 `agentCallId/taskId/status=accepted` 的文本结果。
4. MainAgent 配置可用 `stopAtToolNames` 在 tool 成功后直接结束首次 run，避免等待远端终态或额外模型轮次。
5. 用真实 Runner + 确定性 mock Model 跑通 function call，证明 MainAgent 可以自主选择委派且首次 run 不等待后台完成。
6. 运行：`corepack.cmd pnpm --filter @huanlink/integration-openai-agents test`。

## Task 4：Server 组装与完成后 MainAgent 再入

**Files:**

- Create: `apps/server/src/main-agent-runtime.ts`
- Create: `apps/server/src/agent-call-reentry.ts`
- Modify: `apps/server/src/runtime-config.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/package.json`
- Create: `apps/server/tests/phase3-orchestration.test.ts`
- Modify: `apps/server/tests/runtime-config.test.ts`

1. 先写失败集成测试：第一次 MainAgent run 经 tool 返回 accepted；远端 gate 未释放时首次 run 已结束；终态后产生第二个新 run。
2. 扩展启动配置，读取 Codex A2A Adapter origin，默认 skill 为 `codex-code-task`；不增加任意 workspace、模型或文件范围参数。
3. 组装 A2A transport、AgentCallService 与 OpenAI Agents MainAgent；server 不保存重复的生命周期 Map。
4. 注册终态 listener：为同一 session 创建新 runId，把标准 Task 状态和 Artifact 作为新输入；通过回调暴露最终输出，供 Phase 4 QQ egress 接入。
5. 证明 completed/failed/canceled/rejected 都能再入，重复终态不会产生第三次 turn。
6. 运行：`corepack.cmd pnpm --filter @huanlink/server test`。

## Task 5：Phase 3 验收、记录与推送

**Files:**

- Modify: `docs/dev/23-a2a-first-real-demo-plan.md`
- Modify: `docs/dev/D02-phase3-huanlink-a2a-client-plan.md`（仅在实际实现偏差需要记录时）

1. 运行 package 级测试，并执行全仓：
   - `corepack.cmd pnpm test`
   - `corepack.cmd pnpm typecheck`
   - `corepack.cmd pnpm build`
2. 运行 Phase 3 黑盒 smoke：标准 A2A HTTP 服务 + 官方 Client + 真实 OpenAI Agents Runner（确定性测试模型），验证受理、双向映射、后台订阅和一次再入。该 smoke 不冒充 Phase 5 的真实模型/QQ/Codex 代码修改闭环。
3. 在 23 号文档追加 Phase 3 实际核验记录，清楚区分已完成能力与 Phase 4/5 尚未完成内容。
4. 检查 `git diff --check` 和分支必须仍为 `spike/demo-v0`。
5. 使用中文 Conventional Commit 提交，推送 `origin/spike/demo-v0`，不 merge、不建 PR，并停在 Phase 3 gate 等待用户确认。
