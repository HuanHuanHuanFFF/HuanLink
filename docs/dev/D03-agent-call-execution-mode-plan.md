# AgentCall Execution Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前 Codex AgentCall 支持 `executionMode: "background" | "wait"`，其中后台模式让 MainAgent 在受理后继续当前 turn 并在终态回流，等待模式在当前 turn 消费结果且不产生重复回流。

**Architecture:** 保留现有 A2A Transport、AgentCall 状态跟踪和同 session 调度。Core 增加可复用的执行模式类型以及 `invoke()/waitForOutcome()` 语义；OpenAI Agents Tool 将统一模式字段转换为 Core 调用；`apps/server` 移除 `stopAtToolNames`，让 Runner 在 Tool 返回后继续生成自然回复。当前增量只落地 Codex 这个首个 Agent Task，不在本计划中重写通用 TaskService、OneBot Channel 或本地 Worker Agent。

**Tech Stack:** TypeScript、Vitest、OpenAI Agents JS、A2A JS SDK、pnpm workspace

**Status（2026-07-12）：** 已由代码提交 `add7bed` 实现并完成复审；全仓 26 个测试文件、139 个测试通过，typecheck 与 build 通过。

---

## 文件职责

- Create: `packages/core/src/tasks/types.ts`：声明协议无关的 `TaskExecutionMode`。
- Modify: `packages/core/src/index.ts`：导出执行模式类型。
- Modify: `packages/core/src/agent-call/types.ts`：让 AgentCall 请求、记录、回执和调用结果携带执行模式。
- Modify: `packages/core/src/agent-call/agent-call-service.ts`：实现模式分派、等待 outcome 和 wait 模式终态回流抑制。
- Test: `packages/core/tests/agent-call-service.test.ts`：验证 background/wait 的 Core 生命周期。
- Modify: `packages/integrations/openai-agents/src/agent-call-tool.ts`：暴露可选 `executionMode`，默认 background，并调用 `invoke()`。
- Test: `packages/integrations/openai-agents/tests/agent-call-tool.test.ts`：验证真实 Runner 会在 Tool 结果后继续，以及 wait 结果可回到当前 turn。
- Modify: `apps/server/src/main-agent-runtime.ts`：移除 `stopAtToolNames`，更新 MainAgent 模式选择说明。
- Modify: `apps/server/src/phase3-runtime.ts`：把现有 `AgentCallService` 作为 Tool-facing invoker 注入。
- Test: `apps/server/tests/phase3-orchestration.test.ts`：黑盒验证 background 快速回复加终态回流，以及 wait 阻塞当前 turn 但不重复回流。

### Task 1: Core AgentCall execution semantics

**Files:**
- Create: `packages/core/src/tasks/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/agent-call/types.ts`
- Modify: `packages/core/src/agent-call/agent-call-service.ts`
- Test: `packages/core/tests/agent-call-service.test.ts`

- [ ] **Step 1: Write failing Core tests**

Add requests with explicit modes and verify the two delivery paths:

```ts
const background = await service.invoke({
  runId: "run-background",
  sessionId: "session-background",
  skillId: "codex-code-task",
  input: "run in background",
  executionMode: "background"
});

expect(background).toMatchObject({
  status: "accepted",
  executionMode: "background"
});
```

```ts
const waiting = service.invoke({
  runId: "run-wait",
  sessionId: "session-wait",
  skillId: "codex-code-task",
  input: "wait for completion",
  executionMode: "wait"
});

releaseCompletion.resolve();
await expect(waiting).resolves.toMatchObject({
  status: "result",
  executionMode: "wait",
  state: "completed"
});
expect(terminalListener).not.toHaveBeenCalled();
```

Update all existing `submit()` fixtures to include `executionMode: "background"` and assert that background records still notify once.

- [ ] **Step 2: Run the focused Core test and verify RED**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/core test -- agent-call-service.test.ts
```

Expected: FAIL because `invoke`, `TaskExecutionMode`, and `executionMode` do not exist.

- [ ] **Step 3: Add the protocol-neutral execution mode type**

Create `packages/core/src/tasks/types.ts`:

```ts
export const TASK_EXECUTION_MODES = ["background", "wait"] as const;

