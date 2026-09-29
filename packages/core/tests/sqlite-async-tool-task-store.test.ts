import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import {
  AsyncToolTaskService,
  SessionTaskQuotaService,
  type AsyncToolTaskKindDefinition,
} from "../src/index.js";
import type { AsyncToolTask } from "../src/async-tool-task/types.js";
import type { AsyncToolTaskPrivateReference } from "../src/async-tool-task/async-tool-task-store.js";
import { SqliteAsyncToolTaskStore } from "../src/async-tool-task/sqlite-async-tool-task-store.js";

const directories: string[] = [];
const stores: SqliteAsyncToolTaskStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "huanlink-task-store-"));
  directories.push(directory);
  return join(directory, "tasks.sqlite");
}

function open(path: string): SqliteAsyncToolTaskStore {
  const store = new SqliteAsyncToolTaskStore(path);
  stores.push(store);
  return store;
}

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

const asyncKind: AsyncToolTaskKindDefinition = {
  kind: "fake-async",
  quotaPool: "async-tool",
  validatePayload: (payload) => payload as AsyncToolTask["payload"],
  projectPublicStatus: ({ payload, statusMessage }) => ({
    payload,
    ...(statusMessage === undefined ? {} : { statusMessage }),
  }),
};

const a2aKind: AsyncToolTaskKindDefinition = {
  ...asyncKind,
  kind: "fake-a2a",
  quotaPool: "a2a",
};

