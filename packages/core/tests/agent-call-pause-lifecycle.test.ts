import { describe, expect, test, vi } from "vitest";

import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AgentCallService,
  AsyncToolTaskService,
  type AgentCallServiceOptions,
  type AgentCallInputAnswers,
  type AgentCallTaskSnapshot,
  type AgentCallTransport,
} from "../src/index.js";
import {
  deferred,
  rejectUnexpectedContinuation,
  scopeQuestion,
  task,
} from "./agent-call-test-helpers.js";

const taskServiceByAgentCallService = new WeakMap<
  AgentCallService,
  AsyncToolTaskService
>();

function createAgentCallService(
  options: Omit<AgentCallServiceOptions, "taskService">,
): AgentCallService {
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 10,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    ...(options.createId === undefined
      ? {}
      : { createTaskId: options.createId }),
  });
  const service = new AgentCallService({
    ...options,
    taskService,
  });
  taskServiceByAgentCallService.set(service, taskService);
  return service;
}

function taskEvents(service: AgentCallService): AsyncToolTaskService {
  return taskServiceByAgentCallService.get(service)!;
}

function continueTrackedAgentCall(
  service: AgentCallService,
  id: string,
  answers: AgentCallInputAnswers,
  signal?: AbortSignal,
) {
  const record = service.getByTaskId(id) ?? service.getByAgentCallId(id);
  if (record === undefined) {
    throw new Error(`Missing tracked AgentCall ${id}`);
  }
  return service.continueTask({
    sessionId: record.sessionId,
    taskId: record.agentCallId,
    answers,
    ...(signal === undefined ? {} : { signal }),
  });
}

let toolCallSequence = 0;
function nextSourceToolCallId(): string {
  toolCallSequence += 1;
  return `pause-tool-call-${toolCallSequence}`;
}

