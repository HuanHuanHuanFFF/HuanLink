import { expect, test, vi } from "vitest";

import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AgentCallService,
  AsyncToolTaskService,
  type AgentCallInputAnswers,
  type AgentCallTransport,
} from "../src/index.js";
import {
  deferred,
  rejectUnexpectedContinuation,
  task,
} from "./agent-call-test-helpers.js";

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
    submitTask: async () => task("submitted"),
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
    submitTask: async () => task("submitted"),
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
    submitTask: async () => task("submitted"),
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
      task("input-required", {
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
    submitTask: async () => task("submitted"),
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
      submitTask: async () => task("submitted"),
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
  const submitTask = vi.fn(async () => task("submitted"));
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

test("does not classify a failure after transport acceptance as pre-accept rejection", async () => {
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
  const submitTask = vi.fn(async () => task("submitted"));
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
    status: "accepted",
    taskId: "huan-task-duplicate-remote-id",
    state: "unknown",
  });
  expect(
    taskService.getStatus(
      "session-post-accept-failure",
      "huan-task-duplicate-remote-id",
    ),
  ).toMatchObject({
    status: "found",
    state: "unknown",
    payload: { artifacts: [] },
  });
  expect(backgroundError).toHaveBeenCalledTimes(1);
  expect(backgroundError.mock.calls[0]?.[0]).toMatchObject({
    message: "Remote task a2a-task-01 is already tracked",
  });
  await expect(
    service.invoke({
      runId: "run-after-unknown",
      sessionId: "session-post-accept-failure",
      skillId: "codex-code-task",
      input: "must remain within the occupied Task limit",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "tool-call-after-unknown",
    }),
  ).resolves.toEqual({
    status: "error",
    error: "task-limit-reached",
    maxActiveTasksPerSession: 2,
  });
  expect(discoverCapability).toHaveBeenCalledTimes(2);
  expect(submitTask).toHaveBeenCalledTimes(2);

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
    submitTask: async () => task("submitted"),
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