export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];
```

Export it from `packages/core/src/index.ts`:

```ts
export * from "./tasks/types.js";
```

- [ ] **Step 4: Extend AgentCall public contracts**

Add `executionMode: TaskExecutionMode` to `AgentCallRequest`, `AgentCallRecord`, and `AgentCallReceipt`. Add the wait result and invoker contracts:

```ts
export type AgentCallWaitResult = {
  status: "result";
  executionMode: "wait";
  agentCallId: AgentCallId;
  taskId: string;
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  statusMessage?: string;
};

export type AgentCallInvocationResult = AgentCallReceipt | AgentCallWaitResult;

export interface AgentCallInvoker {
  invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult>;
}
```

Keep `submit()` public for lifecycle/query tests, but replace the Tool-facing `AgentCallSubmitter` dependency with `AgentCallInvoker`.

Add an explicit outcome predicate so wait mode returns for terminal states and for states that require caller input:

```ts
export function isAgentCallOutcomeState(state: AgentCallTaskState): boolean {
  return (
    isAgentCallTerminalState(state) ||
    state === "input-required" ||
    state === "auth-required"
  );
}
```

- [ ] **Step 5: Implement mode dispatch and outcome waiting**

Make `AgentCallService` implement `AgentCallInvoker`:

```ts
async invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult> {
  const receipt = await this.submit(request);
  if (request.executionMode === "background") {
    return receipt;
  }

  const record = await this.waitForOutcome(receipt.agentCallId);
  return {
    status: "result",
    executionMode: "wait",
    agentCallId: record.agentCallId,
    taskId: record.taskId,
    state: record.state,
    artifacts: record.artifacts,
    ...(record.statusMessage === undefined
      ? {}
      : { statusMessage: record.statusMessage })
  };
}
```

`waitForOutcome()` returns when the record is terminal or paused for `input-required/auth-required`. It first checks the current record, otherwise awaits the active watcher and validates the resulting state:

```ts
async waitForOutcome(agentCallId: AgentCallId): Promise<AgentCallRecord> {
  const current = this.requireRecord(agentCallId);
  if (isAgentCallOutcomeState(current.state)) {
    return this.requireRecordClone(agentCallId);
  }

  const watcher = this.activeWatchers.get(agentCallId);
  if (!watcher) {
    throw new Error(`AgentCall ${agentCallId} has no active watcher`);
  }
  await watcher.promise;

  const outcome = this.requireRecord(agentCallId);
  if (!isAgentCallOutcomeState(outcome.state)) {
    throw new Error(`AgentCall ${agentCallId} stopped before an outcome`);
  }
  return this.requireRecordClone(agentCallId);
}
```

Persist the mode when building the record and receipt. In `applySnapshot()`, notify terminal listeners only for background calls:

```ts
if (updated.executionMode === "wait") {
  return;
}
```

- [ ] **Step 6: Run Core tests and verify GREEN**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/core test
corepack.cmd pnpm --filter @huanlink/core typecheck
```

Expected: all Core tests pass and TypeScript reports no errors.

### Task 2: OpenAI Agents Tool continuation

**Files:**
- Modify: `packages/integrations/openai-agents/src/agent-call-tool.ts`
- Test: `packages/integrations/openai-agents/tests/agent-call-tool.test.ts`

- [ ] **Step 1: Write failing Runner tests**

Replace the one-response test model with a model that calls the Tool first and returns a normal assistant message after receiving the Tool result. Cover both inputs:

```ts
arguments: JSON.stringify({
  task: "add one focused validation and test it",
  executionMode: "wait"
})
```