describe("AgentCallService pause lifecycle", () => {
  test("notifies an async input-required episode exactly once", async () => {
    const pausedListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required", {
          statusMessage: "approval is required",
        });
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-paused-listener",
    });
    taskEvents(service).onInputRequired(pausedListener);

    await service.submit({
      runId: "run-paused-listener",
      sessionId: "session-paused-listener",
      skillId: "codex-code-task",
      input: "pause for approval",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    expect(pausedListener).toHaveBeenCalledTimes(1);
    expect(pausedListener.mock.calls[0]?.[0]).toMatchObject({
      taskId: "agent-call-paused-listener",
      state: "input-required",
      statusMessage: "approval is required",
    });
  });

  test("preserves an observed pause when subscription cleanup fails", async () => {
    const backgroundErrorListener = vi.fn();
    let delivered = false;
    const iterator: AsyncIterableIterator<AgentCallTaskSnapshot> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (delivered) {
          return { done: true, value: undefined };
        }
        delivered = true;
        return {
          done: false,
          value: task("input-required", {
            statusMessage: "approval is still required",
          }),
        };
      },
      async return() {
        throw new Error("subscription cleanup failed");
      },
    };
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      watchTask: () => iterator,
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-cleanup-failure",
    });
    service.onBackgroundError(backgroundErrorListener);

    await service.submit({
      runId: "run-cleanup-failure",
      sessionId: "session-cleanup-failure",
      skillId: "codex-code-task",
      input: "preserve the pause",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    expect(
      service.getByAgentCallId("agent-call-cleanup-failure"),
    ).toMatchObject({
      state: "input-required",
      statusMessage: "approval is still required",
    });
    expect(backgroundErrorListener).toHaveBeenCalledWith(
      expect.objectContaining({ message: "subscription cleanup failed" }),
      expect.objectContaining({
        agentCallId: "agent-call-cleanup-failure",
        state: "input-required",
      }),
    );
  });

  test("notifies an async task accepted as input-required without subscribing", async () => {
    const pausedListener = vi.fn();
    const watchTask = vi.fn(async function* () {
      yield task("working");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("input-required", { statusMessage: "choose a scope" }),
      watchTask,
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-initial-pause",
    });
    taskEvents(service).onInputRequired(pausedListener);

    await service.submit({
      runId: "run-initial-pause",
      sessionId: "session-initial-pause",
      skillId: "codex-code-task",
      input: "start paused",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    expect(pausedListener).toHaveBeenCalledTimes(1);
    expect(watchTask).not.toHaveBeenCalled();
  });

  test("lets a paused listener continue while the old watcher stays open", async () => {
    const releaseOldWatcher = deferred();
    const terminalObserved = deferred();
    let watchCycle = 0;
    const continueTask = vi.fn(async () => task("working"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchCycle += 1;
        if (watchCycle === 1) {
          yield task("input-required", {
            questions: [scopeQuestion()],
          });
          await releaseOldWatcher.promise;
          return;
        }
        yield task("completed");
      },
      continueTask,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-auto-continue",
    });
    taskEvents(service).onInputRequired(async () => {
      await continueTrackedAgentCall(service, "a2a-task-01", {
        scope: ["Adapter only"],
      });
    });
    taskEvents(service).onTerminal(() => terminalObserved.resolve());

    await service.submit({
      runId: "run-auto-continue",
      sessionId: "session-auto-continue",
      skillId: "codex-code-task",
      input: "pause and continue automatically",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    const firstSignal = await Promise.race([
      terminalObserved.promise.then(() => "completed" as const),
      new Promise<"blocked">((resolve) =>
        setImmediate(() => resolve("blocked")),
      ),
    ]);
    releaseOldWatcher.resolve();
    await terminalObserved.promise;
    await service.waitForIdle();

    expect(firstSignal).toBe("completed");
    expect(continueTask).toHaveBeenCalledTimes(1);
    expect(watchCycle).toBe(2);
  });

  test("does not treat detached input-required listener work as AgentCall activity", async () => {
    const listenerStarted = deferred();
    const releaseListener = deferred();
    const terminalListener = vi.fn();
    let watchCycle = 0;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchCycle += 1;
        if (watchCycle === 1) {
          yield task("input-required", {
            questions: [scopeQuestion()],
          });
          return;
        }
        yield task("completed");
      },
      continueTask: async () => task("working"),
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-idle-after-pause",
    });
    taskEvents(service).onInputRequired(async () => {
      listenerStarted.resolve();
      await releaseListener.promise;
      await continueTrackedAgentCall(service, "a2a-task-01", {
        scope: ["Adapter only"],
      });
    });
    taskEvents(service).onTerminal(terminalListener);

    await service.submit({
      runId: "run-idle-after-pause",
      sessionId: "session-idle-after-pause",
      skillId: "codex-code-task",
      input: "wait through automatic continuation",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await listenerStarted.promise;
    let idleSettled = false;
    const idle = service.waitForIdle().finally(() => {
      idleSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeListener = idleSettled;

    releaseListener.resolve();
    await idle;
    await service.waitForIdle();

    expect(returnedBeforeListener).toBe(true);
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("completed");
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test("waits for a continuation started by a paused listener before becoming idle", async () => {
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    const terminalObserved = deferred();
    let watchCycle = 0;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchCycle += 1;
        if (watchCycle === 1) {
          yield task("input-required", {
            questions: [scopeQuestion()],
          });
          return;
        }
        yield task("completed");
      },
      continueTask: async () => {
        continuationStarted.resolve();
        await releaseContinuation.promise;
        return task("working");
      },
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-detached-continuation",
    });
    taskEvents(service).onInputRequired(() => {
      void continueTrackedAgentCall(service, "a2a-task-01", {
        scope: ["Adapter only"],
      }).catch(() => undefined);
    });
    taskEvents(service).onTerminal(() => terminalObserved.resolve());

    await service.submit({
      runId: "run-detached-continuation",
      sessionId: "session-detached-continuation",
      skillId: "codex-code-task",
      input: "continue without awaiting the listener callback",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await continuationStarted.promise;
    let idleSettled = false;
    const idle = service.waitForIdle().finally(() => {
      idleSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedDuringContinuation = idleSettled;

    releaseContinuation.resolve();
    await idle;
    await terminalObserved.promise;
    await service.waitForIdle();

    expect(returnedDuringContinuation).toBe(false);
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("completed");
  });

  test("shares concurrent close calls without waiting for detached listener work", async () => {
    const listenerStarted = deferred();
    const releaseListener = deferred();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required");
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-close-paused-listener",
    });
    taskEvents(service).onInputRequired(async () => {
      listenerStarted.resolve();
      await releaseListener.promise;
    });

    await service.submit({
      runId: "run-close-paused-listener",
      sessionId: "session-close-paused-listener",
      skillId: "codex-code-task",
      input: "wait for the pause observer during close",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await listenerStarted.promise;
    const firstClose = service.close();
    const secondClose = service.close();
    const sharedClosePromise = firstClose === secondClose;
    let firstCloseSettled = false;
    let secondCloseSettled = false;
    void firstClose.finally(() => {
      firstCloseSettled = true;
    });
    void secondClose.finally(() => {
      secondCloseSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bothCallsWaitedForListener =
      !firstCloseSettled && !secondCloseSettled;

    releaseListener.resolve();
    await Promise.all([firstClose, secondClose]);

    expect(sharedClosePromise).toBe(true);
    expect(bothCallsWaitedForListener).toBe(false);
  });

  test("does not extend close for cancellation started by detached listener work", async () => {
    const listenerStarted = deferred();
    const releaseListener = deferred();
    const cancellationStarted = deferred();
    const releaseCancellation = deferred();
    let detachedCancellation: Promise<AgentCallTaskSnapshot> | undefined;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required");
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => {
        cancellationStarted.resolve();
        await releaseCancellation.promise;
        return task("canceled");
      },
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-late-cancellation",
    });
    taskEvents(service).onInputRequired(async () => {
      listenerStarted.resolve();
      await releaseListener.promise;
      detachedCancellation = service.cancel("agent-call-late-cancellation");
    });

    await service.submit({
      runId: "run-late-cancellation",
      sessionId: "session-late-cancellation",
      skillId: "codex-code-task",
      input: "cancel while close drains listeners",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await listenerStarted.promise;
    let closeSettled = false;
    const closing = service.close();
    void closing.then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseListener.resolve();
    await cancellationStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeWaitedForLateCancellation = !closeSettled;

    releaseCancellation.resolve();
    await closing;
    await detachedCancellation;

    expect(closeWaitedForLateCancellation).toBe(false);
  });

  test("reports a paused listener rejection only as a background error", async () => {
    const backgroundError = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required");
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-paused-listener-error",
    });
    service.onBackgroundError(backgroundError);
    taskEvents(service).onInputRequired(() => {
      throw new Error("Input-required re-entry failed");
    });

    await service.submit({
      runId: "run-paused-listener-error",
      sessionId: "session-paused-listener-error",
      skillId: "codex-code-task",
      input: "pause then fail the observer",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    expect(backgroundError).toHaveBeenCalledTimes(1);
    expect(backgroundError.mock.calls[0]?.[0]).toMatchObject({
      message: "Async Tool Task input-required listener failed",
      errors: [
        expect.objectContaining({ message: "Input-required re-entry failed" }),
      ],
    });
    const record = service.getByTaskId("a2a-task-01");
    expect(record?.state).toBe("input-required");
    expect(record).not.toHaveProperty("terminalNotificationError");
  });

  test("does not rethrow a failed paused-listener continuation from waitForIdle", async () => {
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    const backgroundError = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required", {
          questions: [scopeQuestion()],
        });
      },
      continueTask: async () => {
        continuationStarted.resolve();
        await releaseContinuation.promise;
        throw new Error("Remote continuation failed");
      },
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-failed-listener-continuation",
    });
    service.onBackgroundError(backgroundError);
    taskEvents(service).onInputRequired(() => {
      void continueTrackedAgentCall(service, "a2a-task-01", {
        scope: ["Adapter only"],
      }).catch(backgroundError);
    });

    await service.submit({
      runId: "run-failed-listener-continuation",
      sessionId: "session-failed-listener-continuation",
      skillId: "codex-code-task",
      input: "fail while continuing from a pause listener",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await continuationStarted.promise;
    const idleOutcome = service.waitForIdle().then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    releaseContinuation.resolve();
    const outcome = await idleOutcome;
    await service.waitForIdle();

    expect(outcome).toBe("resolved");
    expect(backgroundError).toHaveBeenCalledTimes(1);
    expect(backgroundError.mock.calls[0]?.[0]).toMatchObject({
      message: "Remote continuation failed",
    });
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("input-required");
  });

  test("notifies again after a continued async task enters a new input-required episode", async () => {
    const pausedListener = vi.fn();
    let watchCycle = 0;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchCycle += 1;
        yield task("input-required", {
          statusMessage: `question-${watchCycle}`,
          questions: [scopeQuestion()],
        });
      },
      continueTask: async () => task("working"),
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-repeated-pause",
    });
    taskEvents(service).onInputRequired(pausedListener);

    await service.submit({
      runId: "run-repeated-pause",
      sessionId: "session-repeated-pause",
      skillId: "codex-code-task",
      input: "pause twice",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();
    await continueTrackedAgentCall(service, "a2a-task-01", {
      scope: ["Adapter only"],
    });
    await service.waitForIdle();

    expect(pausedListener).toHaveBeenCalledTimes(2);
    expect(
      pausedListener.mock.calls.map(([record]) => record.statusMessage),
    ).toEqual(["question-1", "question-2"]);
  });

  test("does not publish or continue blocking input-required through the common Task service", async () => {
    const pausedListener = vi.fn();
    const continueTask = vi.fn(async () => task("working"));
    const cancelTask = vi.fn(async (taskId: string) =>
      task("canceled", { taskId }),
    );
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required", {
          statusMessage: "blocking-question-1",
          questions: [scopeQuestion()],
        });
      },
      continueTask,
      cancelTask,
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-blocking-second-pause",
    });
    taskEvents(service).onInputRequired(pausedListener);

    await expect(
      service.invoke({
        runId: "run-blocking-second-pause",
        sessionId: "session-blocking-second-pause",
        skillId: "codex-code-task",
        input: "return first pause, notify the next",
        executionMode: "blocking",
      }),
    ).resolves.toMatchObject({
      status: "blocking-interrupted",
      state: "input-required",
      statusMessage: "blocking-question-1",
    });
    expect(pausedListener).not.toHaveBeenCalled();

    await expect(
      service.continueTask({
        sessionId: "session-blocking-second-pause",
        taskId: "agent-call-blocking-second-pause",
        answers: { scope: ["Adapter only"] },
      }),
    ).resolves.toEqual({
      status: "not-found",
      taskId: "agent-call-blocking-second-pause",
    });
    expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");
    expect(continueTask).not.toHaveBeenCalled();
  });

  test("does not notify paused listeners for auth-required", async () => {
    const pausedListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("auth-required", { statusMessage: "sign in first" });
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-auth-required",
    });
    taskEvents(service).onInputRequired(pausedListener);

    await service.submit({
      runId: "run-auth-required",
      sessionId: "session-auth-required",
      skillId: "codex-code-task",
      input: "request authentication",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    expect(service.getByTaskId("a2a-task-01")?.state).toBe("auth-required");
    expect(pausedListener).not.toHaveBeenCalled();
  });

  test("keeps watching after remote continuation succeeds despite caller abort", async () => {
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    const callerController = new AbortController();
    const continueTask = vi.fn(async () => {
      continuationStarted.resolve();
      await releaseContinuation.promise;
      return task("working");
    });
    const watchTask = vi.fn(async function* () {
      yield task("completed");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("input-required", { questions: [scopeQuestion()] }),
      watchTask,
      continueTask,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-aborted-caller",
    });
    await service.submit({
      runId: "run-aborted-caller",
      sessionId: "session-aborted-caller",
      skillId: "codex-code-task",
      input: "keep tracking committed remote work",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    const continuation = continueTrackedAgentCall(
      service,
      "a2a-task-01",
      { scope: ["Adapter only"] },
      callerController.signal,
    );
    await continuationStarted.promise;
    callerController.abort();
    releaseContinuation.resolve();

    await expect(continuation).resolves.toMatchObject({ state: "working" });
    await service.waitForIdle();
    expect(watchTask).toHaveBeenCalledTimes(1);
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("completed");
  });

  test("lets cancellation win while continuation is waiting for the old watcher", async () => {
    const pauseObserved = deferred();
    const continuationWaiting = deferred();
    const releaseWatcherCleanup = deferred();
    let watchCycle = 0;
    const continueTask = vi.fn(async () => task("working"));
    const watchTask: AgentCallTransport["watchTask"] = (_taskId, options) => {
      watchCycle += 1;
      if (watchCycle > 1) {
        return (async function* () {})();
      }
      options.signal.addEventListener(
        "abort",
        () => continuationWaiting.resolve(),
        { once: true },
      );
      let delivered = false;
      const firstWatcher: AsyncIterableIterator<AgentCallTaskSnapshot> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (delivered) {
            return { done: true, value: undefined };
          }
          delivered = true;
          return {
            done: false,
            value: task("input-required", {
              questions: [scopeQuestion()],
            }),
          };
        },
        async return() {
          await releaseWatcherCleanup.promise;
          return { done: true, value: undefined };
        },
      };
      return firstWatcher;
    };
    const cancelTask = vi.fn(async () => task("canceled"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      watchTask,
      continueTask,
      cancelTask,
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-cancel-wins",
    });
    taskEvents(service).onInputRequired(() => pauseObserved.resolve());

    await service.submit({
      runId: "run-cancel-wins",
      sessionId: "session-cancel-wins",
      skillId: "codex-code-task",
      input: "cancel while continuing",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await pauseObserved.promise;
    const continuationOutcome = continueTrackedAgentCall(
      service,
      "a2a-task-01",
      { scope: ["Adapter only"] },
    ).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await continuationWaiting.promise;

    const cancellation = service.cancel("agent-call-cancel-wins");
    releaseWatcherCleanup.resolve();
    await expect(cancellation).resolves.toMatchObject({ state: "canceled" });
    await expect(continuationOutcome).resolves.toBe("rejected");
    await service.waitForIdle();

    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(continueTask).not.toHaveBeenCalled();
    expect(watchCycle).toBe(1);
  });

  test("rejects continuation while cancellation is in flight", async () => {
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    const continueTask = vi.fn(async () => task("working"));
    const cancelTask = vi.fn(async () => {
      cancelStarted.resolve();
      await releaseCancel.promise;
      return task("canceled");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("input-required", { questions: [scopeQuestion()] }),
      async *watchTask() {},
      continueTask,
      cancelTask,
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-cancel-in-flight",
    });
    await service.submit({
      runId: "run-cancel-in-flight",
      sessionId: "session-cancel-in-flight",
      skillId: "codex-code-task",
      input: "do not continue after cancellation starts",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    const cancellation = service.cancel("agent-call-cancel-in-flight");
    await cancelStarted.promise;
    const continuation = continueTrackedAgentCall(service, "a2a-task-01", {
      scope: ["Adapter only"],
    });

    await expect(continuation).rejects.toThrow(/cancel/i);
    expect(continueTask).not.toHaveBeenCalled();

    releaseCancel.resolve();
    await expect(cancellation).resolves.toMatchObject({ state: "canceled" });
  });

  test("cancels a same-turn continuation before remote transport", async () => {
    const continueTask = vi.fn(async () => task("working"));
    const watchTask = vi.fn(async function* () {});
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("input-required", { questions: [scopeQuestion()] }),
      watchTask,
      continueTask,
      cancelTask: async () => task("canceled"),
    };
    const service = createAgentCallService({
      transport,
      createId: () => "agent-call-same-turn-cancel",
    });
    await service.submit({
      runId: "run-same-turn-cancel",
      sessionId: "session-same-turn-cancel",
      skillId: "codex-code-task",
      input: "cancel before remote continuation",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: nextSourceToolCallId(),
    });
    await service.waitForIdle();

    const continuationOutcome = continueTrackedAgentCall(
      service,
      "a2a-task-01",
      { scope: ["Adapter only"] },
    ).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const cancellation = service.cancel("agent-call-same-turn-cancel");

    await expect(continuationOutcome).resolves.toBe("rejected");
    await expect(cancellation).resolves.toMatchObject({ state: "canceled" });
    expect(continueTask).not.toHaveBeenCalled();
    expect(watchTask).not.toHaveBeenCalled();
  });
});
