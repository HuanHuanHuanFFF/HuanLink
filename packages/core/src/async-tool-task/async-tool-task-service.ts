import { randomUUID } from "node:crypto";

import type { HuanLinkTaskId } from "../shared/ids.js";
import type {
  AsyncToolTaskAcceptedUpdate,
  AsyncToolTask,
  AsyncToolTaskJsonValue,
  AsyncToolTaskInputRequiredListener,
  AsyncToolTaskKindDefinition,
  AsyncToolTaskPayload,
  AsyncToolTaskReserveRequest,
  AsyncToolTaskReserveResult,
  AsyncToolTaskStatusQueryResult,
  AsyncToolTaskStatusReader,
  AsyncToolTaskTerminalListener,
  AsyncToolTaskTerminalListenerError,
} from "./types.js";
import { isAsyncToolTaskState, isAsyncToolTaskTerminalState } from "./types.js";

export type AsyncToolTaskServiceOptions = {
  readonly maxActiveTasksPerSession: number;
  readonly taskKinds: readonly AsyncToolTaskKindDefinition[];
  readonly createTaskId?: () => HuanLinkTaskId;
  readonly now?: () => Date;
  readonly onTerminalListenerError?: (
    failure: AsyncToolTaskTerminalListenerError,
  ) => void;
};

export class AsyncToolTaskService implements AsyncToolTaskStatusReader {
  private readonly maxActiveTasksPerSession: number;
  private readonly taskKinds: ReadonlyMap<string, AsyncToolTaskKindDefinition>;
  private readonly createTaskId: () => HuanLinkTaskId;
  private readonly now: () => Date;
  private readonly onTerminalListenerError:
    | ((failure: AsyncToolTaskTerminalListenerError) => void)
    | undefined;
  private readonly tasks = new Map<HuanLinkTaskId, AsyncToolTask>();
  private readonly taskIdBySource = new Map<string, HuanLinkTaskId>();
  private readonly activeCountBySession = new Map<string, number>();
  private readonly pendingReservationCountBySession = new Map<string, number>();
  private readonly acceptedTaskIds = new Set<HuanLinkTaskId>();
  private readonly terminalNotifiedTaskIds = new Set<HuanLinkTaskId>();
  private readonly inputRequiredNotifiedTaskIds = new Set<HuanLinkTaskId>();
  private readonly terminalListeners = new Set<AsyncToolTaskTerminalListener>();
  private readonly inputRequiredListeners =
    new Set<AsyncToolTaskInputRequiredListener>();

  constructor(options: AsyncToolTaskServiceOptions) {
    if (!Number.isSafeInteger(options.maxActiveTasksPerSession)) {
      throw new Error("maxActiveTasksPerSession must be a safe integer");
    }
    if (options.maxActiveTasksPerSession <= 0) {
      throw new Error("maxActiveTasksPerSession must be positive");
    }
    this.maxActiveTasksPerSession = options.maxActiveTasksPerSession;
    this.taskKinds = validateTaskKinds(options.taskKinds);
    this.createTaskId = options.createTaskId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.onTerminalListenerError = options.onTerminalListenerError;
  }