For background, omit the field and assert the invoker receives `executionMode: "background"`. For wait, assert it receives `"wait"`. In both cases assert `model.requests` has length `2`, proving the Runner continued after the Tool result.

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/integration-openai-agents test -- agent-call-tool.test.ts
```

Expected: FAIL because the Tool only accepts `task` and calls `submit()`.

- [ ] **Step 3: Add executionMode to the Tool wrapper**

Update the Zod parameters and execution logic:

```ts
const parameters = z.object({
  task: z.string().trim().min(1),
  executionMode: z
    .enum(TASK_EXECUTION_MODES)
    .optional()
    .describe("Use background unless the user explicitly asks to wait.")
});
```

```ts
execute: async ({ task, executionMode = "background" }, runContext) => {
  if (!runContext) {
    throw new Error("Codex AgentCall tool requires a HuanLink RunContext");
  }

  return JSON.stringify(
    await options.invoker.invoke({
      runId: runContext.context.runId,
      sessionId: runContext.context.sessionId,
      contextId: runContext.context.sessionId,
      skillId,
      input: task,
      executionMode
    })
  );
}
```

Keep the Tool disabled during `agent_call_terminal` re-entry.

- [ ] **Step 4: Run integration tests and typecheck**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/integration-openai-agents test
corepack.cmd pnpm --filter @huanlink/integration-openai-agents typecheck
```

Expected: all integration tests pass and TypeScript reports no errors.

### Task 3: MainAgent background and wait orchestration

**Files:**
- Modify: `apps/server/src/main-agent-runtime.ts`
- Modify: `apps/server/src/phase3-runtime.ts`
- Test: `apps/server/tests/phase3-orchestration.test.ts`

- [ ] **Step 1: Rewrite the background orchestration test for natural acknowledgement**

The deterministic model must produce three responses:

```text
1. submit_codex_agent_call(background)
2. "Codex task was accepted."
3. "Codex task finished and is ready to report."
```

Keep the remote completion gate closed until response 2 is returned. Assert the initial `runMainAgent()` resolves before the remote task and that the terminal result later triggers exactly one re-entry.

- [ ] **Step 2: Add a failing wait orchestration test**

Use a controlled A2A executor and call the Tool with `executionMode: "wait"`. Assert:

```ts
expect(initialRunSettled).toBe(false);
remoteCompletion.resolve();
await expect(initialRun).resolves.toMatchObject({
  output: "Codex task completed in the current turn."
});
expect(onReentry).not.toHaveBeenCalled();
```

Also assert the second model request contains the completed artifact and that the Tool remains disabled only for actual terminal re-entry runs.

- [ ] **Step 3: Run the server test and verify RED**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/server test -- phase3-orchestration.test.ts
```

Expected: FAIL because `stopAtToolNames` ends the initial run and wait mode is unavailable.

- [ ] **Step 4: Remove forced stop and update MainAgent instructions**

Create the Tool with `invoker: options.invoker`, remove `toolUseBehavior.stopAtToolNames`, and use instructions with these exact semantics:

```ts
"Use executionMode background unless the user explicitly asks to wait for completion.",
"After a background task is accepted, acknowledge its task ID and continue the current turn without waiting.",
"After a wait-mode task returns, use its result in the current turn.",
"When receiving an AgentCall terminal notification, summarize that result and the supplied latest context; do not delegate it again."
```

Pass the existing `AgentCallService` as the invoker from `phase3-runtime.ts`; do not change A2A transport behavior.

- [ ] **Step 5: Run server tests and typecheck**

Run:

```powershell
corepack.cmd pnpm --filter @huanlink/server test
corepack.cmd pnpm --filter @huanlink/server typecheck
```

Expected: all server tests pass and TypeScript reports no errors.

### Task 4: Repository verification and code commit

**Files:**
- Verify only; no docs files may be staged with code.

- [ ] **Step 1: Run full verification**

Run:

```powershell
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
```

Expected: all workspace tests pass, typecheck passes, and every package builds.

- [ ] **Step 2: Inspect the final code-only diff**

Run:

```powershell
git status --short
git diff --check
git diff -- packages/core packages/integrations/openai-agents apps/server
```

Expected: no whitespace errors; no `docs/` path appears in the code commit.

- [ ] **Step 3: Create the code commit**

Run:

```powershell
git add packages/core packages/integrations/openai-agents apps/server
git commit -m "feat(agent-call): 支持 background 和 wait 调用"
```

Expected: one code-only commit on `spike/demo-v0`.
