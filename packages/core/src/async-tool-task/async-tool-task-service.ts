import { randomUUID } from "node:crypto";

import type { HuanLinkTaskId } from "../shared/ids.js";
import {
  SessionTaskQuotaService,
  type SessionTaskQuotaLease,
} from "../tasks/session-task-quota-service.js";
import type {
  AsyncToolTaskPrivateReference,
  AsyncToolTaskStore,
} from "./async-tool-task-store.js";
import { InMemoryAsyncToolTaskStore } from "./in-memory-async-tool-task-store.js";
import type {
  AsyncToolTaskAcceptedUpdate,
  AsyncToolTaskAdoptAcceptedRequest,
  AsyncToolTaskAdoptAcceptedResult,
  AsyncToolTask,
  AsyncToolTaskJsonValue,
  AsyncToolTaskInputRequiredListener,
  AsyncToolTaskKindDefinition,
  AsyncToolTaskMutationOptions,
  AsyncToolTaskPayload,
  AsyncToolTaskReserveRequest,
  AsyncToolTaskReserveResult,
  AsyncToolTaskRetainPersistenceUncertainRequest,
  AsyncToolTaskStatusQueryResult,
  AsyncToolTaskStatusReader,
  AsyncToolTaskTerminalListener,
  AsyncToolTaskTerminalListenerError,
} from "./types.js";
import { isAsyncToolTaskState, isAsyncToolTaskTerminalState } from "./types.js";

export type AsyncToolTaskServiceOptions = {
  /** Shared quota owner used when Task categories must have independent pools. */
  readonly quotaService?: SessionTaskQuotaService;
  /** Transitional isolated-test shorthand; production composition injects quotaService. */
  readonly maxActiveTasksPerSession?: number;
  readonly taskKinds: readonly AsyncToolTaskKindDefinition[];
  /** Durable Task fact owner. Defaults to process-local storage for isolated use. */
  readonly store?: AsyncToolTaskStore;
  readonly createTaskId?: () => HuanLinkTaskId;
  readonly now?: () => Date;
  readonly onTerminalListenerError?: (
    failure: AsyncToolTaskTerminalListenerError,
  ) => void;
};

export class AsyncToolTaskService implements AsyncToolTaskStatusReader {
  /** Shared admission owner for callers that must reserve the same Task pool. */
  readonly taskQuotaService: SessionTaskQuotaService;
  private readonly taskKinds: ReadonlyMap<string, AsyncToolTaskKindDefinition>;
  private readonly createTaskId: () => HuanLinkTaskId;
  private readonly now: () => Date;
  private readonly onTerminalListenerError:
    | ((failure: AsyncToolTaskTerminalListenerError) => void)
    | undefined;
  private readonly store: AsyncToolTaskStore;
  /** Accepted Tasks that could not be durably recorded; intentionally restart-volatile. */
  private readonly persistenceUncertainByTaskId = new Map<
    HuanLinkTaskId,
    AsyncToolTask
  >();
  private readonly persistenceUncertainTaskIdBySource = new Map<
    string,
    HuanLinkTaskId
  >();
  private readonly persistenceUncertainReferenceByTaskId = new Map<
    HuanLinkTaskId,
    AsyncToolTaskPrivateReference
  >();
  private readonly quotaLeaseByTaskId = new Map<
    HuanLinkTaskId,
    SessionTaskQuotaLease
  >();
  private readonly terminalNotifiedTaskIds = new Set<HuanLinkTaskId>();
  private readonly inputRequiredNotifiedTaskIds = new Set<HuanLinkTaskId>();
  private readonly terminalListeners = new Set<AsyncToolTaskTerminalListener>();
  private readonly inputRequiredListeners =
    new Set<AsyncToolTaskInputRequiredListener>();

