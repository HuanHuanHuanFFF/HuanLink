# Phase 4 Task Control and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开启 DeepSeek 高推理，补齐 session 内任务查询、A2A `input-required` 同任务续跑、Adapter 结果校验和 server/adapter 本地 JSONL 全链路日志。

**Architecture:** HuanLink 继续以 `AgentCallService` 维护协议无关的本地任务记录，通过 OpenAI Agents tools 暴露查询和续跑；A2A transport 用带 `taskId` 的标准 Message 恢复原任务。运行日志复用 core `RuntimeLogger/Pino`，server 与 Adapter 分进程写文件并使用关联 ID 串联，不扩展旧自研 AgentLoop 的 EventLog schema。

**Tech Stack:** TypeScript、Vitest、OpenAI Agents JS、Vercel AI SDK DeepSeek provider、A2A JS SDK v1.0 beta、Pino、pnpm workspace。

---

### Task 1: DeepSeek high reasoning

**Files:**
- Modify: `apps/server/src/main-agent-model.ts`
- Modify: `apps/server/tests/main-agent-model.test.ts`

- [ ] **Step 1: Add a failing provider-options assertion**

Assert the model binding contains:

```ts
deepseek: {
  thinking: { type: "enabled" },
  reasoningEffort: "high"
}
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `corepack.cmd pnpm --filter @huanlink/server test -- main-agent-model.test.ts`

Expected: FAIL because `thinking.type` is currently `disabled`.

- [ ] **Step 3: Change only the DeepSeek provider options**

Keep the current model ID and bridge; enable thinking and high effort without adding a new model selector.

- [ ] **Step 4: Run focused verification and commit**

Run the focused test plus `corepack.cmd pnpm --filter @huanlink/server typecheck`.

Commit: `feat(server): 开启 DeepSeek 高推理`

### Task 2: Session-scoped task status tool

**Files:**
- Modify: `packages/core/src/agent-call/types.ts`
- Modify: `packages/core/src/agent-call/agent-call-service.ts`
- Create: `packages/integrations/openai-agents/src/task-status-tool.ts`
- Modify: `packages/integrations/openai-agents/src/index.ts`
- Create: `packages/integrations/openai-agents/tests/task-status-tool.test.ts`
- Modify: `apps/server/src/main-agent-runtime.ts`
- Modify: `apps/server/src/phase3-runtime.ts`
- Modify: `apps/server/tests/phase3-orchestration.test.ts`

- [ ] **Step 1: Specify reader and tool behavior with failing tests**

Define a reader contract exposing lookup by HuanLink AgentCall ID and external task ID. Test that `get_task_status`:

```ts
{ taskId: "known-huanlink-or-a2a-id" }
```

returns the canonical HuanLink ID, external A2A ID, state, execution mode, timestamps, status message and artifacts only when `record.sessionId === runContext.sessionId`.

Test unknown and cross-session IDs return a non-revealing `not-found` result. Spy on the submit invoker and prove no AgentCall is created.

- [ ] **Step 2: Run core/integration/server focused tests and observe failure**

Run the new integration test and the Phase 3 orchestration test.

- [ ] **Step 3: Implement `get_task_status`**

Use the existing in-memory AgentCall snapshots as the current Demo source of truth. Add MainAgent instructions that status/report requests use this tool and never `submit_codex_agent_call`.

- [ ] **Step 4: Verify and commit**

Run focused tests and typecheck affected packages.

Commit: `feat(tasks): 支持会话内任务状态查询`

### Task 3: Honest Adapter completion

**Files:**
- Modify: `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- Modify: `apps/codex-a2a-adapter/tests/codex-task-executor.test.ts`
- Modify: `apps/codex-a2a-adapter/tests/task-lifecycle.test.ts`

- [ ] **Step 1: Add failing result-classification tests**

Cover these cases:

1. `agentMessage.phase === "commentary"` 只更新过程摘要，`phase === "final_answer"` 才更新最终回答；空消息不能覆盖已有非空内容。
2. A completed Codex turn with no meaningful `final_answer`, changed file or diff becomes failed rather than A2A completed.
3. A real file change with an empty summary still completes and reports the changed file/diff.
4. A non-changing task with a meaningful final explanation may complete.

