import { expect, test, vi } from "vitest";

import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AgentCallService,
  AsyncToolTaskService,
  SessionTaskQuotaService,
  type AgentCallInputAnswers,
  type AgentCallTransport,
} from "../src/index.js";
import {
  acceptedTask,
  deferred,
  rejectUnexpectedContinuation,
  task,
} from "./agent-call-test-helpers.js";

test("rejects split quota owners before any AgentCall can run", () => {
  const taskService = new AsyncToolTaskService({
    quotaService: new SessionTaskQuotaService({
      limits: { a2a: 2, "async-tool": 3 },
    }),
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });

  expect(
    () =>
      new AgentCallService({
        transport: {
          discoverCapability: async (skillId) => ({
            id: skillId,
            name: skillId,
          }),
          submitTask: async () => acceptedTask("submitted"),
          async *watchTask() {},
          continueTask: rejectUnexpectedContinuation,
          cancelTask: async (taskId) => task("canceled", { taskId }),
        },
        taskService,
        quotaService: new SessionTaskQuotaService({
          limits: { a2a: 2, "async-tool": 3 },
        }),
      }),
  ).toThrow(/must share one quota service/);
});

test("reserves an async AgentCall before transport and returns only its HuanLink task ID", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-01",
  });
  const discoverCapability = vi.fn(async (skillId: string) => {
    expect(taskService.getStatus("session-01", "huan-task-01")).toMatchObject({
      status: "found",
      taskId: "huan-task-01",
      state: "submitting",
    });
    return { id: skillId, name: "Codex code task" };
  });
  const transport: AgentCallTransport = {
    discoverCapability,
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask(_taskId, { signal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });

  const result = await service.invoke({
    runId: "run-01",
    sessionId: "session-01",
    skillId: "codex-code-task",
    input: "make a focused code change",
    executionMode: "async",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-01",
  });

  expect(discoverCapability).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    status: "accepted",
    taskId: "huan-task-01",
    state: "submitted",
  });
  expect(taskService.getStatus("session-01", "huan-task-01")).toMatchObject({
    status: "found",
    taskId: "huan-task-01",
    kind: "agent-call",
    toolName: "submit_codex_agent_call",
    state: "submitted",
    payload: { artifacts: [] },
  });

  await service.close();
});

test("publishes AgentCall snapshots and terminal notification through the common Task service", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-terminal",
  });
  const taskTerminal = vi.fn();
  taskService.onTerminal(taskTerminal);
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask() {
      yield task("working");
      yield task("completed", {
        artifacts: [{ id: "artifact-01", text: "completed result" }],
        statusMessage: "done",
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });

  await service.invoke({
    runId: "run-terminal",
    sessionId: "session-terminal",
    skillId: "codex-code-task",
    input: "complete asynchronously",
    executionMode: "async",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-terminal",
  });
  await service.waitForIdle();

  expect(
    taskService.getStatus("session-terminal", "huan-task-terminal"),
  ).toMatchObject({
    status: "found",
    taskId: "huan-task-terminal",
    state: "completed",
    statusMessage: "done",
    payload: {
      artifacts: [{ id: "artifact-01", text: "completed result" }],
    },
  });
  expect(taskTerminal).toHaveBeenCalledTimes(1);
  expect(taskTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: "huan-task-terminal",
      state: "completed",
    }),
  );
  await service.close();
});

test("publishes input-required once through the common Task service with its questions", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-input",
  });
  const inputRequired = vi.fn();
  taskService.onInputRequired(inputRequired);
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask() {
      const paused = task("input-required", {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which files may be changed?",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
        statusMessage: "choose scope",
      });
      yield paused;
      yield paused;
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });

  await service.invoke({
    runId: "run-input",
    sessionId: "session-input",
    skillId: "codex-code-task",
    input: "pause for input",
    executionMode: "async",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-input",
  });
  await service.waitForIdle();

  expect(inputRequired).toHaveBeenCalledTimes(1);
  expect(inputRequired).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: "huan-task-input",
      state: "input-required",
      sourceToolCallId: "tool-call-input",
      payload: {
        artifacts: [],
        questions: [expect.objectContaining({ id: "scope" })],
      },
    }),
  );
  expect(
    taskService.getStatus("session-input", "huan-task-input"),
  ).toMatchObject({
    status: "found",
    state: "input-required",
    statusMessage: "choose scope",
    payload: {
      questions: [expect.objectContaining({ id: "scope" })],
    },
  });

  await service.close();
});