  constructor(options: AsyncToolTaskServiceOptions) {
    if (
      options.quotaService !== undefined &&
      options.maxActiveTasksPerSession !== undefined
    ) {
      throw new Error(
        "AsyncToolTaskService accepts quotaService or maxActiveTasksPerSession, not both",
      );
    }
    this.taskQuotaService =
      options.quotaService ??
      new SessionTaskQuotaService({
        limits: {
          a2a: requireLegacyLimit(options.maxActiveTasksPerSession),
          "async-tool": requireLegacyLimit(options.maxActiveTasksPerSession),
        },
      });
    this.taskKinds = validateTaskKinds(options.taskKinds);
    this.store = options.store ?? new InMemoryAsyncToolTaskStore();
    this.createTaskId = options.createTaskId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.onTerminalListenerError = options.onTerminalListenerError;
    this.recoverPersistedTasks();
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
    const existing = this.getBySource(
      request.sessionId,
      request.sourceRunId,
      request.sourceToolCallId,
    );
    if (existing !== undefined) {
      return this.duplicateSourceResult(
        existing,
        kind.kind,
        request.toolName,
        payload,
      );
    }
    const quota = this.taskQuotaService.acquire(
      request.sessionId,
      kind.quotaPool,
    );
    if (quota.status === "limit-reached") {
      return {
        status: "limit-reached",
        quotaPool: quota.quotaPool,
        maxActiveTasksPerSession: quota.maxActiveTasksPerSession,
      };
    }
    let ownedLease: SessionTaskQuotaLease | undefined;
    try {
      const taskId = this.createTaskId();
      requireNonBlank(taskId, "task ID");
      const timestamp = this.now().toISOString();
      const reentrant = this.getBySource(
        request.sessionId,
        request.sourceRunId,
        request.sourceToolCallId,
      );
      if (reentrant !== undefined) {
        return this.duplicateSourceResult(
          reentrant,
          kind.kind,
          request.toolName,
          payload,
        );
      }
      if (this.store.get(request.sessionId, taskId) !== undefined) {
        throw new Error(`Async Tool Task ${taskId} already exists`);
      }
      const task: AsyncToolTask = {
        taskId,
        kind: kind.kind,
        quotaPool: kind.quotaPool,
        sessionId: request.sessionId,
        sourceRunId: request.sourceRunId,
        sourceToolCallId: request.sourceToolCallId,
        toolName: request.toolName,
        state: "submitting",
        payload,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const inserted = this.store.insert(task);
      if (inserted.status === "duplicate") {
        return this.duplicateSourceResult(
          inserted.task,
          kind.kind,
          request.toolName,
          payload,
        );
      }
      ownedLease = quota.lease.transfer();
      this.quotaLeaseByTaskId.set(taskId, ownedLease);
      return { status: "reserved", task: cloneTask(inserted.task) };
    } catch (error) {
      ownedLease?.release();
      throw error;
    } finally {
      quota.lease.release();
    }
  }

  adoptAcceptedTask(
    request: AsyncToolTaskAdoptAcceptedRequest,
  ): AsyncToolTaskAdoptAcceptedResult {
    requireNonBlank(request.taskId, "taskId");
    requireNonBlank(request.sessionId, "sessionId");
    requireNonBlank(request.sourceRunId, "sourceRunId");
    requireNonBlank(request.sourceToolCallId, "sourceToolCallId");
    requireNonBlank(request.toolName, "toolName");
    const kind = this.taskKinds.get(request.kind);
    if (kind === undefined) {
      throw new Error(`Async Tool Task kind ${request.kind} is not registered`);
    }
    if (
      request.quotaLease.sessionId !== request.sessionId ||
      request.quotaLease.quotaPool !== kind.quotaPool
    ) {
      throw new Error("Async Tool Task quota lease does not match its Task");
    }
    if (
      request.statusMessage !== undefined &&
      typeof request.statusMessage !== "string"
    ) {
      throw new Error("Async Tool Task statusMessage must be a string");
    }
    const payload = clonePayload(kind.validatePayload(request.payload));
    const existingBySource = this.getBySource(
      request.sessionId,
      request.sourceRunId,
      request.sourceToolCallId,
    );
    const existingByTaskId = this.get(request.sessionId, request.taskId);
    if (existingBySource !== undefined || existingByTaskId !== undefined) {
      const existing = existingBySource ?? existingByTaskId;
      if (
        existing === undefined ||
        existing.taskId !== request.taskId ||
        existing.sessionId !== request.sessionId ||
        existing.sourceRunId !== request.sourceRunId ||
        existing.sourceToolCallId !== request.sourceToolCallId ||
        existing.kind !== kind.kind ||
        existing.toolName !== request.toolName ||
        !isSamePayload(existing.payload, payload)
      ) {
        throw new Error(
          "Accepted Async Tool Task conflicts with an existing task or source",
        );
      }
      request.quotaLease.release();
      return { status: "duplicate", task: cloneTask(existing) };
    }
    const timestamp = this.now().toISOString();
    const task: AsyncToolTask = {
      taskId: request.taskId,
      kind: kind.kind,
      quotaPool: kind.quotaPool,
      sessionId: request.sessionId,
      sourceRunId: request.sourceRunId,
      sourceToolCallId: request.sourceToolCallId,
      toolName: request.toolName,
      state: "unknown",
      payload,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(request.statusMessage === undefined
        ? {}
        : { statusMessage: request.statusMessage }),
    };
    let ownedLease: SessionTaskQuotaLease | undefined;
    try {
      const inserted = this.store.insert(task, {
        ...(request.privateReference === undefined
          ? {}
          : { privateReference: request.privateReference }),
      });
      if (inserted.status === "duplicate") {
        request.quotaLease.release();
        return { status: "duplicate", task: cloneTask(inserted.task) };
      }
      ownedLease = request.quotaLease.transfer();
      this.quotaLeaseByTaskId.set(task.taskId, ownedLease);
      return { status: "adopted", task: cloneTask(inserted.task) };
    } catch (error) {
      ownedLease?.release();
      throw error;
    }
  }

  get(sessionId: string, taskId: HuanLinkTaskId): AsyncToolTask | undefined {
    const uncertain = this.persistenceUncertainByTaskId.get(taskId);
    if (uncertain !== undefined) {
      return uncertain.sessionId === sessionId
        ? cloneTask(uncertain)
        : undefined;
    }
    return this.store.get(sessionId, taskId);
  }

  getBySource(
    sessionId: string,
    sourceRunId: string,
    sourceToolCallId: string,
  ): AsyncToolTask | undefined {
    requireNonBlank(sessionId, "sessionId");
    requireNonBlank(sourceRunId, "sourceRunId");
    requireNonBlank(sourceToolCallId, "sourceToolCallId");
    const sourceKey = sourceKeyFor({
      sessionId,
      sourceRunId,
      sourceToolCallId,
    });
    const uncertainTaskId =
      this.persistenceUncertainTaskIdBySource.get(sourceKey);
    if (uncertainTaskId !== undefined) {
      return cloneTask(this.persistenceUncertainByTaskId.get(uncertainTaskId)!);
    }
    return this.store.getBySource(sessionId, sourceRunId, sourceToolCallId);
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

  /** Process-local diagnostic used to preserve a non-retryable receipt. */
  isPersistenceUncertain(sessionId: string, taskId: HuanLinkTaskId): boolean {
    return (
      this.persistenceUncertainByTaskId.get(taskId)?.sessionId === sessionId
    );
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
    options: AsyncToolTaskMutationOptions = {},
  ): AsyncToolTask {
    const task = this.requireTask(sessionId, taskId);
    if (task.state !== "submitting") {
      throw new Error(`Async Tool Task ${taskId} is not awaiting acceptance`);
    }
    assertAcceptedUpdate(update);
    return this.replaceAcceptedTask(task, update, options);
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
    const stored = this.store.replace(task, rejected);
    this.releaseQuota(taskId);
    return cloneTask(stored);
  }

  updateAccepted(
    sessionId: string,
    taskId: HuanLinkTaskId,
    update: AsyncToolTaskAcceptedUpdate,
    options: AsyncToolTaskMutationOptions = {},
  ): AsyncToolTask {
    const task = this.requireTask(sessionId, taskId);
    if (task.state === "submitting") {
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
    return this.replaceAcceptedTask(task, update, options);
  }

  retainPersistenceUncertain(
    request: AsyncToolTaskRetainPersistenceUncertainRequest,
  ): AsyncToolTask {
    requireNonBlank(request.taskId, "taskId");
    requireNonBlank(request.sessionId, "sessionId");
    requireNonBlank(request.sourceRunId, "sourceRunId");
    requireNonBlank(request.sourceToolCallId, "sourceToolCallId");
    requireNonBlank(request.toolName, "toolName");
    const kind = this.taskKinds.get(request.kind);
    if (kind === undefined) {
      throw new Error(`Async Tool Task kind ${request.kind} is not registered`);
    }
    if (
      request.quotaLease !== undefined &&
      (request.quotaLease.sessionId !== request.sessionId ||
        request.quotaLease.quotaPool !== kind.quotaPool)
    ) {
      throw new Error("Async Tool Task quota lease does not match its Task");
    }
    const payload = clonePayload(kind.validatePayload(request.payload));
    const sourceKey = sourceKeyFor(request);
    const knownTask =
      request.knownTask === undefined
        ? undefined
        : cloneAndValidateKnownTask(request.knownTask, request);
    const existing =
      this.persistenceUncertainByTaskId.get(request.taskId) ??
      knownTask ??
      this.getBySource(
        request.sessionId,
        request.sourceRunId,
        request.sourceToolCallId,
      );
    if (existing !== undefined && existing.taskId !== request.taskId) {
      throw new Error(
        "Persistence-uncertain Async Tool Task conflicts with an existing task or source",
      );
    }
    const durable =
      knownTask ?? this.store.get(request.sessionId, request.taskId);
    if (durable !== undefined && durable.state !== "submitting") {
      throw new Error(
        `Async Tool Task ${request.taskId} is already durably accepted`,
      );
    }
    if (
      existing !== undefined &&
      (existing.kind !== request.kind ||
        existing.toolName !== request.toolName ||
        !isSamePayload(existing.payload, payload))
    ) {
      throw new Error(
        "Persistence-uncertain Async Tool Task conflicts with an existing task or source",
      );
    }
    if (
      !this.quotaLeaseByTaskId.has(request.taskId) &&
      request.quotaLease === undefined
    ) {
      throw new Error(
        `Persistence-uncertain Async Tool Task ${request.taskId} has no quota lease`,
      );
    }
    const timestamp = this.now().toISOString();
    const uncertain: AsyncToolTask = {
      taskId: request.taskId,
      kind: request.kind,
      quotaPool: kind.quotaPool,
      sessionId: request.sessionId,
      sourceRunId: request.sourceRunId,
      sourceToolCallId: request.sourceToolCallId,
      toolName: request.toolName,
      state: "unknown",
      payload,
      createdAt: durable?.createdAt ?? existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(request.statusMessage === undefined
        ? {}
        : { statusMessage: request.statusMessage }),
    };
    if (!this.quotaLeaseByTaskId.has(request.taskId)) {
      this.quotaLeaseByTaskId.set(
        request.taskId,
        request.quotaLease!.transfer(),
      );
    }
    this.persistenceUncertainByTaskId.set(request.taskId, uncertain);
    this.persistenceUncertainTaskIdBySource.set(sourceKey, request.taskId);
    if (request.privateReference !== undefined) {
      this.persistenceUncertainReferenceByTaskId.set(
        request.taskId,
        request.privateReference,
      );
    }
    return cloneTask(uncertain);
  }

  private replaceAcceptedTask(
    task: AsyncToolTask,
    update: AsyncToolTaskAcceptedUpdate,
    options: AsyncToolTaskMutationOptions,
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
    const privateReference =
      options.privateReference ??
      this.persistenceUncertainReferenceByTaskId.get(task.taskId);
    const storeOptions = {
      ...(privateReference === undefined ? {} : { privateReference }),
    };
    const durable = this.store.get(task.sessionId, task.taskId);
    const stored =
      durable === undefined
        ? this.store.insert(next, storeOptions).task
        : this.store.replace(durable, next, storeOptions);
    this.persistenceUncertainByTaskId.delete(task.taskId);
    this.persistenceUncertainTaskIdBySource.delete(sourceKeyFor(task));
    this.persistenceUncertainReferenceByTaskId.delete(task.taskId);
    if (next.state !== "input-required") {
      this.inputRequiredNotifiedTaskIds.delete(stored.taskId);
    } else if (
      task.state !== "input-required" ||
      !this.inputRequiredNotifiedTaskIds.has(next.taskId)
    ) {
      this.notifyInputRequired(stored);
    }
    if (
      !isAsyncToolTaskTerminalState(task.state) &&
      isAsyncToolTaskTerminalState(next.state)
    ) {
      this.releaseQuota(stored.taskId);
      this.notifyTerminal(stored);
    }
    return cloneTask(stored);
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
    const task = this.get(sessionId, taskId);
    if (task === undefined) {
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

  private releaseQuota(taskId: HuanLinkTaskId): void {
    const lease = this.quotaLeaseByTaskId.get(taskId);
    if (lease === undefined) {
      throw new Error(`Async Tool Task ${taskId} has no quota lease`);
    }
    lease.release();
    this.quotaLeaseByTaskId.delete(taskId);
  }

  private recoverPersistedTasks(): void {
    const persisted = this.store.list();
    for (const task of persisted) {
      const definition = this.taskKinds.get(task.kind);
      if (definition === undefined) {
        throw new Error(
          `Persisted Async Tool Task kind ${task.kind} is not registered`,
        );
      }
      if (task.quotaPool !== definition.quotaPool) {
        throw new Error(
          `Persisted Async Tool Task kind ${task.kind} quota pool does not match its registered definition`,
        );
      }
    }
    const nonTerminal = persisted.filter(
      (task) => !isAsyncToolTaskTerminalState(task.state),
    );
    if (nonTerminal.length === 0) {
      return;
    }
    const recovered = this.store.recoverNonTerminal({
      updatedAt: this.now().toISOString(),
      statusMessage: "reconciliation-required",
    });
    const restoredLeases: SessionTaskQuotaLease[] = [];
    try {
      for (const task of recovered) {
        const lease = this.taskQuotaService.restore(
          task.sessionId,
          task.quotaPool,
        );
        restoredLeases.push(lease);
        this.quotaLeaseByTaskId.set(task.taskId, lease);
      }
    } catch (error) {
      for (const lease of restoredLeases) {
        lease.release();
      }
      this.quotaLeaseByTaskId.clear();
      throw error;
    }
  }
}

function sourceKeyFor(
  request: Pick<
    AsyncToolTaskReserveRequest,
    "sessionId" | "sourceRunId" | "sourceToolCallId"
  >,
): string {
  return JSON.stringify([
    request.sessionId,
    request.sourceRunId,
    request.sourceToolCallId,
  ]);
}

function cloneAndValidateKnownTask(
  task: AsyncToolTask,
  request: AsyncToolTaskRetainPersistenceUncertainRequest,
): AsyncToolTask {
  const cloned = cloneTask(task);
  if (
    cloned.taskId !== request.taskId ||
    cloned.sessionId !== request.sessionId ||
    cloned.sourceRunId !== request.sourceRunId ||
    cloned.sourceToolCallId !== request.sourceToolCallId ||
    cloned.toolName !== request.toolName ||
    cloned.kind !== request.kind ||
    cloned.state !== "submitting"
  ) {
    throw new Error(
      "Known persistence-uncertain Async Tool Task does not match its request",
    );
  }
  return cloned;
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

function requireLegacyLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("maxActiveTasksPerSession must be a safe integer");
  }
  if (value! <= 0) {
    throw new Error("maxActiveTasksPerSession must be positive");
  }
  return value!;
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