- [ ] **Step 2: Run Adapter focused tests and observe failure**

Run: `corepack.cmd pnpm --filter @huanlink/codex-a2a-adapter test -- codex-task-executor.test.ts task-lifecycle.test.ts`

- [ ] **Step 3: Separate final outcome from incidental agent messages**

Track commentary and `final_answer` separately, validate the observable result before `TASK_STATE_COMPLETED`, and make failure status/Artifact describe the same reason. Extend developer instructions so harmless implementation/style choices are resolved autonomously and genuine blockers use the native `request_user_input` tool.

- [ ] **Step 4: Verify and commit**

Run focused Adapter tests and Adapter typecheck.

Commit: `fix(codex-adapter): 避免空结果任务误报完成`

### Task 4: A2A pause and same-task continuation

**Files:**
- Modify: `packages/core/src/agent-call/types.ts`
- Modify: `packages/core/src/agent-call/agent-call-service.ts`
- Modify: `packages/core/tests/agent-call-service.test.ts`
- Modify: `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- Modify: `packages/integrations/a2a-client/tests/a2a-agent-call-transport.test.ts`
- Create: `packages/integrations/openai-agents/src/task-continuation-tool.ts`
- Create: `packages/integrations/openai-agents/tests/task-continuation-tool.test.ts`
- Modify: `packages/integrations/openai-agents/src/index.ts`
- Modify: `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- Modify: `apps/codex-a2a-adapter/src/codex-app-server-client.ts`
- Modify: `apps/codex-a2a-adapter/tests/codex-app-server-client.test.ts`
- Modify: `apps/codex-a2a-adapter/tests/task-lifecycle.test.ts`
- Modify: `apps/server/src/agent-call-reentry.ts`
- Modify: `apps/server/src/main-agent-runtime.ts`
- Modify: `apps/server/src/phase3-runtime.ts`
- Modify: `apps/server/src/phase4-qq-runtime.ts`
- Modify: `apps/server/tests/phase3-orchestration.test.ts`
- Modify: `apps/server/tests/phase4-qq-orchestration.test.ts`
- Modify: `packages/core/src/conversations/in-memory-conversation-store.ts`
- Modify: `packages/core/tests/in-memory-conversation-store.test.ts`

- [ ] **Step 1: Add failing transport and service tests**

Extend `AgentCallTransport` with a continuation request containing `taskId`, `messageId`, structured `answers`, optional `contextId` and signal. `answers` uses question IDs from the paused status and arrays of selected/free-form answers. Verify A2A Client sends a standard user Message with the original `taskId` plus a structured data Part, and `AgentCallService.continueTask()` accepts only paused tasks, applies the resumed snapshot and restarts its watcher.

- [ ] **Step 2: Add failing MainAgent and QQ re-entry tests**

Verify `input-required` triggers exactly one fresh MainAgent turn with:

```text
paused task snapshot + status question + artifacts + full available session context
```

Verify the MainAgent can either emit a QQ question or call:

```ts
{
  taskId: "huanlink-task-id",
  answers: [{ questionId: "choice", answers: ["selected answer"] }]
}
```

Continuation uses the original HuanLink/A2A IDs and does not increment the transport submission count. Cross-session continuation returns not found.

- [ ] **Step 3: Add failing Adapter resume test**

Make the fake app-server send its native `item/tool/requestUserInput` JSON-RPC server request. Assert Adapter publishes A2A `input-required` with question IDs/options. Send an A2A Message associated with the paused `taskId`, then assert Adapter responds to the pending app-server request, the same A2A Task returns to working, and the existing Codex thread and turn continue without creating another A2A Task or turn.

- [ ] **Step 4: Implement pause notification, continuation and context capture**

Teach `CodexAppServerClient` to surface and answer JSON-RPC server requests. Add a paused listener distinct from the terminal listener. Store both inbound channel messages and HuanLink outbound replies in session context. Enable `continue_task` only for a task owned by the current session. During `input-required` re-entry, expose only `get_task_status` and `continue_task`; keep `submit_codex_agent_call` disabled so the MainAgent cannot replace the paused task with a new one.