test("continues an initially input-required AgentCall without stale re-entry or snapshot rollback", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 1,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-initial-input",
  });
  const releaseCompletion = deferred();
  const continueTask = vi.fn(async () => task("working"));
  const watchTask = vi.fn(async function* () {
    yield task("working");
    await releaseCompletion.promise;
    yield task("completed", {
      artifacts: [{ id: "artifact-initial-input", text: "completed once" }],
    });
  });
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () =>
      acceptedTask("input-required", {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which files may be changed?",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
      }),
    watchTask,
    continueTask,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });
  const inputRequired = vi.fn();
  const terminal = vi.fn();
  let continuation: ReturnType<AgentCallService["continueTask"]> | undefined;
  let listenerIdle: Promise<void> | undefined;
  let listenerIdleSettled = false;
  taskService.onInputRequired(() => {
    inputRequired();
    if (continuation === undefined) {
      listenerIdle = service.waitForIdle().finally(() => {
        listenerIdleSettled = true;
      });
      continuation = service.continueTask({
        sessionId: "session-initial-input",
        taskId: "huan-task-initial-input",
        answers: { scope: ["Core only"] },
      });
    }
  });
  taskService.onTerminal(terminal);

  await service.invoke({
    runId: "run-initial-input",
    sessionId: "session-initial-input",
    skillId: "codex-code-task",
    input: "start by asking for scope",
    executionMode: "async",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-initial-input",
  });
  if (continuation === undefined) {
    throw new Error(
      "Expected the input-required listener to continue the Task",
    );
  }
  await continuation;
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(
    taskService.getStatus("session-initial-input", "huan-task-initial-input"),
  ).toMatchObject({ status: "found", state: "working" });
  expect(inputRequired).toHaveBeenCalledTimes(1);
  expect(continueTask).toHaveBeenCalledTimes(1);
  expect(watchTask).toHaveBeenCalledTimes(1);
  expect(terminal).not.toHaveBeenCalled();
  expect(listenerIdleSettled).toBe(false);

  releaseCompletion.resolve();
  await listenerIdle;
  await service.waitForIdle();
  expect(
    taskService.getStatus("session-initial-input", "huan-task-initial-input"),
  ).toMatchObject({
    status: "found",
    state: "completed",
    payload: {
      artifacts: [{ id: "artifact-initial-input", text: "completed once" }],
    },
  });
  expect(inputRequired).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledTimes(1);

  await service.close();
});

test("continues an input-required AgentCall by same-Session HuanLink task ID", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-continue",
  });
  let watchCycle = 0;
  const continueTask = vi.fn(async () => task("working"));
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask(_taskId, { signal }) {
      watchCycle += 1;
      if (watchCycle === 1) {
        yield task("input-required", {
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files may be changed?",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        });
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    continueTask,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });
  await service.invoke({
    runId: "run-continue",
    sessionId: "session-continue",
    skillId: "codex-code-task",
    input: "pause then continue",
    executionMode: "async",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-continue",
  });
  await service.waitForIdle();

  const result = await service.continueTask({
    sessionId: "session-continue",
    taskId: "huan-task-continue",
    answers: { scope: ["Core only"] },
  });

  expect(result).toEqual({
    status: "continued",
    taskId: "huan-task-continue",
    state: "working",
  });
  expect(continueTask).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: "a2a-task-01",
      answers: { scope: ["Core only"] },
    }),
  );
  expect(
    taskService.getStatus("session-continue", "huan-task-continue"),
  ).toMatchObject({
    status: "found",
    state: "working",
    payload: { artifacts: [] },
  });

  await service.close();
});

