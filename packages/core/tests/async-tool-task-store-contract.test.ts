import { describe, expect, test } from "vitest";

import type { AsyncToolTask } from "../src/async-tool-task/types.js";
import type { AsyncToolTaskStore } from "../src/async-tool-task/async-tool-task-store.js";
import { type AsyncToolTaskPrivateReference } from "../src/async-tool-task/async-tool-task-store.js";
import { InMemoryAsyncToolTaskStore } from "../src/async-tool-task/in-memory-async-tool-task-store.js";

function task(overrides: Partial<AsyncToolTask> = {}): AsyncToolTask {
  return {
    taskId: "task-1",
    kind: "agent-call",
    quotaPool: "a2a",
    sessionId: "session-1",
    sourceRunId: "run-1",
    sourceToolCallId: "call-1",
    toolName: "submit_codex_agent_call",
    state: "submitting",
    payload: { artifacts: [] },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

const privateReference: AsyncToolTaskPrivateReference = {
  namespace: "agent-call/a2a",
  agentId: "codex-main",
  externalTaskId: "a2a-task-1",
  contextId: "a2a-context-1",
  metadata: { skillId: "codex" },
};

describe("AsyncToolTaskStore contract", () => {
  test("inserts a task with a private reference and returns defensive copies", () => {
    const store = new InMemoryAsyncToolTaskStore();
    const submitted = task();

    expect(store.insert(submitted, { privateReference })).toEqual({
      status: "inserted",
      task: submitted,
    });
    expect(store.get("session-1", "task-1")).toEqual(submitted);
    expect(store.getPrivateReference("task-1")).toEqual(privateReference);

    const read = store.get("session-1", "task-1")!;
    (read.payload as { artifacts: string[] }).artifacts.push("mutated");
    expect(store.get("session-1", "task-1")!.payload).toEqual({
      artifacts: [],
    });
    expect(store.insert(task(), { privateReference })).toEqual({
      status: "duplicate",
      task: task(),
    });
  });

  test("compares before replacing, preserves one source fact, and recovers active tasks", () => {
    const store = new InMemoryAsyncToolTaskStore();
    const submitted = task();
    store.insert(submitted);

    const accepted = task({
      state: "submitted",
      updatedAt: "2026-08-13T00:01:00.000Z",
    });
    expect(store.replace(submitted, accepted, { privateReference })).toEqual(
      accepted,
    );
    expect(() => store.replace(submitted, accepted)).toThrow(
      /compare-and-replace conflict/i,
    );
    expect(() =>
      store.insert(
        task({ taskId: "task-2", payload: { artifacts: ["other"] } }),
      ),
    ).toThrow(/existing task or source/i);
    expect(() =>
      store.insert(
        task({
          taskId: "task-2",
          sourceToolCallId: "call-2",
          payload: { artifacts: ["other"] },
        }),
        {
          privateReference: {
            ...privateReference,
            externalTaskId: "a2a-task-1",
          },
        },
      ),
    ).toThrow(/external reference conflicts/i);

    expect(
      store.recoverNonTerminal({
        updatedAt: "2026-08-13T00:02:00.000Z",
        statusMessage: "requires reconciliation after restart",
      }),
    ).toEqual([
      task({
        state: "unknown",
        statusMessage: "requires reconciliation after restart",
        updatedAt: "2026-08-13T00:02:00.000Z",
      }),
    ]);
  });

  test("returns one immutable task for the same source and preserves terminal facts", () => {
    const store: AsyncToolTaskStore = new InMemoryAsyncToolTaskStore();
    const submitted = task();
    store.insert(submitted);
    const completed = task({
      state: "completed",
      payload: { artifacts: ["done"] },
      updatedAt: "2026-08-13T00:01:00.000Z",
    });
    store.replace(submitted, completed);

    expect(
      store.recoverNonTerminal({
        updatedAt: "2026-08-13T00:02:00.000Z",
        statusMessage: "requires reconciliation after restart",
      }),
    ).toEqual([]);
    expect(store.getBySource("session-1", "run-1", "call-1")).toEqual(
      completed,
    );
  });
});