  reserve(request: AsyncToolTaskReserveRequest): AsyncToolTaskReserveResult {
    requireNonBlank(request.sessionId, "sessionId");
    requireNonBlank(request.sourceRunId, "sourceRunId");
    requireNonBlank(request.sourceToolCallId, "sourceToolCallId");
    requireNonBlank(request.toolName, "toolName");
    const kind = this.taskKinds.get(request.kind);
    if (kind === undefined) {
      throw new Error(`Async Tool Task kind ${request.kind} is not registered`);
    }
    const payload = clonePayload(kind.validatePayload(request.payload));
    const sourceKey = sourceKeyFor(request);
    const existingTaskId = this.taskIdBySource.get(sourceKey);
    if (existingTaskId !== undefined) {
      const existing = this.tasks.get(existingTaskId)!;
      if (
        existing.kind !== kind.kind ||
        existing.toolName !== request.toolName ||
        !isSamePayload(existing.payload, payload)
      ) {
        throw new Error(
          "Async Tool Task source conflicts with an existing task request",
        );
      }
      return {
        status: "duplicate",
        task: cloneTask(existing),
      };
    }
    if (
      this.occupiedTaskCount(request.sessionId) >= this.maxActiveTasksPerSession
    ) {
      return {
        status: "limit-reached",
        maxActiveTasksPerSession: this.maxActiveTasksPerSession,
      };
    }
    this.adjustCount(
      this.pendingReservationCountBySession,
      request.sessionId,
      1,
    );
    try {
      const taskId = this.createTaskId();
      requireNonBlank(taskId, "task ID");
      const timestamp = this.now().toISOString();
      const reentrantTaskId = this.taskIdBySource.get(sourceKey);
      if (reentrantTaskId !== undefined) {
        return this.duplicateSourceResult(
          this.tasks.get(reentrantTaskId)!,
          kind.kind,
          request.toolName,
          payload,
        );
      }
      if (this.tasks.has(taskId)) {
        throw new Error(`Async Tool Task ${taskId} already exists`);
      }
      const task: AsyncToolTask = {
        taskId,
        kind: kind.kind,
        sessionId: request.sessionId,
        sourceRunId: request.sourceRunId,
        sourceToolCallId: request.sourceToolCallId,
        toolName: request.toolName,
        state: "submitting",
        payload,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.tasks.set(taskId, task);
      this.taskIdBySource.set(sourceKey, taskId);
      this.adjustCount(this.activeCountBySession, request.sessionId, 1);
      return { status: "reserved", task: cloneTask(task) };
    } finally {
      this.adjustCount(
        this.pendingReservationCountBySession,
        request.sessionId,
        -1,
      );
    }
  }

  get(sessionId: string, taskId: HuanLinkTaskId): AsyncToolTask | undefined {
    const task = this.tasks.get(taskId);
    return task?.sessionId === sessionId ? cloneTask(task) : undefined;
  }

  getStatus(
    sessionId: string,
    taskId: HuanLinkTaskId,
  ): AsyncToolTaskStatusQueryResult {
    const task = this.get(sessionId, taskId);
    if (task === undefined) {
      return { status: "not-found", taskId };
    }
    const kind = this.taskKinds.get(task.kind)!;
    const projection = kind.projectPublicStatus({
      state: task.state,
      payload: clonePayload(task.payload),
      ...(task.statusMessage === undefined
        ? {}
        : { statusMessage: task.statusMessage }),
    });
    const publicPayload = clonePayload(projection.payload);
    assertPublicPayload(publicPayload);
    if (
      projection.statusMessage !== undefined &&
      typeof projection.statusMessage !== "string"
    ) {
      throw new Error("Async Tool Task public statusMessage must be a string");
    }
    return {
      status: "found",
      taskId: task.taskId,
      kind: task.kind,
      toolName: task.toolName,
      state: task.state,
      payload: publicPayload,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(projection.statusMessage === undefined
        ? {}
        : { statusMessage: projection.statusMessage }),
    };
  }

  onTerminal(listener: AsyncToolTaskTerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  onInputRequired(listener: AsyncToolTaskInputRequiredListener): () => void {
    this.inputRequiredListeners.add(listener);
    return () => this.inputRequiredListeners.delete(listener);
  }

  accept(
    sessionId: string,
    taskId: HuanLinkTaskId,
    update: AsyncToolTaskAcceptedUpdate,
  ): AsyncToolTask {
    const task = this.requireTask(sessionId, taskId);
    if (task.state !== "submitting") {
      throw new Error(`Async Tool Task ${taskId} is not awaiting acceptance`);
    }
    assertAcceptedUpdate(update);
    return this.replaceAcceptedTask(task, update, true);
  }

  rejectBeforeAcceptance(
    sessionId: string,
    taskId: HuanLinkTaskId,
    statusMessage: string,
  ): AsyncToolTask {
    const task = this.requireTask(sessionId, taskId);
    if (task.state !== "submitting") {
      throw new Error(
        `Async Tool Task ${taskId} cannot be rejected before acceptance`,
      );
    }
    if (typeof statusMessage !== "string") {
      throw new Error("Async Tool Task statusMessage must be a string");
    }
    const rejected: AsyncToolTask = {
      ...task,
      state: "rejected",
      statusMessage,
      updatedAt: this.now().toISOString(),
    };
    this.tasks.set(taskId, rejected);
    this.adjustCount(this.activeCountBySession, task.sessionId, -1);
    return cloneTask(rejected);
  }

  updateAccepted(
    sessionId: string,
    taskId: HuanLinkTaskId,
    update: AsyncToolTaskAcceptedUpdate,
  ): AsyncToolTask {
    const task = this.requireTask(sessionId, taskId);
    if (!this.acceptedTaskIds.has(taskId)) {
      throw new Error(`Async Tool Task ${taskId} was not accepted`);
    }
    assertAcceptedUpdate(update);
    const effectivePayload = this.payloadForUpdate(task, update);
    if (isAsyncToolTaskTerminalState(task.state)) {
      const effectiveStatusMessage =
        update.statusMessage === undefined
          ? task.statusMessage
          : update.statusMessage;
      if (
        task.state === update.state &&
        task.statusMessage === effectiveStatusMessage &&
        isSamePayload(task.payload, effectivePayload)
      ) {
        return cloneTask(task);
      }
      throw new Error(`Async Tool Task ${taskId} terminal state conflicts`);
    }
    return this.replaceAcceptedTask(task, update);
  }

  private replaceAcceptedTask(
    task: AsyncToolTask,
    update: AsyncToolTaskAcceptedUpdate,
    markAccepted = false,
  ): AsyncToolTask {
    const payload = this.payloadForUpdate(task, update);
    const next: AsyncToolTask = {
      ...task,
      state: update.state,
      payload,
      ...(update.statusMessage === undefined
        ? {}
        : { statusMessage: update.statusMessage }),
      updatedAt: this.now().toISOString(),
    };
    if (markAccepted) {
      this.acceptedTaskIds.add(next.taskId);
    }
    this.tasks.set(next.taskId, next);
    if (next.state !== "input-required") {
      this.inputRequiredNotifiedTaskIds.delete(next.taskId);
    } else if (
      task.state !== "input-required" ||
      !this.inputRequiredNotifiedTaskIds.has(next.taskId)
    ) {
      this.notifyInputRequired(next);
    }
    if (
      !isAsyncToolTaskTerminalState(task.state) &&
      isAsyncToolTaskTerminalState(next.state)
    ) {
      this.adjustCount(this.activeCountBySession, task.sessionId, -1);
      this.notifyTerminal(next);
    }
    return cloneTask(next);
  }

  private notifyInputRequired(task: AsyncToolTask): void {
    if (this.inputRequiredNotifiedTaskIds.has(task.taskId)) {
      return;
    }
    this.inputRequiredNotifiedTaskIds.add(task.taskId);
    const failures: unknown[] = [];
    for (const listener of this.inputRequiredListeners) {
      try {
        listener(cloneTask(task));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Async Tool Task input-required listener failed",
      );
    }
  }

  private payloadForUpdate(
    task: AsyncToolTask,
    update: AsyncToolTaskAcceptedUpdate,
  ): AsyncToolTaskPayload {
    if (update.payload === undefined) {
      return task.payload;
    }
    const kind = this.taskKinds.get(task.kind)!;
    return clonePayload(kind.validatePayload(update.payload));
  }

  private notifyTerminal(task: AsyncToolTask): void {
    if (this.terminalNotifiedTaskIds.has(task.taskId)) {
      return;
    }
    this.terminalNotifiedTaskIds.add(task.taskId);
    const unhandledErrors: unknown[] = [];
    for (const listener of this.terminalListeners) {
      try {
        listener(cloneTask(task));
      } catch (error) {
        if (this.onTerminalListenerError === undefined) {
          unhandledErrors.push(error);
          continue;
        }
        try {
          this.onTerminalListenerError({
            taskId: task.taskId,
            kind: task.kind,
            sessionId: task.sessionId,
            error,
          });
        } catch (reportingError) {
          unhandledErrors.push(new AggregateError([error, reportingError]));
        }
      }
    }
    if (unhandledErrors.length > 0) {
      throw new AggregateError(
        unhandledErrors,
        "Async Tool Task terminal listener failed",
      );
    }
  }

  private requireTask(
    sessionId: string,
    taskId: HuanLinkTaskId,
  ): AsyncToolTask {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.sessionId !== sessionId) {
      throw new Error(
        `Async Tool Task ${taskId} was not found in this Session`,
      );
    }
    return task;
  }

  private duplicateSourceResult(
    existing: AsyncToolTask,
    kind: string,
    toolName: string,
    payload: AsyncToolTask["payload"],
  ): AsyncToolTaskReserveResult {
    if (
      existing.kind !== kind ||
      existing.toolName !== toolName ||
      !isSamePayload(existing.payload, payload)
    ) {
      throw new Error(
        "Async Tool Task source conflicts with an existing task request",
      );
    }
    return { status: "duplicate", task: cloneTask(existing) };
  }

  private occupiedTaskCount(sessionId: string): number {
    return (
      (this.activeCountBySession.get(sessionId) ?? 0) +
      (this.pendingReservationCountBySession.get(sessionId) ?? 0)
    );
  }

  private adjustCount(
    counts: Map<string, number>,
    sessionId: string,
    delta: 1 | -1,
  ): void {
    const next = (counts.get(sessionId) ?? 0) + delta;
    if (next < 0) {
      throw new Error("Async Tool Task Session count is inconsistent");
    }
    if (next === 0) {
      counts.delete(sessionId);
      return;
    }
    counts.set(sessionId, next);
  }
}

function sourceKeyFor(request: AsyncToolTaskReserveRequest): string {
  return JSON.stringify([
    request.sessionId,
    request.sourceRunId,
    request.sourceToolCallId,
  ]);
}

function validateTaskKinds(
  definitions: readonly AsyncToolTaskKindDefinition[],
): ReadonlyMap<string, AsyncToolTaskKindDefinition> {
  const result = new Map<string, AsyncToolTaskKindDefinition>();
  for (const definition of definitions) {
    requireNonBlank(definition.kind, "Async Tool Task kind");
    if (
      typeof definition.validatePayload !== "function" ||
      typeof definition.projectPublicStatus !== "function"
    ) {
      throw new Error(
        `Async Tool Task kind ${definition.kind} must define payload validation and public projection`,
      );
    }
    if (result.has(definition.kind)) {
      throw new Error(`Duplicate Async Tool Task kind ${definition.kind}`);
    }
    result.set(definition.kind, definition);
  }
  return result;
}

function requireNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
}