- [ ] **Step 5: Verify and commit in two slices**

First commit the protocol/core continuation:

`feat(a2a): 支持暂停任务原地续跑`

Then commit MainAgent/QQ re-entry and context behavior:

`feat(server): 支持 input-required 决策回流`

### Task 5: Local JSONL runtime logging

**Files:**
- Create: `packages/core/src/logging/jsonl-file-runtime-logger.ts`
- Modify: `packages/core/src/logging/pino-runtime-logger.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/jsonl-file-runtime-logger.test.ts`
- Modify: `packages/integrations/onebot11/src/forward-websocket-channel.ts`
- Modify: `packages/integrations/onebot11/tests/forward-websocket-channel.test.ts`
- Modify: `packages/core/src/agent-call/agent-call-service.ts`
- Modify: `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- Modify: `apps/server/src/runtime-config.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/phase3-runtime.ts`
- Modify: `apps/server/src/phase4-qq-runtime.ts`
- Modify: `apps/server/tests/runtime-config.test.ts`
- Modify: `apps/server/tests/phase4-qq-orchestration.test.ts`
- Modify: `apps/codex-a2a-adapter/package.json`
- Modify: `apps/codex-a2a-adapter/src/runtime-config.ts`
- Modify: `apps/codex-a2a-adapter/src/main.ts`
- Modify: `apps/codex-a2a-adapter/src/codex-app-server-client.ts`
- Modify: `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- Modify: `apps/codex-a2a-adapter/tests/runtime-config.test.ts`
- Modify: `pnpm-lock.yaml`
- Local only: `.env`

- [ ] **Step 1: Add failing logger tests**

Test append-only JSONL, mandatory secret redaction, info summaries, debug business payloads, child correlation fields, close/flush and non-fatal sink errors.

- [ ] **Step 2: Implement file logger and two process files**

Create `.huanlink/logs/server.jsonl` and `.huanlink/logs/codex-a2a-adapter.jsonl`. Keep legacy AgentEvent/EventLog types unchanged.

- [ ] **Step 3: Instrument important boundaries**

Emit named events for process lifecycle, OneBot connection/message/reply, MainAgent runs/tools, AgentCall/A2A state transitions, Adapter tasks, Codex thread/turn, artifacts, re-entry and errors. Use IDs already available at each boundary; do not invent missing IDs.

- [ ] **Step 4: Set local debug level safely**

Change only `HUANLINK_LOG_LEVEL=debug` in ignored `.env`; never print or commit secrets.

- [ ] **Step 5: Verify and commit in two slices**

Core/server commit:

`feat(logging): 记录 HuanLink 本地 JSONL 链路日志`

Adapter commit:

`feat(codex-adapter): 记录 Codex 执行链路日志`

### Task 6: Final verification and implementation record

**Files:**
- Modify: `docs/dev/D06-phase4-task-control-observability-design.md`
- Modify: `docs/dev/23-a2a-first-real-demo-plan.md` only for verified Phase 4 facts

- [ ] **Step 1: Run package and workspace verification**

Run affected focused tests, then:

```powershell
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
```

- [ ] **Step 2: Run real smoke tests**

Run the real DeepSeek tool smoke, then start server and Adapter and exercise QQ -> MainAgent -> A2A -> Codex, task query and completion return. If no natural `input-required` case occurs, use the real Adapter with a controlled instruction that requires a missing material choice; do not mock the final evidence.

- [ ] **Step 3: Inspect JSONL evidence and workspace state**

Verify both log files parse line-by-line as JSON and correlate at least one real task. Confirm `test.md` remains untracked and unstaged.

- [ ] **Step 4: Update docs in a separate commit**

Record only verified results and exact commands/counts.

Commit: `docs(demo): 记录 Phase 4 加固验证结果`

- [ ] **Step 5: Push without merge**

Push `spike/demo-v0` after all commits and report commit IDs plus verification evidence.
