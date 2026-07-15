import { describe, expect, test, vi } from "vitest";

import {
  AgentTurnScheduler,
  type AgentRuntime
} from "../src/index.js";

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
      input: "first"
    });
    const second = scheduler.run({
      runId: "run-reentry",
      sessionId: "session-shared",
      trigger: "agent_call_terminal",
      input: "second"
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ output: "run-first" });
    await expect(second).resolves.toEqual({ output: "run-reentry" });
    expect(run.mock.calls.map(([input]) => input.runId)).toEqual([
      "run-first",
      "run-reentry"
    ]);
  });
});