function assertAcceptedUpdate(update: AsyncToolTaskAcceptedUpdate): void {
  const state: unknown = update.state;
  if (!isAsyncToolTaskState(state) || state === "submitting") {
    throw new Error("Accepted Async Tool Task state is unsupported");
  }
  if (
    update.statusMessage !== undefined &&
    typeof update.statusMessage !== "string"
  ) {
    throw new Error("Async Tool Task statusMessage must be a string");
  }
}

function cloneTask(task: AsyncToolTask): AsyncToolTask {
  return {
    ...task,
    payload: clonePayload(task.payload),
  };
}

function clonePayload(
  payload: AsyncToolTask["payload"],
): AsyncToolTask["payload"] {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Async Tool Task payload must be a JSON object");
  }
  return JSON.parse(canonicalJson(payload)) as AsyncToolTask["payload"];
}

function assertPublicPayload(payload: AsyncToolTask["payload"]): void {
  visitPublicJson(payload);
}

function visitPublicJson(value: AsyncToolTaskJsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitPublicJson(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (
      normalizedKey.endsWith("toolcallid") ||
      normalizedKey.endsWith("a2ataskid") ||
      normalizedKey.endsWith("agentcallid") ||
      normalizedKey === "sourcerunid" ||
      normalizedKey === "sourcesessionid"
    ) {
      throw new Error(
        `Async Tool Task public payload cannot expose internal identifier field ${key}`,
      );
    }
    visitPublicJson(item);
  }
}

function isSamePayload(
  left: AsyncToolTask["payload"],
  right: AsyncToolTask["payload"],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Async Tool Task payload cannot contain non-finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Async Tool Task payload must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new Error("Async Tool Task payload must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(
            "Async Tool Task payload must not contain sparse arrays",
          );
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        "Async Tool Task payload must contain plain JSON objects",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("Async Tool Task payload must not contain symbol keys");
    }
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      throw new Error(
        "Async Tool Task payload must not contain non-enumerable values",
      );
    }
    const object = value as Readonly<Record<string, AsyncToolTaskJsonValue>>;
    return `{${keys
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
