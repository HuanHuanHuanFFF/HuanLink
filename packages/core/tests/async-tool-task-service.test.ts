import { describe, expect, test, vi } from "vitest";

import {
  InMemoryAsyncToolTaskStore,
  AsyncToolTaskService,
  SessionTaskQuotaService,
  type AsyncToolTask,
  type AsyncToolTaskKindDefinition,
  type AsyncToolTaskStore,
  type AsyncToolTaskStoreReplaceOptions,
} from "../src/index.js";

const fakeKind: AsyncToolTaskKindDefinition = {
  kind: "fake-delayed-tool",
  quotaPool: "async-tool",
  validatePayload: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { label?: unknown }).label !== "string"
    ) {
      throw new Error("fake-delayed-tool requires a label");
    }
    return { label: (value as { label: string }).label };
  },
  projectPublicStatus: ({ payload }) => ({
    payload: { label: payload.label! },
  }),
};

const otherFakeKind: AsyncToolTaskKindDefinition = {
  ...fakeKind,
  kind: "other-fake-delayed-tool",
};

const structuredFakeKind: AsyncToolTaskKindDefinition = {
  kind: "structured-fake-delayed-tool",
  quotaPool: "async-tool",
  validatePayload: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { first?: unknown }).first !== "number" ||
      typeof (value as { second?: unknown }).second !== "number"
    ) {
      throw new Error("structured-fake-delayed-tool requires two numbers");
    }
    return value as { first: number; second: number };
  },
  projectPublicStatus: ({ payload }) => ({ payload }),
};

function reserveRequest(
  overrides: Partial<{
    sessionId: string;
    sourceRunId: string;
    sourceToolCallId: string;
    toolName: string;
    kind: string;
    payload: { label: string };
  }> = {},
) {
  return {
    sessionId: "session-a",
    sourceRunId: "run-a",
    sourceToolCallId: "call-1",
    toolName: "start_fake_delayed_work",
    kind: fakeKind.kind,
    payload: { label: "first" },
    ...overrides,
  };
}

function taskRecord(
  overrides: Partial<AsyncToolTask> &
    Pick<AsyncToolTask, "taskId" | "sourceToolCallId" | "state">,
): AsyncToolTask {
  return {
    taskId: overrides.taskId,
    kind: overrides.kind ?? fakeKind.kind,
    quotaPool: overrides.quotaPool ?? fakeKind.quotaPool,
    sessionId: overrides.sessionId ?? "session-a",
    sourceRunId: overrides.sourceRunId ?? "run-a",
    sourceToolCallId: overrides.sourceToolCallId,
    toolName: overrides.toolName ?? "start_fake_delayed_work",
    state: overrides.state,
    payload: overrides.payload ?? { label: "persisted" },
    createdAt: overrides.createdAt ?? "2026-08-13T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-13T00:00:00.000Z",
    ...(overrides.statusMessage === undefined
      ? {}
      : { statusMessage: overrides.statusMessage }),
  };
}