test.each<{
  label: string;
  answers: AgentCallInputAnswers;
}>([
  { label: "a missing question", answers: {} },
  { label: "an unknown question", answers: { unknown: ["value"] } },
  { label: "an empty answer array", answers: { scope: [] } },
  { label: "a blank answer", answers: { scope: ["   "] } },
])(
  "rejects continuation answers with $label before transport",
  async ({ answers }) => {
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => "huan-task-invalid-answers",
    });
    const continueTask = vi.fn(async () => task("working"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => acceptedTask("submitted"),
      async *watchTask() {
        yield task("input-required", {
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files may be changed?",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        });
      },
      continueTask,
      cancelTask: async (taskId) => task("canceled", { taskId }),
    };
    const service = new AgentCallService({ transport, taskService });
    await service.invoke({
      runId: "run-invalid-answers",
      sessionId: "session-invalid-answers",
      skillId: "codex-code-task",
      input: "pause for an answer",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-invalid-answers",
    });
    await service.waitForIdle();

    await expect(
      service.continueTask({
        sessionId: "session-invalid-answers",
        taskId: "huan-task-invalid-answers",
        answers,
      }),
    ).resolves.toEqual({
      status: "invalid-answers",
      taskId: "huan-task-invalid-answers",
      error:
        "Answers must cover every pending question exactly once with at least one non-blank answer.",
    });
    expect(continueTask).not.toHaveBeenCalled();

    await service.close();
  },
);

test("rejects and releases an async reservation when transport fails before acceptance", async () => {
  const taskIds = ["huan-task-rejected", "huan-task-after-rejection"];
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 1,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => taskIds.shift()!,
  });
  const taskTerminal = vi.fn();
  taskService.onTerminal(taskTerminal);
  const transportFailure = new Error("capability discovery failed");
  const discoverCapability = vi
    .fn<(skillId: string) => Promise<{ id: string; name: string }>>()
    .mockRejectedValueOnce(transportFailure)
    .mockImplementationOnce(async (skillId) => ({
      id: skillId,
      name: skillId,
    }));
  const submitTask = vi.fn(async () => acceptedTask("submitted"));
  const transport: AgentCallTransport = {
    discoverCapability,
    submitTask,
    async *watchTask(_taskId, { signal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });

  await expect(
    service.invoke({
      runId: "run-rejected",
      sessionId: "session-limit",
      skillId: "codex-code-task",
      input: "fail before acceptance",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-rejected",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "task-preaccept-rejected",
  });
  expect(
    taskService.getStatus("session-limit", "huan-task-rejected"),
  ).toMatchObject({
    status: "found",
    state: "rejected",
    statusMessage: "capability discovery failed",
  });
  expect(taskTerminal).not.toHaveBeenCalled();

  await expect(
    service.invoke({
      runId: "run-rejected",
      sessionId: "session-limit",
      skillId: "codex-code-task",
      input: "fail before acceptance",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-rejected",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "task-preaccept-rejected",
  });
  expect(discoverCapability).toHaveBeenCalledTimes(1);
  expect(submitTask).not.toHaveBeenCalled();

  await expect(
    service.invoke({
      runId: "run-after-rejection",
      sessionId: "session-limit",
      skillId: "codex-code-task",
      input: "submit after released reservation",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-after-rejection",
    }),
  ).resolves.toMatchObject({
    status: "accepted",
    taskId: "huan-task-after-rejection",
  });
  expect(discoverCapability).toHaveBeenCalledTimes(2);
  expect(submitTask).toHaveBeenCalledTimes(1);

  await service.close();
});

test("fails closed when a remote Task ID conflicts after transport acceptance", async () => {
  const taskIds = ["huan-task-first", "huan-task-duplicate-remote-id"];
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => taskIds.shift()!,
  });
  const discoverCapability = vi.fn(async (skillId: string) => ({
    id: skillId,
    name: skillId,
  }));
  const submitTask = vi.fn(async () => acceptedTask("submitted"));
  const transport: AgentCallTransport = {
    discoverCapability,
    submitTask,
    async *watchTask(_taskId, { signal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });
  const backgroundError = vi.fn();
  service.onBackgroundError(backgroundError);

  await expect(
    service.invoke({
      runId: "run-first",
      sessionId: "session-post-accept-failure",
      skillId: "codex-code-task",
      input: "accept the first remote task ID",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-first",
    }),
  ).resolves.toMatchObject({ status: "accepted", taskId: "huan-task-first" });

  await expect(
    service.invoke({
      runId: "run-duplicate-remote-id",
      sessionId: "session-post-accept-failure",
      skillId: "codex-code-task",
      input: "return an already tracked remote task ID",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-duplicate-remote-id",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "remote-task-conflict",
    retrySafe: false,
  });
  expect(
    taskService.getStatus(
      "session-post-accept-failure",
      "huan-task-duplicate-remote-id",
    ),
  ).toMatchObject({
    status: "found",
    taskId: "huan-task-duplicate-remote-id",
    state: "rejected",
  });
  expect(backgroundError).toHaveBeenCalledTimes(1);
  expect(backgroundError.mock.calls[0]?.[0]).toMatchObject({
    message: "Remote task a2a-task-01 is already tracked",
  });
  const remaining = taskService.taskQuotaService.acquire(
    "session-post-accept-failure",
    "a2a",
  );
  expect(remaining).toMatchObject({ status: "acquired" });
  if (remaining.status === "acquired") {
    remaining.lease.release();
  }
  expect(discoverCapability).toHaveBeenCalledTimes(2);
  expect(submitTask).toHaveBeenCalledTimes(2);

  await service.close();
});

test("keeps an async Task accepted as unknown when dispatch cannot be confirmed", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 1, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-dispatch-uncertain",
  });
  const discoverCapability = vi.fn(async (skillId: string) => ({
    id: skillId,
    name: skillId,
  }));
  const transport: AgentCallTransport = {
    discoverCapability,
    submitTask: async () => ({
      outcome: "dispatch-uncertain",
      error: new Error("response lost after send"),
    }),
    async *watchTask() {},
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({
    transport,
    taskService,
    quotaService,
  });

  await expect(
    service.invoke({
      runId: "run-dispatch-uncertain",
      sessionId: "session-dispatch-uncertain",
      skillId: "codex-code-task",
      input: "submit exactly once",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-dispatch-uncertain",
    }),
  ).resolves.toEqual({
    status: "accepted",
    taskId: "huan-task-dispatch-uncertain",
    state: "unknown",
  });
  expect(
    taskService.getStatus(
      "session-dispatch-uncertain",
      "huan-task-dispatch-uncertain",
    ),
  ).toMatchObject({ status: "found", state: "unknown" });

  await expect(
    service.invoke({
      runId: "run-dispatch-again",
      sessionId: "session-dispatch-uncertain",
      skillId: "codex-code-task",
      input: "must not get another A2A slot",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-dispatch-again",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "task-limit-reached",
    maxActiveTasksPerSession: 1,
  });
  expect(discoverCapability).toHaveBeenCalledTimes(1);

  await service.close();
});

test("treats an unexpected transport throw after entering submit as uncertain", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 1, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-transport-throw",
  });
  const transportFailure = new Error("transport response vanished");
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => {
      throw transportFailure;
    },
    async *watchTask() {},
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({
    transport,
    taskService,
    quotaService,
  });
  const backgroundError = vi.fn();
  service.onBackgroundError(backgroundError);

  await expect(
    service.invoke({
      runId: "run-transport-throw",
      sessionId: "session-transport-throw",
      skillId: "codex-code-task",
      input: "submit exactly once",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-transport-throw",
    }),
  ).resolves.toEqual({
    status: "accepted",
    taskId: "huan-task-transport-throw",
    state: "unknown",
  });
  expect(
    taskService.getStatus(
      "session-transport-throw",
      "huan-task-transport-throw",
    ),
  ).toMatchObject({ status: "found", state: "unknown" });
  expect(backgroundError).toHaveBeenCalledWith(transportFailure, undefined);
  expect(quotaService.acquire("session-transport-throw", "a2a")).toMatchObject({
    status: "limit-reached",
  });

  await service.close();
});