describe("SqliteAsyncToolTaskStore", () => {
  test("persists Task facts and private references after reopening", () => {
    const path = databasePath();
    const first = open(path);
    expect(first.insert(task(), { privateReference }).status).toBe("inserted");
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open(path);
    expect(reopened.get("session-1", "task-1")).toEqual(task());
    expect(reopened.getBySource("session-1", "run-1", "call-1")).toEqual(
      task(),
    );
    expect(reopened.getPrivateReference("task-1")).toEqual(privateReference);
  });

  test("rolls back a Task insert when its private external reference conflicts", () => {
    const store = open(databasePath());
    store.insert(task(), { privateReference });

    expect(() =>
      store.insert(
        task({
          taskId: "task-2",
          sourceToolCallId: "call-2",
          payload: { artifacts: ["other"] },
        }),
        { privateReference },
      ),
    ).toThrow(/external reference conflicts/i);

    expect(store.get("session-1", "task-2")).toBeUndefined();
    expect(store.getBySource("session-1", "run-1", "call-2")).toBeUndefined();
  });

  test("normalizes only active tasks during recovery and keeps terminal facts", () => {
    const store = open(databasePath());
    store.insert(task());
    store.insert(
      task({
        taskId: "task-2",
        sourceToolCallId: "call-2",
        state: "completed",
        payload: { artifacts: ["done"] },
      }),
    );

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
    expect(store.get("session-1", "task-2")).toEqual(
      task({
        taskId: "task-2",
        sourceToolCallId: "call-2",
        state: "completed",
        payload: { artifacts: ["done"] },
      }),
    );
  });

  test("rolls back a replacement when its private reference conflicts", () => {
    const store = open(databasePath());
    store.insert(task(), { privateReference });
    const submitted = task({
      taskId: "task-2",
      sourceToolCallId: "call-2",
      payload: { artifacts: ["second"] },
    });
    store.insert(submitted);
    const accepted = task({
      taskId: "task-2",
      sourceToolCallId: "call-2",
      payload: { artifacts: ["accepted"] },
      state: "submitted",
      updatedAt: "2026-08-13T00:01:00.000Z",
    });

    expect(() =>
      store.replace(submitted, accepted, { privateReference }),
    ).toThrow(/external reference conflicts/i);
    expect(store.get("session-1", "task-2")).toEqual(submitted);
    expect(store.getPrivateReference("task-2")).toBeUndefined();
  });

  test("allows several private references without an external Task ID", () => {
    const store = open(databasePath());
    const referenceWithoutExternalId: AsyncToolTaskPrivateReference = {
      namespace: "agent-call/a2a",
      agentId: "codex-main",
      metadata: { skillId: "codex" },
    };
    store.insert(task(), { privateReference: referenceWithoutExternalId });
    store.insert(
      task({
        taskId: "task-2",
        sourceToolCallId: "call-2",
        payload: { artifacts: ["second"] },
      }),
      { privateReference: referenceWithoutExternalId },
    );

    expect(store.getPrivateReference("task-1")).toEqual(
      referenceWithoutExternalId,
    );
    expect(store.getPrivateReference("task-2")).toEqual(
      referenceWithoutExternalId,
    );
  });

  test("fails closed for corrupt Task state, payload, and private-reference records", () => {
    const path = databasePath();
    const store = open(path);
    store.insert(task(), { privateReference });
    store.insert(
      task({
        taskId: "task-2",
        sourceToolCallId: "call-2",
        payload: { artifacts: ["second"] },
      }),
    );
    store.insert(
      task({
        taskId: "task-3",
        sourceToolCallId: "call-3",
        payload: { artifacts: ["third"] },
      }),
      {
        privateReference: {
          namespace: "agent-call/other",
          agentId: "codex-main",
        },
      },
    );
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE async_tool_tasks SET state = ? WHERE task_id = ?")
      .run("invalid-state", "task-1");
    database
      .prepare("UPDATE async_tool_tasks SET payload_json = ? WHERE task_id = ?")
      .run("[]", "task-2");
    database
      .prepare(
        "UPDATE async_tool_task_private_refs SET namespace = ? WHERE task_id = ?",
      )
      .run(" ", "task-3");
    database.close();

    const reopened = open(path);
    expect(() => reopened.get("session-1", "task-1")).toThrow(
      /state is unsupported/i,
    );
    expect(() => reopened.get("session-1", "task-2")).toThrow(
      /payload is invalid JSON/i,
    );
    expect(() => reopened.getPrivateReference("task-3")).toThrow(
      /namespace must not be blank/i,
    );
  });

  test("closes idempotently and rejects later reads", () => {
    const store = open(databasePath());
    store.close();
    store.close();

    expect(() => store.list()).toThrow(/is closed/i);
  });

  test("reopens through the Task Service, normalizes active work, preserves terminal facts, and restores the original quota pool", () => {
    const path = databasePath();
    const firstStore = open(path);
    const ids = ["active-task", "terminal-task"];
    const first = new AsyncToolTaskService({
      store: firstStore,
      quotaService: new SessionTaskQuotaService({
        limits: { a2a: 2, "async-tool": 2 },
      }),
      taskKinds: [asyncKind, a2aKind],
      createTaskId: () => ids.shift()!,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const active = first.reserve({
      sessionId: "session-1",
      sourceRunId: "run-1",
      sourceToolCallId: "call-active",
      toolName: "start_async",
      kind: asyncKind.kind,
      payload: { label: "active" },
    });
    const terminal = first.reserve({
      sessionId: "session-1",
      sourceRunId: "run-1",
      sourceToolCallId: "call-terminal",
      toolName: "start_async",
      kind: asyncKind.kind,
      payload: { label: "terminal" },
    });
    expect(active.status).toBe("reserved");
    expect(terminal.status).toBe("reserved");
    first.accept("session-1", "active-task", { state: "working" });
    first.accept("session-1", "terminal-task", { state: "completed" });
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopenedStore = open(path);
    const reopened = new AsyncToolTaskService({
      store: reopenedStore,
      quotaService: new SessionTaskQuotaService({
        limits: { a2a: 1, "async-tool": 1 },
      }),
      taskKinds: [asyncKind, a2aKind],
      createTaskId: (() => {
        const reopenedIds = ["a2a-allowed"];
        return () => reopenedIds.shift()!;
      })(),
      now: () => new Date("2026-08-13T01:00:00.000Z"),
    });

    expect(reopened.getStatus("session-1", "active-task")).toMatchObject({
      status: "found",
      state: "unknown",
      statusMessage: "reconciliation-required",
    });
    expect(reopened.getStatus("session-1", "terminal-task")).toMatchObject({
      status: "found",
      state: "completed",
    });
    expect(
      reopened.reserve({
        sessionId: "session-1",
        sourceRunId: "run-2",
        sourceToolCallId: "call-blocked",
        toolName: "start_async",
        kind: asyncKind.kind,
        payload: { label: "blocked" },
      }),
    ).toMatchObject({ status: "limit-reached", quotaPool: "async-tool" });
    expect(
      reopened.reserve({
        sessionId: "session-1",
        sourceRunId: "run-2",
        sourceToolCallId: "call-a2a",
        toolName: "start_a2a",
        kind: a2aKind.kind,
        payload: { label: "allowed" },
      }),
    ).toMatchObject({ status: "reserved", task: { taskId: "a2a-allowed" } });
  });
});