describe("AsyncToolTaskService", () => {
  test("recovers every durable state without notifying and only restores non-terminal quota", () => {
    const states = [
      "submitting",
      "unknown",
      "submitted",
      "working",
      "input-required",
      "auth-required",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ] as const;
    const store = new InMemoryAsyncToolTaskStore();
    for (const [index, state] of states.entries()) {
      store.insert(
        taskRecord({
          taskId: `task-${state}`,
          sourceToolCallId: `call-${index}`,
          state,
        }),
      );
    }
    const quotas = quotaService({ a2a: 1, "async-tool": 1 });
    const service = new AsyncToolTaskService({
      store,
      quotaService: quotas,
      taskKinds: [fakeKind],
      createTaskId: () => "task-new",
      now: () => new Date("2026-08-13T01:00:00.000Z"),
    });
    const terminal = vi.fn();
    const inputRequired = vi.fn();
    service.onTerminal(terminal);
    service.onInputRequired(inputRequired);

    for (const state of states) {
      expect(service.get("session-a", `task-${state}`)).toMatchObject(
        ["completed", "failed", "canceled", "rejected"].includes(state)
          ? { state }
          : {
              state: "unknown",
              statusMessage: "reconciliation-required",
              updatedAt: "2026-08-13T01:00:00.000Z",
            },
      );
    }
    expect(terminal).not.toHaveBeenCalled();
    expect(inputRequired).not.toHaveBeenCalled();
    expect(
      service.reserve({
        sessionId: "session-a",
        sourceRunId: "run-new",
        sourceToolCallId: "call-new",
        toolName: "start_fake_delayed_work",
        kind: fakeKind.kind,
        payload: { label: "new" },
      }),
    ).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 1,
    });
  });

  test("restores above a lowered limit while keeping quota pools and Sessions isolated", () => {
    const a2aKind: AsyncToolTaskKindDefinition = {
      ...fakeKind,
      kind: "fake-a2a",
      quotaPool: "a2a",
    };
    const store = new InMemoryAsyncToolTaskStore();
    for (let index = 0; index < 3; index += 1) {
      store.insert(
        taskRecord({
          taskId: `old-${index}`,
          sourceToolCallId: `old-call-${index}`,
          state: "working",
        }),
      );
    }
    const service = new AsyncToolTaskService({
      store,
      quotaService: quotaService({ a2a: 1, "async-tool": 1 }),
      taskKinds: [fakeKind, a2aKind],
      createTaskId: (() => {
        const ids = ["a2a-new", "other-session-new"];
        return () => ids.shift()!;
      })(),
    });

    expect(
      service.reserve(
        reserveRequest({ sourceToolCallId: "blocked-same-pool" }),
      ),
    ).toMatchObject({ status: "limit-reached", quotaPool: "async-tool" });
    expect(
      service.reserve(
        reserveRequest({
          sourceToolCallId: "allowed-a2a",
          kind: a2aKind.kind,
        }),
      ),
    ).toMatchObject({ status: "reserved", task: { taskId: "a2a-new" } });
    expect(
      service.reserve(
        reserveRequest({
          sessionId: "session-b",
          sourceToolCallId: "allowed-other-session",
        }),
      ),
    ).toMatchObject({
      status: "reserved",
      task: { taskId: "other-session-new" },
    });
  });

  test("fails closed when any persisted Task kind is unavailable or its quota pool changed", () => {
    const terminalUnknownKind = new InMemoryAsyncToolTaskStore();
    terminalUnknownKind.insert(
      taskRecord({
        taskId: "terminal-unknown",
        sourceToolCallId: "call-terminal-unknown",
        kind: "removed-kind",
        quotaPool: "async-tool",
        state: "completed",
      }),
    );
    expect(
      () =>
        new AsyncToolTaskService({
          store: terminalUnknownKind,
          quotaService: quotaService({ a2a: 1, "async-tool": 1 }),
          taskKinds: [fakeKind],
        }),
    ).toThrow(/kind removed-kind is not registered/i);

    const changedPool = new InMemoryAsyncToolTaskStore();
    changedPool.insert(
      taskRecord({
        taskId: "active-wrong-pool",
        sourceToolCallId: "call-active-wrong-pool",
        quotaPool: "a2a",
        state: "working",
      }),
    );
    expect(
      () =>
        new AsyncToolTaskService({
          store: changedPool,
          quotaService: quotaService({ a2a: 1, "async-tool": 1 }),
          taskKinds: [fakeKind],
        }),
    ).toThrow(/quota pool/i);
  });

  test("commits Store mutations before changing quota or notifying listeners", () => {
    const store = new InMemoryAsyncToolTaskStore();
    const service = new AsyncToolTaskService({
      store,
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    const terminal = vi.fn();
    service.onTerminal(terminal);
    service.reserve(reserveRequest());
    service.accept("session-a", "task-1", { state: "working" });
    vi.spyOn(store, "replace").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      service.updateAccepted("session-a", "task-1", {
        state: "completed",
      }),
    ).toThrow("disk full");
    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "working",
    });
    expect(terminal).not.toHaveBeenCalled();
    expect(
      service.reserve(reserveRequest({ sourceToolCallId: "call-2" })),
    ).toMatchObject({
      status: "limit-reached",
    });

    service.updateAccepted("session-a", "task-1", { state: "completed" });
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("keeps a persistence-uncertain overlay until a later durable update succeeds", () => {
    const store = new InMemoryAsyncToolTaskStore();
    const service = new AsyncToolTaskService({
      store,
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    const terminal = vi.fn();
    service.onTerminal(terminal);
    service.reserve(reserveRequest());
    const privateReference = {
      namespace: "a2a",
      agentId: "codex-local",
      externalTaskId: "remote-1",
    } as const;
    service.retainPersistenceUncertain({
      ...reserveRequest(),
      taskId: "task-1",
      state: "unknown",
      statusMessage: "persistence-warning",
      privateReference,
    });

    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "unknown",
      statusMessage: "persistence-warning",
    });
    expect(service.getStatus("session-a", "task-1")).toMatchObject({
      status: "found",
      state: "unknown",
    });
    expect(store.get("session-a", "task-1")).toMatchObject({
      state: "submitting",
    });
    vi.spyOn(store, "replace").mockImplementationOnce(() => {
      throw new Error("database remains unavailable");
    });
    expect(() =>
      service.updateAccepted("session-a", "task-1", {
        state: "completed",
      }),
    ).toThrow("database remains unavailable");
    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "unknown",
    });
    expect(terminal).not.toHaveBeenCalled();
    expect(
      service.reserve(reserveRequest({ sourceToolCallId: "call-2" })),
    ).toMatchObject({
      status: "limit-reached",
    });

    service.updateAccepted("session-a", "task-1", { state: "completed" });
    expect(store.get("session-a", "task-1")).toMatchObject({
      state: "completed",
    });
    expect(store.getPrivateReference("task-1")).toEqual(privateReference);
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("exposes the shared Task quota service for blocking callers", () => {
    const quotaService = new SessionTaskQuotaService({
      limits: { a2a: 2, "async-tool": 3 },
    });
    const service = new AsyncToolTaskService({
      quotaService,
      taskKinds: [fakeKind],
    });

    expect(service.taskQuotaService).toBe(quotaService);
  });

  test("uses the Task kind quota pool without double-counting another pool", () => {
    const a2aKind: AsyncToolTaskKindDefinition = {
      ...fakeKind,
      kind: "fake-a2a",
      quotaPool: "a2a",
    };
    const service = new AsyncToolTaskService({
      quotaService: quotaService({ a2a: 1, "async-tool": 1 }),
      taskKinds: [fakeKind, a2aKind],
      createTaskId: (() => {
        const taskIds = ["async-task", "a2a-task"];
        return () => taskIds.shift()!;
      })(),
    });
    const request = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      toolName: "start_work",
      payload: { label: "first" },
    } as const;

    expect(
      service.reserve({
        ...request,
        sourceToolCallId: "async-call",
        kind: fakeKind.kind,
      }),
    ).toMatchObject({ status: "reserved", task: { taskId: "async-task" } });
    expect(
      service.reserve({
        ...request,
        sourceToolCallId: "a2a-call",
        kind: a2aKind.kind,
      }),
    ).toMatchObject({ status: "reserved", task: { taskId: "a2a-task" } });
    expect(
      service.reserve({
        ...request,
        sourceToolCallId: "second-async-call",
        kind: fakeKind.kind,
      }),
    ).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 1,
    });
  });

  test("adopts an accepted Task and takes quota ownership from a blocking caller", () => {
    const quotas = quotaService({ a2a: 1, "async-tool": 1 });
    const service = new AsyncToolTaskService({
      quotaService: quotas,
      taskKinds: [fakeKind],
    });
    const acquired = quotas.acquire("session-a", "async-tool");
    if (acquired.status !== "acquired") {
      throw new Error("test setup must acquire a quota slot");
    }

    const adopted = service.adoptAcceptedTask({
      taskId: "task-adopted",
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: fakeKind.kind,
      payload: { label: "first" },
      state: "unknown",
      quotaLease: acquired.lease,
    });
    acquired.lease.release();

    expect(adopted).toMatchObject({
      status: "adopted",
      task: { taskId: "task-adopted", state: "unknown" },
    });
    expect(quotas.acquire("session-a", "async-tool")).toMatchObject({
      status: "limit-reached",
    });

    service.updateAccepted("session-a", "task-adopted", {
      state: "completed",
    });
    expect(quotas.acquire("session-a", "async-tool").status).toBe("acquired");
  });

  test("reserves a HuanLink task and scopes it to its Session", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    const reserved = service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });

    if (reserved.status !== "reserved") {
      throw new Error("test setup must reserve a task");
    }

    expect(reserved).toEqual({
      status: "reserved",
      task: {
        taskId: "task-1",
        kind: "fake-delayed-tool",
        quotaPool: "async-tool",
        sessionId: "session-a",
        sourceRunId: "run-a",
        sourceToolCallId: "sdk-call-a",
        toolName: "start_fake_delayed_work",
        state: "submitting",
        payload: { label: "first" },
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    });
    expect(service.get("session-a", "task-1")).toEqual(reserved.task);
    expect(service.get("session-b", "task-1")).toBeUndefined();
  });

  test("does not reserve a duplicate source or exceed the Session active-task limit", () => {
    const taskIds = ["task-1", "task-2", "task-3"];
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [fakeKind],
      createTaskId: () => taskIds.shift()!,
    });
    const first = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    } as const;

    expect(service.reserve(first)).toMatchObject({
      status: "reserved",
      task: { taskId: "task-1" },
    });
    expect(service.reserve(first)).toEqual({
      status: "duplicate",
      task: expect.objectContaining({ taskId: "task-1" }),
    });
    expect(
      service.reserve({ ...first, sourceToolCallId: "sdk-call-b" }),
    ).toMatchObject({ status: "reserved", task: { taskId: "task-2" } });
    expect(
      service.reserve({ ...first, sourceToolCallId: "sdk-call-c" }),
    ).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 2,
    });

    expect(
      service.reserve({
        ...first,
        sessionId: "session-b",
        sourceToolCallId: "sdk-call-c",
      }),
    ).toMatchObject({ status: "reserved", task: { taskId: "task-3" } });
  });

  test("notifies one accepted terminal outcome and rejects terminal reversions or conflicts", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    const terminal = vi.fn();
    service.onTerminal(terminal);
    const reserved = service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    if (reserved.status !== "reserved") {
      throw new Error("test setup must reserve a task");
    }

    service.accept("session-a", "task-1", { state: "working" });
    service.updateAccepted("session-a", "task-1", {
      state: "completed",
      statusMessage: "done",
    });

    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: "task-1", state: "completed" }),
    );
    expect(() =>
      service.updateAccepted("session-a", "task-1", { state: "working" }),
    ).toThrow(/terminal/i);
    expect(() =>
      service.updateAccepted("session-a", "task-1", { state: "failed" }),
    ).toThrow(/terminal/i);
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("releases pre-accept rejection without notification", () => {
    const taskIds = ["task-1", "task-2"];
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => taskIds.shift()!,
    });
    const terminal = vi.fn();
    service.onTerminal(terminal);
    const first = service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    if (first.status !== "reserved") {
      throw new Error("test setup must reserve a task");
    }

    expect(
      service.rejectBeforeAcceptance(
        "session-a",
        "task-1",
        "remote unavailable",
      ),
    ).toEqual(
      expect.objectContaining({
        state: "rejected",
        statusMessage: "remote unavailable",
      }),
    );
    expect(terminal).not.toHaveBeenCalled();
    expect(
      service.reserve({
        sessionId: "session-a",
        sourceRunId: "run-a",
        sourceToolCallId: "sdk-call-b",
        toolName: "start_fake_delayed_work",
        kind: "fake-delayed-tool",
        payload: { label: "second" },
      }),
    ).toMatchObject({ status: "reserved", task: { taskId: "task-2" } });
  });

  test("rejects invalid kind registration, empty generated IDs, and conflicting duplicate sources", () => {
    expect(
      () =>
        new AsyncToolTaskService({
          maxActiveTasksPerSession: 1,
          taskKinds: [{ ...fakeKind, kind: "" }],
        }),
    ).toThrow(/kind/i);
    expect(
      () =>
        new AsyncToolTaskService({
          maxActiveTasksPerSession: 1,
          taskKinds: [fakeKind, { ...fakeKind }],
        }),
    ).toThrow(/duplicate/i);

    const emptyIdService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => " ",
    });
    expect(() =>
      emptyIdService.reserve({
        sessionId: "session-a",
        sourceRunId: "run-a",
        sourceToolCallId: "sdk-call-a",
        toolName: "start_fake_delayed_work",
        kind: "fake-delayed-tool",
        payload: { label: "first" },
      }),
    ).toThrow(/task id/i);

    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [fakeKind, otherFakeKind],
      createTaskId: () => "task-1",
    });
    const request = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    } as const;
    service.reserve(request);

    expect(() =>
      service.reserve({ ...request, toolName: "different_tool" }),
    ).toThrow(/source/i);
    expect(() =>
      service.reserve({ ...request, kind: "other-fake-delayed-tool" }),
    ).toThrow(/source/i);
    expect(() =>
      service.reserve({ ...request, payload: { label: "different" } }),
    ).toThrow(/source/i);
  });

  test("keeps records defensive and projects a public status without source identifiers", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    const reserved = service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    if (reserved.status !== "reserved") {
      throw new Error("test setup must reserve a task");
    }

    (reserved.task.payload as { label: string }).label = "mutated";
    expect(service.get("session-a", "task-1")?.payload).toEqual({
      label: "first",
    });

    const status = service.getStatus("session-a", "task-1");
    expect(status).toEqual({
      status: "found",
      taskId: "task-1",
      kind: "fake-delayed-tool",
      toolName: "start_fake_delayed_work",
      state: "submitting",
      payload: { label: "first" },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(status).not.toHaveProperty("sessionId");
    expect(status).not.toHaveProperty("sourceRunId");
    expect(status).not.toHaveProperty("sourceToolCallId");
    if (status.status !== "found") {
      throw new Error("test setup must find its task");
    }
    (status.payload as { label: string }).label = "mutated again";
    const reread = service.getStatus("session-a", "task-1");
    if (reread.status !== "found") {
      throw new Error("test setup must find its task again");
    }
    expect(reread.payload).toEqual({
      label: "first",
    });
    expect(service.getStatus("session-b", "task-1")).toEqual({
      status: "not-found",
      taskId: "task-1",
    });
  });

  test("uses the kind public projection instead of exposing private task data", () => {
    const privateKind: AsyncToolTaskKindDefinition = {
      kind: "private-delayed-tool",
      quotaPool: "async-tool",
      validatePayload: () => ({
        label: "safe label",
        a2aTaskId: "a2a-private",
        secret: "private-token",
      }),
      projectPublicStatus: ({ payload, state }) => ({
        payload: { label: payload.label! },
        statusMessage: state === "working" ? "working" : undefined,
      }),
    };
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [privateKind],
      createTaskId: () => "task-1",
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-private",
      toolName: "start_private_work",
      kind: "private-delayed-tool",
      payload: {},
    });
    service.accept("session-a", "task-1", {
      state: "working",
      statusMessage: "a2a-private private-token sdk-call-private",
    });

    expect(service.getStatus("session-a", "task-1")).toEqual(
      expect.objectContaining({
        status: "found",
        payload: { label: "safe label" },
        statusMessage: "working",
      }),
    );
    expect(
      JSON.stringify(service.getStatus("session-a", "task-1")),
    ).not.toMatch(/a2a-private|private-token|sdk-call-private/);
  });

  test("rejects internal identifier fields even if a kind public projection includes one", () => {
    const unsafeKind: AsyncToolTaskKindDefinition = {
      kind: "unsafe-public-tool",
      quotaPool: "async-tool",
      validatePayload: () => ({ label: "safe" }),
      projectPublicStatus: ({ payload }) => ({
        payload: { ...payload, nested: { sdkToolCallId: "sdk-private" } },
      }),
    };
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [unsafeKind],
      createTaskId: () => "task-1",
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-private",
      toolName: "start_unsafe_work",
      kind: "unsafe-public-tool",
      payload: {},
    });

    expect(() => service.getStatus("session-a", "task-1")).toThrow(
      /internal identifier/i,
    );
  });

  test("treats a matching accepted terminal repeat as idempotent and isolates listener failures", () => {
    const listenerError = vi.fn();
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
      onTerminalListenerError: listenerError,
    });
    const afterFailure = vi.fn();
    service.onTerminal(() => {
      throw new Error("listener failed");
    });
    service.onTerminal(afterFailure);
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    service.accept("session-a", "task-1", { state: "working" });

    expect(() =>
      service.updateAccepted("session-a", "task-1", {
        state: "completed",
        statusMessage: "done",
      }),
    ).not.toThrow();
    expect(
      service.updateAccepted("session-a", "task-1", {
        state: "completed",
        statusMessage: "done",
      }),
    ).toEqual(expect.objectContaining({ state: "completed" }));
    expect(afterFailure).toHaveBeenCalledTimes(1);
    expect(listenerError).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        kind: "fake-delayed-tool",
        sessionId: "session-a",
        error: expect.any(Error),
      }),
    );
    expect(() =>
      service.updateAccepted("session-a", "task-1", {
        state: "completed",
        statusMessage: "different",
      }),
    ).toThrow(/conflict/i);
    expect(() =>
      service.updateAccepted("session-a", "task-1", { state: "failed" }),
    ).toThrow(/conflict/i);
    expect(service.get("session-a", "task-1")).toEqual(
      expect.objectContaining({ state: "completed", statusMessage: "done" }),
    );
  });

  test("notifies when an externally accepted task is rejected", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    const terminal = vi.fn();
    service.onTerminal(terminal);
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });

    service.accept("session-a", "task-1", {
      state: "rejected",
      statusMessage: "remote policy rejected the task",
    });

    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ state: "rejected" }),
    );
  });

  test("keeps a terminal outcome but surfaces an unhandled listener failure", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    service.onTerminal(() => {
      throw new Error("re-entry enqueue failed");
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    service.accept("session-a", "task-1", { state: "working" });

    expect(() =>
      service.updateAccepted("session-a", "task-1", { state: "completed" }),
    ).toThrow(/terminal listener/i);
    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "completed",
    });
  });

  test("rejects unknown runtime states without corrupting the reserved task", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });

    expect(() =>
      service.accept("session-a", "task-1", {
        state: "bogus",
      } as never),
    ).toThrow(/state/i);
    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "submitting",
    });
  });

  test("holds the Session reservation across a re-entrant ID callback", () => {
    let nested: ReturnType<AsyncToolTaskService["reserve"]> | undefined;
    let service!: AsyncToolTaskService;
    let taskIdCall = 0;
    const request = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    } as const;
    service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => {
        taskIdCall += 1;
        if (taskIdCall === 1) {
          nested = service.reserve({
            ...request,
            sourceToolCallId: "sdk-call-b",
          });
          return "task-1";
        }
        return "task-2";
      },
    });

    expect(service.reserve(request)).toMatchObject({
      status: "reserved",
      task: { taskId: "task-1" },
    });
    expect(nested).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 1,
    });
  });

  test("releases an accepted terminal task while non-terminal states occupy the Session limit", () => {
    const taskIds = ["task-1", "task-2"];
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => taskIds.shift()!,
    });
    const request = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    } as const;

    service.reserve(request);
    service.accept("session-a", "task-1", { state: "unknown" });
    expect(
      service.reserve({ ...request, sourceToolCallId: "sdk-call-b" }),
    ).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 1,
    });

    service.updateAccepted("session-a", "task-1", { state: "completed" });
    expect(
      service.reserve({ ...request, sourceToolCallId: "sdk-call-b" }),
    ).toMatchObject({ status: "reserved", task: { taskId: "task-2" } });
  });

  test("keeps acceptance atomic when building the accepted state fails", () => {
    const timestamps = [
      new Date("2026-08-10T00:00:00.000Z"),
      new Date(Number.NaN),
    ];
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
      now: () => timestamps.shift()!,
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });

    expect(() =>
      service.accept("session-a", "task-1", { state: "working" }),
    ).toThrow();
    expect(() =>
      service.updateAccepted("session-a", "task-1", { state: "completed" }),
    ).toThrow(/not accepted/i);
    expect(service.get("session-a", "task-1")).toMatchObject({
      state: "submitting",
    });
  });

  test("preserves the last status message for an idempotent terminal update", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [fakeKind],
      createTaskId: () => "task-1",
    });
    service.reserve({
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: { label: "first" },
    });
    service.accept("session-a", "task-1", {
      state: "working",
      statusMessage: "halfway",
    });

    service.updateAccepted("session-a", "task-1", { state: "completed" });

    expect(
      service.updateAccepted("session-a", "task-1", { state: "completed" }),
    ).toMatchObject({ state: "completed", statusMessage: "halfway" });
  });

  test("deduplicates source payload regardless of key order", () => {
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [structuredFakeKind],
      createTaskId: () => "task-1",
    });
    const request = {
      sessionId: "session-a",
      sourceRunId: "run-a",
      sourceToolCallId: "sdk-call-a",
      toolName: "start_structured_fake_delayed_work",
      kind: "structured-fake-delayed-tool",
    } as const;

    service.reserve({ ...request, payload: { first: 1, second: 2 } });

    expect(
      service.reserve({ ...request, payload: { second: 2, first: 1 } }),
    ).toMatchObject({ status: "duplicate", task: { taskId: "task-1" } });
  });

  test("rejects a kind payload that is not lossless JSON", () => {
    const invalidKind: AsyncToolTaskKindDefinition = {
      kind: "invalid-json-tool",
      quotaPool: "async-tool",
      validatePayload: () =>
        ({ value: Number.NaN }) as unknown as ReturnType<
          AsyncToolTaskKindDefinition["validatePayload"]
        >,
      projectPublicStatus: ({ payload }) => ({ payload }),
    };
    const service = new AsyncToolTaskService({
      maxActiveTasksPerSession: 1,
      taskKinds: [invalidKind],
      createTaskId: () => "task-1",
    });

    expect(() =>
      service.reserve({
        sessionId: "session-a",
        sourceRunId: "run-a",
        sourceToolCallId: "sdk-call-a",
        toolName: "start_invalid_json_work",
        kind: "invalid-json-tool",
        payload: {},
      }),
    ).toThrow(/payload|finite|json/i);
    expect(service.getStatus("session-a", "task-1")).toEqual({
      status: "not-found",
      taskId: "task-1",
    });
  });
});

function quotaService(
  limits: ConstructorParameters<typeof SessionTaskQuotaService>[0]["limits"],
): SessionTaskQuotaService {
  return new SessionTaskQuotaService({ limits });
}