test("upgrades only an uncertain blocking dispatch to a queryable unknown Task", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 1, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => ({
      outcome: "dispatch-uncertain",
      error: new Error("response body timed out"),
    }),
    async *watchTask() {},
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({
    transport,
    taskService,
    quotaService,
    createId: () => "huan-task-blocking-uncertain",
  });

  await expect(
    service.invoke({
      runId: "run-blocking-uncertain",
      sessionId: "session-blocking-uncertain",
      skillId: "codex-code-task",
      input: "block unless delivery becomes uncertain",
      executionMode: "blocking",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-blocking-uncertain",
    }),
  ).resolves.toEqual({
    status: "blocking-uncertain",
    executionMode: "blocking",
    taskId: "huan-task-blocking-uncertain",
    state: "unknown",
    retrySafe: false,
  });
  expect(
    taskService.getStatus(
      "session-blocking-uncertain",
      "huan-task-blocking-uncertain",
    ),
  ).toMatchObject({ status: "found", state: "unknown" });
  expect(
    quotaService.acquire("session-blocking-uncertain", "a2a"),
  ).toMatchObject({ status: "limit-reached" });

  await service.close();
});

test("deduplicates concurrent and later retries of one uncertain blocking source before transport", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 2, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const releaseDispatch = deferred();
  const submitTask = vi.fn(async () => {
    await releaseDispatch.promise;
    return {
      outcome: "dispatch-uncertain" as const,
      error: new Error("response lost"),
    };
  });
  const service = new AgentCallService({
    transport: {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask,
      async *watchTask() {},
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async (taskId) => task("canceled", { taskId }),
    },
    taskService,
    quotaService,
    createId: () => "huan-task-blocking-deduplicated",
  });
  const request = {
    runId: "run-blocking-deduplicated",
    sessionId: "session-blocking-deduplicated",
    skillId: "codex-code-task",
    input: "dispatch this source once",
    executionMode: "blocking" as const,
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-blocking-deduplicated",
  };

  const first = service.invoke(request);
  const concurrent = service.invoke(request);
  releaseDispatch.resolve();

  await expect(first).resolves.toEqual({
    status: "blocking-uncertain",
    executionMode: "blocking",
    taskId: "huan-task-blocking-deduplicated",
    state: "unknown",
    retrySafe: false,
  });
  await expect(concurrent).resolves.toEqual({
    status: "blocking-uncertain",
    executionMode: "blocking",
    taskId: "huan-task-blocking-deduplicated",
    state: "unknown",
    retrySafe: false,
  });
  await expect(service.invoke(request)).resolves.toEqual({
    status: "blocking-uncertain",
    executionMode: "blocking",
    taskId: "huan-task-blocking-deduplicated",
    state: "unknown",
    retrySafe: false,
  });
  expect(submitTask).toHaveBeenCalledTimes(1);

  await service.close();
});

