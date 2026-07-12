import { describe, expect, test, vi } from "vitest";

import {
  AgentCallService,
  type AgentCallTaskSnapshot,
  type AgentCallTransport
} from "../src/index.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function task(
  state: AgentCallTaskSnapshot["state"],
  overrides: Partial<AgentCallTaskSnapshot> = {}
): AgentCallTaskSnapshot {
  return {
    taskId: "a2a-task-01",
    contextId: "a2a-context-01",
    state,
    artifacts: [],
    ...overrides
  };
}

describe("AgentCallService", () => {
  test("returns an accepted result for a background invocation before completion", async () => {
    const releaseCompletion = deferred();
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({
        id: skillId,
        name: "Codex code task"
      }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        await releaseCompletion.promise;
        yield task("completed");
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-background"
    });
    service.onTerminal(terminalListener);

    const result = await service.invoke({
      runId: "run-background",
      sessionId: "session-background",
      skillId: "codex-code-task",
      input: "run in background",
      executionMode: "background"
    });

    expect(result).toMatchObject({
      status: "accepted",
      executionMode: "background",
      agentCallId: "agent-call-background"
    });
    expect(terminalListener).not.toHaveBeenCalled();

    releaseCompletion.resolve();
    await service.waitForIdle();
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test("waits for an outcome and does not notify background terminal listeners", async () => {
    const watchStarted = deferred();
    const releaseCompletion = deferred();
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({
        id: skillId,
        name: "Codex code task"
      }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchStarted.resolve();
        yield task("working");
        await releaseCompletion.promise;
        yield task("completed", {
          artifacts: [{ id: "wait-result", text: "completed while waiting" }]
        });
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-wait"
    });
    service.onTerminal(terminalListener);
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-wait",
        sessionId: "session-wait",
        skillId: "codex-code-task",
        input: "wait for completion",
        executionMode: "wait"
      })
      .finally(() => {
        invocationSettled = true;
      });

    await watchStarted.promise;
    expect(invocationSettled).toBe(false);

    releaseCompletion.resolve();
    await expect(invocation).resolves.toMatchObject({
      status: "result",
      executionMode: "wait",
      agentCallId: "agent-call-wait",
      state: "completed",
      artifacts: [{ id: "wait-result", text: "completed while waiting" }]
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test("returns an input-required pause to a waiting invocation", async () => {
    const subscriptionHeldOpen = deferred();
    const releaseSubscription = deferred();
    const terminalListener = vi.fn();
    let watcherSignal: AbortSignal | undefined;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask(_taskId, options) {
        watcherSignal = options.signal;
        yield task("input-required", {
          statusMessage: "approval is required"
        });
        subscriptionHeldOpen.resolve();
        await releaseSubscription.promise;
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-wait-paused"
    });
    service.onTerminal(terminalListener);
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-wait-paused",
        sessionId: "session-wait-paused",
        skillId: "codex-code-task",
        input: "wait until input is needed",
        executionMode: "wait"
      })
      .finally(() => {
        invocationSettled = true;
      });

    await subscriptionHeldOpen.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWhileSubscriptionWasOpen = invocationSettled;

    await expect(invocation).resolves.toMatchObject({
      status: "result",
      executionMode: "wait",
      state: "input-required",
      statusMessage: "approval is required"
    });
    const watcherAbortedAfterOutcome = watcherSignal?.aborted;
    releaseSubscription.resolve();
    await service.waitForIdle();
    expect(settledWhileSubscriptionWasOpen).toBe(true);
    expect(watcherAbortedAfterOutcome).toBe(true);
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test("does not subscribe when a waiting invocation is accepted in a paused state", async () => {
    const watchTask = vi.fn(async function* () {
      yield task("working");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("auth-required", { statusMessage: "sign in is required" }),
      watchTask,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-wait-initially-paused"
    });

    await expect(
      service.invoke({
        runId: "run-wait-initially-paused",
        sessionId: "session-wait-initially-paused",
        skillId: "codex-code-task",
        input: "return the initial auth request",
        executionMode: "wait"
      })
    ).resolves.toMatchObject({
      status: "result",
      executionMode: "wait",
      state: "auth-required",
      statusMessage: "sign in is required"
    });
    await service.waitForIdle();

    expect(watchTask).not.toHaveBeenCalled();
  });

  test("stops waiting when the caller aborts without waiting for the remote outcome", async () => {
    const watchStarted = deferred();
    const releaseCompletion = deferred();
    const cancelStarted = deferred();
    const releaseCancel = deferred();
    const cancelTask = vi.fn(async () => {
      cancelStarted.resolve();
      await releaseCancel.promise;
      return task("canceled");
    });
    let watcherSignal: AbortSignal | undefined;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask(_taskId, options) {
        watcherSignal = options.signal;
        watchStarted.resolve();
        await releaseCompletion.promise;
        yield task("completed");
      },
      cancelTask
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-wait-aborted"
    });
    const controller = new AbortController();
    const canceled = new Error("MainAgent turn canceled");
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-wait-aborted",
        sessionId: "session-wait-aborted",
        skillId: "codex-code-task",
        input: "stop waiting when the caller cancels",
        executionMode: "wait",
        signal: controller.signal
      })
      .finally(() => {
        invocationSettled = true;
      });
    void invocation.catch(() => undefined);

    await watchStarted.promise;
    controller.abort(canceled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeRemoteCompletion = invocationSettled;
    const watcherAbortedAfterCancellation = watcherSignal?.aborted;
    releaseCompletion.resolve();

    await expect(invocation).rejects.toBe(canceled);
    expect(settledBeforeRemoteCompletion).toBe(true);
    expect(watcherAbortedAfterCancellation).toBe(true);
    expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");

    let closeSettled = false;
    const closing = service.close().finally(() => {
      closeSettled = true;
    });
    await cancelStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeWaitedForCancellation = !closeSettled;
    releaseCancel.resolve();
    await closing;

    expect(closeWaitedForCancellation).toBe(true);
  });

  test("returns an accepted receipt before the remote task completes and stores both IDs", async () => {
    const releaseCompletion = deferred();
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: vi.fn(async (skillId) => ({
        id: skillId,
        name: "Codex code task"
      })),
      submitTask: vi.fn(async () => task("submitted")),
      async *watchTask() {
        yield task("working");
        await releaseCompletion.promise;
        yield task("completed", {
          artifacts: [{ id: "result-01", text: "changed src/example.ts" }]
        });
        yield task("completed");
      },
      cancelTask: vi.fn(async () => task("canceled"))
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-01"
    });
    service.onTerminal(terminalListener);

    const receipt = await service.submit({
      runId: "run-01",
      sessionId: "session-01",
      skillId: "codex-code-task",
      input: "make a focused code change",
      executionMode: "background"
    });

    expect(receipt).toEqual({
      status: "accepted",
      executionMode: "background",
      agentCallId: "agent-call-01",
      taskId: "a2a-task-01",
      state: "submitted"
    });
    expect(service.getByAgentCallId("agent-call-01")?.taskId).toBe(
      "a2a-task-01"
    );
    expect(service.getByTaskId("a2a-task-01")?.agentCallId).toBe(
      "agent-call-01"
    );
    expect(terminalListener).not.toHaveBeenCalled();

    releaseCompletion.resolve();
    await service.waitForIdle();

    expect(terminalListener).toHaveBeenCalledTimes(1);
    expect(terminalListener.mock.calls[0]?.[0]).toMatchObject({
      agentCallId: "agent-call-01",
      taskId: "a2a-task-01",
      state: "completed",
      artifacts: [{ id: "result-01", text: "changed src/example.ts" }]
    });
  });

  test("converts a background watcher failure into one failed terminal record", async () => {
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({
        id: skillId,
        name: "Codex code task"
      }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        throw new Error("subscription disconnected");
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-02"
    });
    service.onTerminal(terminalListener);

    await service.submit({
      runId: "run-02",
      sessionId: "session-02",
      skillId: "codex-code-task",
      input: "run a code task",
      executionMode: "background"
    });
    await service.waitForIdle();

    expect(service.getByAgentCallId("agent-call-02")).toMatchObject({
      state: "failed",
      statusMessage: "subscription disconnected"
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test("preserves an input-required pause when the remote subscription ends", async () => {
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required", {
          statusMessage: "approval is required"
        });
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-paused"
    });
    service.onTerminal(terminalListener);

    await service.submit({
      runId: "run-paused",
      sessionId: "session-paused",
      skillId: "codex-code-task",
      input: "pause for approval",
      executionMode: "background"
    });
    await service.waitForIdle();

    expect(service.getByAgentCallId("agent-call-paused")).toMatchObject({
      state: "input-required",
      statusMessage: "approval is required"
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test("maps cancellation through the transport without waiting for the watcher", async () => {
    const never = deferred();
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask(_taskId, options) {
        await Promise.race([
          never.promise,
          new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), {
              once: true
            })
          )
        ]);
      },
      cancelTask: vi.fn(async () => task("canceled"))
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-03"
    });
    service.onTerminal(terminalListener);
    const receipt = await service.submit({
      runId: "run-03",
      sessionId: "session-03",
      skillId: "codex-code-task",
      input: "cancel me",
      executionMode: "background"
    });

    const canceled = await service.cancel(receipt.agentCallId);

    expect(transport.cancelTask).toHaveBeenCalledWith("a2a-task-01");
    expect(canceled.state).toBe("canceled");
    expect(terminalListener).toHaveBeenCalledTimes(1);

    await service.close();
  });

  test("waits for an in-flight submission during close and cancels a task accepted after shutdown began", async () => {
    const submitStarted = deferred();
    const releaseSubmit = deferred();
    const cancelTask = vi.fn(async () => task("canceled"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => {
        submitStarted.resolve();
        await releaseSubmit.promise;
        return task("submitted");
      },
      async *watchTask() {},
      cancelTask
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-close-race"
    });

    const submitting = service.submit({
      runId: "run-close-race",
      sessionId: "session-close-race",
      skillId: "codex-code-task",
      input: "do not outlive shutdown",
      executionMode: "background"
    });
    await submitStarted.promise;
    const closing = service.close();
    releaseSubmit.resolve();

    await expect(submitting).rejects.toThrow(/closed during submission/);
    await expect(closing).resolves.toBeUndefined();
    expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");
    expect(service.getByAgentCallId("agent-call-close-race")).toBeUndefined();
  });

  test("records and reports a terminal listener failure instead of swallowing it", async () => {
    const backgroundError = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("completed");
      },
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-listener-error"
    });
    service.onBackgroundError(backgroundError);
    service.onTerminal(() => {
      throw new Error("MainAgent re-entry failed");
    });

    await service.submit({
      runId: "run-listener-error",
      sessionId: "session-listener-error",
      skillId: "codex-code-task",
      input: "complete then fail re-entry",
      executionMode: "background"
    });
    await service.waitForIdle();

    expect(backgroundError).toHaveBeenCalledTimes(1);
    expect(backgroundError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(service.getByAgentCallId("agent-call-listener-error")).toMatchObject({
      state: "completed",
      terminalNotificationError: "MainAgent re-entry failed"
    });
  });
});
