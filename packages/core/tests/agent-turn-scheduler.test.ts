import { describe, expect, test, vi } from "vitest";

import { AgentTurnScheduler, type AgentRuntime } from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentTurnScheduler", () => {
  test("serializes fresh MainAgent turns within the same session", async () => {
    const releaseFirst = deferred();
    const run = vi.fn<AgentRuntime["run"]>(async (input) => {
      if (input.runId === "run-first") {
        await releaseFirst.promise;
      }
      return { output: input.runId };
    });
    const scheduler = new AgentTurnScheduler({ runtime: { run } });

    const first = scheduler.run({
      runId: "run-first",
      sessionId: "session-shared",
      input: "first",
    });
    const second = scheduler.run({
      runId: "run-reentry",
      sessionId: "session-shared",
      trigger: "agent_call_terminal",
      input: "second",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ output: "run-first" });
    await expect(second).resolves.toEqual({ output: "run-reentry" });
    expect(run.mock.calls.map(([input]) => input.runId)).toEqual([
      "run-first",
      "run-reentry",
    ]);
  });

  test("constructs a queued operation only after its session slot is available", async () => {
    const releaseFirst = deferred();
    const run = vi.fn<AgentRuntime["run"]>(async (input) => {
      await releaseFirst.promise;
      return { output: input.runId };
    });
    const scheduler = new AgentTurnScheduler({ runtime: { run } });
    const first = scheduler.run({
      runId: "run-first",
      sessionId: "session-shared",
      input: "first",
    });
    let latestInput = "before-queue";
    let constructedInput: string | undefined;
    const queued = scheduler.runOperation({
      sessionId: "session-shared",
      operation: async () => {
        constructedInput = latestInput;
        return { output: constructedInput };
      },
    });

    latestInput = "after-queue";
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(constructedInput).toBeUndefined();

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ output: "run-first" });
    await expect(queued).resolves.toEqual({ output: "after-queue" });
  });

  test("does not construct or start an aborted operation while it is queued", async () => {
    const releaseFirst = deferred();
    const run = vi.fn<AgentRuntime["run"]>(async (input) => {
      await releaseFirst.promise;
      return { output: input.runId };
    });
    const scheduler = new AgentTurnScheduler({ runtime: { run } });
    const first = scheduler.run({
      runId: "run-first",
      sessionId: "session-shared",
      input: "first",
    });
    const controller = new AbortController();
    const operation = vi.fn(async () => ({ output: "must-not-run" }));
    const queued = scheduler.runOperation({
      sessionId: "session-shared",
      signal: controller.signal,
      operation,
    });

    controller.abort(new Error("queued turn canceled"));
    releaseFirst.resolve();

    await expect(first).resolves.toEqual({ output: "run-first" });
    await expect(queued).rejects.toThrow("queued turn canceled");
    expect(operation).not.toHaveBeenCalled();
  });

  test("runs operations from different sessions in parallel", async () => {
    const releaseFirst = deferred();
    const run = vi.fn<AgentRuntime["run"]>(async (input) => {
      if (input.sessionId === "session-first") {
        await releaseFirst.promise;
      }
      return { output: input.runId };
    });
    const scheduler = new AgentTurnScheduler({ runtime: { run } });
    const first = scheduler.run({
      runId: "run-first",
      sessionId: "session-first",
      input: "first",
    });
    const secondOperation = vi.fn(async () => ({ output: "second" }));
    const second = scheduler.runOperation({
      sessionId: "session-second",
      operation: secondOperation,
    });

    await expect(second).resolves.toEqual({ output: "second" });
    expect(secondOperation).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ output: "run-first" });
  });
});