test("keeps an accepted Task linked when local async bookkeeping fails before an initial terminal snapshot", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 1, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-bookkeeping-recovery",
  });
  const terminal = vi.fn();
  taskService.onTerminal(terminal);
  const bookkeepingFailure = new Error("injected local bookkeeping failure");
  const backgroundError = vi.fn();
  const service = new AgentCallService({
    transport: {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        acceptedTask("completed", {
          artifacts: [{ id: "artifact-recovered", text: "completed remotely" }],
        }),
      async *watchTask() {},
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async (taskId) => task("canceled", { taskId }),
    },
    taskService,
    quotaService,
    testHooks: {
      beforeAsyncTaskAcceptance: () => {
        throw bookkeepingFailure;
      },
    },
  });
  service.onBackgroundError(backgroundError);

  await expect(
    service.invoke({
      runId: "run-bookkeeping-recovery",
      sessionId: "session-bookkeeping-recovery",
      skillId: "codex-code-task",
      input: "complete before local bookkeeping finishes",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-bookkeeping-recovery",
    }),
  ).resolves.toEqual({
    status: "accepted",
    taskId: "huan-task-bookkeeping-recovery",
    state: "unknown",
  });
  await service.waitForIdle();
  expect(
    taskService.getStatus(
      "session-bookkeeping-recovery",
      "huan-task-bookkeeping-recovery",
    ),
  ).toMatchObject({
    status: "found",
    state: "completed",
    payload: {
      artifacts: [{ id: "artifact-recovered", text: "completed remotely" }],
    },
  });
  expect(terminal).toHaveBeenCalledTimes(1);
  expect(backgroundError).toHaveBeenCalledWith(
    bookkeepingFailure,
    expect.objectContaining({ taskId: "a2a-task-01" }),
  );
  const released = quotaService.acquire("session-bookkeeping-recovery", "a2a");
  expect(released).toMatchObject({ status: "acquired" });
  if (released.status === "acquired") {
    released.lease.release();
  }

  await service.close();
});

