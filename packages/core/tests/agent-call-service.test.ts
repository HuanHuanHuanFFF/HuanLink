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

const rejectUnexpectedContinuation: AgentCallTransport["continueTask"] =
  async () => {
    throw new Error("Unexpected task continuation in this test");
  };

describe("AgentCallService", () => {
  test("lists defensive copies of records for only the requested run", async () => {
    let taskSequence = 0;
    let agentCallSequence = 0;
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => {
        taskSequence += 1;
        return task("completed", {
          taskId: `a2a-task-${taskSequence}`,
          artifacts: [
            { id: `artifact-${taskSequence}`, text: `result-${taskSequence}` }
          ]
        });
      },
      async *watchTask() {},
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async (taskId) => task("canceled", { taskId })
    };
    const service = new AgentCallService({
      transport,
      createId: () => {
        agentCallSequence += 1;
        return `agent-call-${agentCallSequence}`;
      }
    });
    const submit = (runId: string) =>
      service.submit({
        runId,
        sessionId: "session-list",
        skillId: "codex-code-task",
        input: `input for ${runId}`,
        executionMode: "async"
      });

    await submit("run-target");
    await submit("run-other");
    await submit("run-target");

    const listed = service.listByRunId("run-target");
    expect(listed.map(({ agentCallId }) => agentCallId)).toEqual([
      "agent-call-1",
      "agent-call-3"
    ]);
    listed[0]!.input = "mutated input";
    listed[0]!.artifacts[0]!.text = "mutated result";

    expect(service.listByRunId("run-target")[0]).toMatchObject({
      input: "input for run-target",
      artifacts: [{ id: "artifact-1", text: "result-1" }]
    });
    expect(service.listByRunId("missing-run")).toEqual([]);

    await service.close();
  });

  test("returns an accepted result for an async invocation before completion", async () => {
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
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-async"
    });
    service.onTerminal(terminalListener);

    const invocation = service.invoke({
      runId: "run-async",
      sessionId: "session-async",
      skillId: "codex-code-task",
      input: "run asynchronously",
      executionMode: "async"
    });
    const firstSignal = await Promise.race([
      invocation.then(() => "accepted" as const),
      new Promise<"still-running">((resolve) =>
        setImmediate(() => resolve("still-running"))
      )
    ]);
    releaseCompletion.resolve();
    const result = await invocation;

    expect(firstSignal).toBe("accepted");
    expect(result).toMatchObject({
      status: "accepted",
      executionMode: "async",
      agentCallId: "agent-call-async"
    });
    expect(terminalListener).not.toHaveBeenCalled();

    await service.waitForIdle();
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test("blocks for an outcome without notifying async terminal listeners", async () => {
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
          artifacts: [
            { id: "blocking-result", text: "completed while blocking" }
          ]
        });
      },
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-blocking"
    });
    service.onTerminal(terminalListener);
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-blocking",
        sessionId: "session-blocking",
        skillId: "codex-code-task",
        input: "block until completion",
        executionMode: "blocking"
      })
      .finally(() => {
        invocationSettled = true;
      });

    await watchStarted.promise;
    expect(invocationSettled).toBe(false);

    releaseCompletion.resolve();
    await expect(invocation).resolves.toMatchObject({
      status: "result",
      executionMode: "blocking",
      agentCallId: "agent-call-blocking",
      state: "completed",
      artifacts: [
        { id: "blocking-result", text: "completed while blocking" }
      ]
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test("returns an input-required pause to a blocking invocation", async () => {
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
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-blocking-paused"
    });
    service.onTerminal(terminalListener);
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-blocking-paused",
        sessionId: "session-blocking-paused",
        skillId: "codex-code-task",
        input: "block until input is needed",
        executionMode: "blocking"
      })
      .finally(() => {
        invocationSettled = true;
      });

    await subscriptionHeldOpen.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWhileSubscriptionWasOpen = invocationSettled;

    await expect(invocation).resolves.toMatchObject({
      status: "result",
      executionMode: "blocking",
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

  test("does not subscribe when a blocking invocation is accepted in a paused state", async () => {
    const watchTask = vi.fn(async function* () {
      yield task("working");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () =>
        task("auth-required", { statusMessage: "sign in is required" }),
      watchTask,
      continueTask: rejectUnexpectedContinuation,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-blocking-initially-paused"
    });

    await expect(
      service.invoke({
        runId: "run-blocking-initially-paused",
        sessionId: "session-blocking-initially-paused",
        skillId: "codex-code-task",
        input: "return the initial auth request",
        executionMode: "blocking"
      })
    ).resolves.toMatchObject({
      status: "result",
      executionMode: "blocking",
      state: "auth-required",
      statusMessage: "sign in is required"
    });
    await service.waitForIdle();

    expect(watchTask).not.toHaveBeenCalled();
  });

  test("stops a blocking invocation when the caller aborts before the remote outcome", async () => {
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
      continueTask: rejectUnexpectedContinuation,
      cancelTask
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-blocking-aborted"
    });
    const controller = new AbortController();
    const canceled = new Error("MainAgent turn canceled");
    let invocationSettled = false;

    const invocation = service
      .invoke({
        runId: "run-blocking-aborted",
        sessionId: "session-blocking-aborted",
        skillId: "codex-code-task",
        input: "cancel the blocking invocation with its caller",
        executionMode: "blocking",
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
    });

    expect(receipt).toEqual({
      status: "accepted",
      executionMode: "async",
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

  test("converts an async watcher failure into one failed terminal record", async () => {
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
    });
    await service.waitForIdle();

    expect(service.getByAgentCallId("agent-call-paused")).toMatchObject({
      state: "input-required",
      statusMessage: "approval is required"
    });
    expect(terminalListener).not.toHaveBeenCalled();
  });

  test("preserves structured questions from an input-required snapshot", async () => {
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        yield task("input-required", {
          statusMessage: "Scope: Which files may be changed?",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files may be changed?",
              isOther: false,
              isSecret: false,
              options: [
                {
                  label: "Adapter only",
                  description: "Limit changes to the Codex adapter."
                }
              ]
            }
          ]
        })
      },
      continueTask: async () => task("working"),
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-questions"
    });

    await service.submit({
      runId: "run-questions",
      sessionId: "session-questions",
      skillId: "codex-code-task",
      input: "ask before choosing a scope",
      executionMode: "async"
    });
    await service.waitForIdle();

    expect(service.getByTaskId("a2a-task-01")?.questions).toEqual([
      expect.objectContaining({
        id: "scope",
        question: "Which files may be changed?",
        options: [expect.objectContaining({ label: "Adapter only" })]
      })
    ]);
  });

  test("continues the same paused task with structured answers and restarts its watcher", async () => {
    let watchCycle = 0;
    const continueTask = vi.fn(async () => task("working"));
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
        watchCycle += 1;
        if (watchCycle === 1) {
          yield task("input-required", {
            statusMessage: "Scope: Which files may be changed?",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which files may be changed?",
                isOther: false,
                isSecret: false,
                options: null
              }
            ]
          });
          return;
        }
        yield task("completed", {
          artifacts: [{ id: "result", text: "continued the original task" }]
        });
      },
      continueTask,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-continue",
      createMessageId: () => "message-continue"
    });
    service.onTerminal(terminalListener);

    await service.submit({
      runId: "run-continue",
      sessionId: "session-continue",
      skillId: "codex-code-task",
      input: "pause and continue",
      executionMode: "async"
    });
    await service.waitForIdle();

    await expect(
      service.continueTask("a2a-task-01", { scope: ["Adapter only"] })
    ).resolves.toMatchObject({
      taskId: "a2a-task-01",
      state: "working",
      questions: undefined,
      statusMessage: undefined
    });
    expect(continueTask).toHaveBeenCalledWith({
      taskId: "a2a-task-01",
      contextId: "a2a-context-01",
      messageId: "message-continue",
      signal: expect.any(AbortSignal),
      answers: { scope: ["Adapter only"] }
    });

    await service.waitForIdle();
    expect(service.getByTaskId("a2a-task-01")).toMatchObject({
      state: "completed",
      artifacts: [{ id: "result", text: "continued the original task" }]
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
  });

  test("rejects a concurrent continuation before transport while the first one completes", async () => {
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    let continuationCalls = 0;
    let watchCycle = 0;
    const continueTask = vi.fn(async () => {
      continuationCalls += 1;
      if (continuationCalls > 1) {
        throw new Error("duplicate continuation reached transport");
      }
      continuationStarted.resolve();
      await releaseContinuation.promise;
      return task("working");
    });
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
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
                options: null
              }
            ]
          });
          return;
        }
        yield task("completed", {
          artifacts: [{ id: "result", text: "first continuation completed" }]
        });
      },
      continueTask,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-concurrent-continuation"
    });

    await service.submit({
      runId: "run-concurrent-continuation",
      sessionId: "session-concurrent-continuation",
      skillId: "codex-code-task",
      input: "continue only once",
      executionMode: "async"
    });
    await service.waitForIdle();

    const firstContinuation = service.continueTask("a2a-task-01", {
      scope: ["Adapter only"]
    });
    await continuationStarted.promise;
    await expect(
      service.continueTask("a2a-task-01", { scope: ["All files"] })
    ).rejects.toThrow(/already has an active continuation/);
    expect(continueTask).toHaveBeenCalledTimes(1);

    releaseContinuation.resolve();
    await expect(firstContinuation).resolves.toMatchObject({
      taskId: "a2a-task-01",
      state: "working"
    });
    await service.waitForIdle();

    expect(service.getByTaskId("a2a-task-01")).toMatchObject({
      state: "completed",
      artifacts: [{ id: "result", text: "first continuation completed" }]
    });
  });

  test("waits for an in-flight continuation during close without restarting its watcher", async () => {
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    let continuationSignal: AbortSignal | undefined;
    let watchCycle = 0;
    const cancelTask = vi.fn(async () => task("canceled"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
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
                options: null
              }
            ]
          });
          return;
        }
        yield task("completed");
      },
      continueTask: async (request) => {
        continuationSignal = request.signal;
        continuationStarted.resolve();
        await releaseContinuation.promise;
        return task("working");
      },
      cancelTask
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-close-continuation"
    });

    await service.submit({
      runId: "run-close-continuation",
      sessionId: "session-close-continuation",
      skillId: "codex-code-task",
      input: "pause and close while continuing",
      executionMode: "async"
    });
    await service.waitForIdle();

    const continuation = service.continueTask("a2a-task-01", {
      scope: ["Adapter only"]
    });
    await continuationStarted.promise;
    let closeSettled = false;
    const closing = service.close().finally(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeWaitedForContinuation = !closeSettled;
    const continuationWasAborted = continuationSignal?.aborted === true;

    releaseContinuation.resolve();
    const continuationOutcome = await continuation.then(
      () => "resolved" as const,
      (error: unknown) => error
    );
    await closing;

    expect(closeWaitedForContinuation).toBe(true);
    expect(continuationWasAborted).toBe(true);
    expect(continuationOutcome).toBeInstanceOf(Error);
    expect((continuationOutcome as Error).message).toMatch(
      /closed during continuation/
    );
    expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");
    expect(watchCycle).toBe(1);
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("input-required");
  });

  test("does not start a watcher when close begins while applying a continued snapshot", async () => {
    const closeTriggered = deferred();
    let clockTicks = 0;
    let watchCycle = 0;
    let service!: AgentCallService;
    let closing!: Promise<void>;
    const cancelTask = vi.fn(async () => task("canceled"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
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
                options: null
              }
            ]
          });
          return;
        }
        yield task("completed");
      },
      continueTask: async () => task("working"),
      cancelTask
    };
    service = new AgentCallService({
      transport,
      createId: () => "agent-call-close-after-apply",
      now: () => {
        clockTicks += 1;
        if (clockTicks === 3) {
          queueMicrotask(() => {
            closing = service.close();
            closeTriggered.resolve();
          });
        }
        return new Date(`2026-07-13T00:00:0${clockTicks}.000Z`);
      }
    });

    await service.submit({
      runId: "run-close-after-apply",
      sessionId: "session-close-after-apply",
      skillId: "codex-code-task",
      input: "close between apply and watch",
      executionMode: "async"
    });
    await service.waitForIdle();

    const continuation = service.continueTask("a2a-task-01", {
      scope: ["Adapter only"]
    });
    await closeTriggered.promise;
    const continuationOutcome = await continuation.then(
      () => "resolved" as const,
      (error: unknown) => error
    );
    await closing;

    expect(continuationOutcome).toBeInstanceOf(Error);
    expect((continuationOutcome as Error).message).toMatch(
      /closed during continuation/
    );
    expect(cancelTask).toHaveBeenCalledWith("a2a-task-01");
    expect(watchCycle).toBe(1);
    expect(service.getByTaskId("a2a-task-01")?.state).toBe("input-required");
  });

  test("notifies completion after a blocking invocation was returned as input-required and continued", async () => {
    let watchCycle = 0;
    const terminalListener = vi.fn();
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("submitted"),
      async *watchTask() {
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
                options: null
              }
            ]
          });
          return;
        }
        yield task("completed", {
          artifacts: [{ id: "result", text: "blocking continuation completed" }]
        });
      },
      continueTask: async () => task("working"),
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-blocking-continue",
      createMessageId: () => "message-blocking-continue"
    });
    service.onTerminal(terminalListener);

    await expect(
      service.invoke({
        runId: "run-blocking-continue",
        sessionId: "session-blocking-continue",
        skillId: "codex-code-task",
        input: "pause this blocking call",
        executionMode: "blocking"
      })
    ).resolves.toMatchObject({
      state: "input-required",
      questions: [expect.objectContaining({ id: "scope" })]
    });

    await service.continueTask("a2a-task-01", {
      scope: ["Adapter only"]
    });
    await service.waitForIdle();

    expect(terminalListener).toHaveBeenCalledTimes(1);
    expect(terminalListener.mock.calls[0]?.[0]).toMatchObject({
      executionMode: "blocking",
      state: "completed",
      artifacts: [{ text: "blocking continuation completed" }]
    });
  });

  test("rejects continuation unless the tracked task is input-required", async () => {
    const continueTask = vi.fn(async () => task("working"));
    const transport: AgentCallTransport = {
      discoverCapability: async (skillId) => ({ id: skillId, name: skillId }),
      submitTask: async () => task("working"),
      async *watchTask() {},
      continueTask,
      cancelTask: async () => task("canceled")
    };
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-not-paused"
    });
    await service.submit({
      runId: "run-not-paused",
      sessionId: "session-not-paused",
      skillId: "codex-code-task",
      input: "still working",
      executionMode: "async"
    });

    await expect(
      service.continueTask("a2a-task-01", { scope: ["Adapter only"] })
    ).rejects.toThrow(/input-required/);
    expect(continueTask).not.toHaveBeenCalled();

    await service.close();
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
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
      continueTask: rejectUnexpectedContinuation,
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
      executionMode: "async"
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