test("fails a blocking call closed when its accepted remote Task ID already belongs to another call", async () => {
  const quotaService = new SessionTaskQuotaService({
    limits: { a2a: 2, "async-tool": 3 },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "huan-task-first",
  });
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask(_taskId, { signal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const ids = ["huan-task-first", "huan-task-blocking-local-failure"];
  const service = new AgentCallService({
    transport,
    taskService,
    quotaService,
    createId: () => ids.shift()!,
  });

  await expect(
    service.invoke({
      runId: "run-first",
      sessionId: "session-local-failure",
      skillId: "codex-code-task",
      input: "occupy the remote task mapping",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-first",
    }),
  ).resolves.toMatchObject({ status: "accepted" });

  await expect(
    service.invoke({
      runId: "run-blocking-local-failure",
      sessionId: "session-local-failure",
      skillId: "codex-code-task",
      input: "reuse the remote task ID",
      executionMode: "blocking",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-blocking-local-failure",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "remote-task-conflict",
    retrySafe: false,
  });
  expect(
    taskService.getStatus(
      "session-local-failure",
      "huan-task-blocking-local-failure",
    ),
  ).toEqual({
    status: "not-found",
    taskId: "huan-task-blocking-local-failure",
  });
  const remaining = quotaService.acquire("session-local-failure", "a2a");
  expect(remaining).toMatchObject({ status: "acquired" });
  if (remaining.status === "acquired") {
    remaining.lease.release();
  }

  await service.close();
});

test("interrupts a paused blocking AgentCall without creating a common Task", async () => {
  const createTaskId = vi.fn(() => "unexpected-task-id");
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId,
  });
  const taskInputRequired = vi.fn();
  const taskTerminal = vi.fn();
  taskService.onInputRequired(taskInputRequired);
  taskService.onTerminal(taskTerminal);
  const cancelTask = vi.fn(async (taskId: string) =>
    task("canceled", { taskId }),
  );
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
    submitTask: async () => acceptedTask("submitted"),
    async *watchTask() {
      yield task("input-required", {
        statusMessage: "approval required",
        questions: [
          {
            id: "approval",
            header: "Approval",
            question: "Continue?",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
      });
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask,
  };
  const service = new AgentCallService({
    transport,
    taskService,
    createId: () => "blocking-agent-call",
  });

  const result = await service.invoke({
    runId: "run-blocking-input",
    sessionId: "session-blocking-input",
    skillId: "codex-code-task",
    input: "block until input",
    executionMode: "blocking",
    toolName: "submit_codex_agent_call",
    sourceToolCallId: "tool-call-blocking-input",
  });

  expect(result).toEqual({
    status: "blocking-interrupted",
    executionMode: "blocking",
    state: "input-required",
    questions: [expect.objectContaining({ id: "approval" })],
    statusMessage: "approval required",
  });
  expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");
  expect(createTaskId).not.toHaveBeenCalled();
  expect(taskInputRequired).not.toHaveBeenCalled();
  expect(taskTerminal).not.toHaveBeenCalled();

  await service.close();
});

test("returns a structured limit error before any AgentCall transport work", async () => {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 1,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    createTaskId: () => "occupied-task",
  });
  const occupied = taskService.reserve({
    sessionId: "session-limited",
    sourceRunId: "run-occupied",
    sourceToolCallId: "tool-call-occupied",
    toolName: "submit_codex_agent_call",
    kind: "agent-call",
    payload: { artifacts: [] },
  });
  if (occupied.status === "limit-reached") {
    throw new Error("Expected the fixture Task reservation to succeed");
  }
  taskService.accept("session-limited", occupied.task.taskId, {
    state: "working",
  });
  const discoverCapability = vi.fn();
  const submitTask = vi.fn();
  const transport: AgentCallTransport = {
    discoverCapability,
    submitTask,
    async *watchTask() {},
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => task("canceled", { taskId }),
  };
  const service = new AgentCallService({ transport, taskService });

  await expect(
    service.invoke({
      runId: "run-limited",
      sessionId: "session-limited",
      skillId: "codex-code-task",
      input: "must not reach transport",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-limited",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "task-limit-reached",
    maxActiveTasksPerSession: 1,
  });
  expect(discoverCapability).not.toHaveBeenCalled();
  expect(submitTask).not.toHaveBeenCalled();

  await service.close();
});
