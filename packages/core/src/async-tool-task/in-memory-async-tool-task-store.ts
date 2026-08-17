import type { HuanLinkTaskId, RunId, SessionId } from "../shared/ids.js";

import {
  isAsyncToolTaskState,
  isAsyncToolTaskTerminalState,
  type AsyncToolTask,
  type AsyncToolTaskJsonValue,
  type AsyncToolTaskPayload,
} from "./types.js";
import { TASK_QUOTA_POOLS } from "../tasks/session-task-quota-service.js";
import type {
  AsyncToolTaskPrivateReference,
  AsyncToolTaskStore,
  AsyncToolTaskStoreInsertOptions,
  AsyncToolTaskStoreInsertResult,
  AsyncToolTaskStoreReplaceOptions,
} from "./async-tool-task-store.js";

/** Process-local Task Store used by isolated tests and fake runtimes. */
export class InMemoryAsyncToolTaskStore implements AsyncToolTaskStore {
  private readonly tasks = new Map<HuanLinkTaskId, AsyncToolTask>();
  private readonly taskIdBySource = new Map<string, HuanLinkTaskId>();
  private readonly privateReferences = new Map<
    HuanLinkTaskId,
    AsyncToolTaskPrivateReference
  >();
  private readonly taskIdByExternalReference = new Map<
    string,
    HuanLinkTaskId
  >();

  get(sessionId: SessionId, taskId: HuanLinkTaskId): AsyncToolTask | undefined {
    const task = this.tasks.get(taskId);
    return task?.sessionId === sessionId ? cloneTask(task) : undefined;
  }

  getBySource(
    sessionId: SessionId,
    sourceRunId: RunId,
    sourceToolCallId: string,
  ): AsyncToolTask | undefined {
    const taskId = this.taskIdBySource.get(
      sourceKey(sessionId, sourceRunId, sourceToolCallId),
    );
    return taskId === undefined
      ? undefined
      : cloneTask(this.tasks.get(taskId)!);
  }

  list(): readonly AsyncToolTask[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  insert(
    task: AsyncToolTask,
    options: AsyncToolTaskStoreInsertOptions = {},
  ): AsyncToolTaskStoreInsertResult {
    const stored = cloneAndValidateTask(task);
    const privateReference = cloneAndValidatePrivateReference(
      options.privateReference,
    );
    const byTaskId = this.tasks.get(stored.taskId);
    const bySourceId = this.taskIdBySource.get(
      sourceKey(stored.sessionId, stored.sourceRunId, stored.sourceToolCallId),
    );

    if (byTaskId !== undefined || bySourceId !== undefined) {
      const existing =
        byTaskId ??
        (bySourceId === undefined ? undefined : this.tasks.get(bySourceId));
      if (existing === undefined || !sameTask(existing, stored)) {
        throw new Error(
          "Async Tool Task conflicts with an existing task or source",
        );
      }
      this.assertPrivateReference(existing.taskId, privateReference);
      return { status: "duplicate", task: cloneTask(existing) };
    }

    this.assertExternalReferenceAvailable(stored.taskId, privateReference);
    this.tasks.set(stored.taskId, stored);
    this.taskIdBySource.set(
      sourceKey(stored.sessionId, stored.sourceRunId, stored.sourceToolCallId),
      stored.taskId,
    );
    this.storePrivateReference(stored.taskId, privateReference);
    return { status: "inserted", task: cloneTask(stored) };
  }

  replace(
    expected: AsyncToolTask,
    next: AsyncToolTask,
    options: AsyncToolTaskStoreReplaceOptions = {},
  ): AsyncToolTask {
    const expectedTask = cloneAndValidateTask(expected);
    const nextTask = cloneAndValidateTask(next);
    const current = this.tasks.get(expectedTask.taskId);
    if (current === undefined || !sameTask(current, expectedTask)) {
      throw new Error("Async Tool Task compare-and-replace conflict");
    }
    assertTaskIdentityIsStable(expectedTask, nextTask);
    const privateReference = cloneAndValidatePrivateReference(
      options.privateReference,
    );
    this.assertPrivateReference(nextTask.taskId, privateReference);
    this.assertExternalReferenceAvailable(nextTask.taskId, privateReference);
    this.tasks.set(nextTask.taskId, nextTask);
    this.storePrivateReference(nextTask.taskId, privateReference);
    return cloneTask(nextTask);
  }

  recoverNonTerminal(input: {
    readonly updatedAt: string;
    readonly statusMessage: string;
  }): readonly AsyncToolTask[] {
    requireTimestamp(input.updatedAt, "updatedAt");
    if (typeof input.statusMessage !== "string") {
      throw new Error(
        "Async Tool Task recovery statusMessage must be a string",
      );
    }
    for (const [taskId, task] of this.tasks) {
      if (isAsyncToolTaskTerminalState(task.state)) {
        continue;
      }
      this.tasks.set(taskId, {
        ...task,
        state: "unknown",
        statusMessage: input.statusMessage,
        updatedAt: input.updatedAt,
      });
    }
    return this.list().filter(
      (task) => !isAsyncToolTaskTerminalState(task.state),
    );
  }

  getPrivateReference(
    taskId: HuanLinkTaskId,
  ): AsyncToolTaskPrivateReference | undefined {
    const reference = this.privateReferences.get(taskId);
    return reference === undefined
      ? undefined
      : clonePrivateReference(reference);
  }

  private assertPrivateReference(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (candidate === undefined) {
      return;
    }
    const current = this.privateReferences.get(taskId);
    if (current !== undefined && !samePrivateReference(current, candidate)) {
      throw new Error("Async Tool Task private reference conflicts");
    }
  }

  private assertExternalReferenceAvailable(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (candidate?.externalTaskId === undefined) {
      return;
    }
    const existing = this.taskIdByExternalReference.get(
      externalReferenceKey(candidate),
    );
    if (existing !== undefined && existing !== taskId) {
      throw new Error("Async Tool Task external reference conflicts");
    }
  }

  private storePrivateReference(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (candidate === undefined) {
      return;
    }
    if (!this.privateReferences.has(taskId)) {
      this.privateReferences.set(taskId, candidate);
      if (candidate.externalTaskId !== undefined) {
        this.taskIdByExternalReference.set(
          externalReferenceKey(candidate),
          taskId,
        );
      }
    }
  }
}

function sourceKey(
  sessionId: SessionId,
  sourceRunId: RunId,
  sourceToolCallId: string,
): string {
  return JSON.stringify([sessionId, sourceRunId, sourceToolCallId]);
}

function externalReferenceKey(
  reference: AsyncToolTaskPrivateReference,
): string {
  return JSON.stringify([
    reference.namespace,
    reference.agentId,
    reference.externalTaskId,
  ]);
}

function cloneAndValidateTask(task: AsyncToolTask): AsyncToolTask {
  requireNonBlank(task.taskId, "taskId");
  requireNonBlank(task.kind, "kind");
  if (!(TASK_QUOTA_POOLS as readonly string[]).includes(task.quotaPool)) {
    throw new Error("Async Tool Task quota pool is unsupported");
  }
  requireNonBlank(task.sessionId, "sessionId");
  requireNonBlank(task.sourceRunId, "sourceRunId");
  requireNonBlank(task.sourceToolCallId, "sourceToolCallId");
  requireNonBlank(task.toolName, "toolName");
  if (!isAsyncToolTaskState(task.state)) {
    throw new Error("Async Tool Task state is unsupported");
  }
  requireTimestamp(task.createdAt, "createdAt");
  requireTimestamp(task.updatedAt, "updatedAt");
  if (
    task.statusMessage !== undefined &&
    typeof task.statusMessage !== "string"
  ) {
    throw new Error("Async Tool Task statusMessage must be a string");
  }
  return {
    ...task,
    payload: clonePayload(task.payload),
  };
}

function cloneAndValidatePrivateReference(
  reference: AsyncToolTaskPrivateReference | undefined,
): AsyncToolTaskPrivateReference | undefined {
  if (reference === undefined) {
    return undefined;
  }
  requireNonBlank(
    reference.namespace,
    "Async Tool Task private reference namespace",
  );
  requireNonBlank(
    reference.agentId,
    "Async Tool Task private reference agentId",
  );
  if (reference.externalTaskId !== undefined) {
    requireNonBlank(
      reference.externalTaskId,
      "Async Tool Task private reference externalTaskId",
    );
  }
  if (reference.contextId !== undefined) {
    requireNonBlank(
      reference.contextId,
      "Async Tool Task private reference contextId",
    );
  }
  return {
    ...reference,
    ...(reference.metadata === undefined
      ? {}
      : { metadata: cloneJsonRecord(reference.metadata) }),
  };
}

function assertTaskIdentityIsStable(
  expected: AsyncToolTask,
  next: AsyncToolTask,
): void {
  if (
    expected.taskId !== next.taskId ||
    expected.kind !== next.kind ||
    expected.quotaPool !== next.quotaPool ||
    expected.sessionId !== next.sessionId ||
    expected.sourceRunId !== next.sourceRunId ||
    expected.sourceToolCallId !== next.sourceToolCallId ||
    expected.toolName !== next.toolName ||
    expected.createdAt !== next.createdAt
  ) {
    throw new Error("Async Tool Task identity cannot change");
  }
}

function sameTask(left: AsyncToolTask, right: AsyncToolTask): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function samePrivateReference(
  left: AsyncToolTaskPrivateReference,
  right: AsyncToolTaskPrivateReference,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneTask(task: AsyncToolTask): AsyncToolTask {
  return {
    ...task,
    payload: clonePayload(task.payload),
  };
}

function clonePrivateReference(
  reference: AsyncToolTaskPrivateReference,
): AsyncToolTaskPrivateReference {
  return {
    ...reference,
    ...(reference.metadata === undefined
      ? {}
      : { metadata: cloneJsonRecord(reference.metadata) }),
  };
}

function clonePayload(payload: AsyncToolTaskPayload): AsyncToolTaskPayload {
  return cloneJsonRecord(payload);
}

function cloneJsonRecord(
  value: Readonly<Record<string, AsyncToolTaskJsonValue>>,
): Readonly<Record<string, AsyncToolTaskJsonValue>> {
  return JSON.parse(canonicalJson(value)) as Readonly<
    Record<string, AsyncToolTaskJsonValue>
  >;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Async Tool Task JSON value must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("Async Tool Task value must be JSON");
  }
  if (ancestors.has(value)) {
    throw new Error("Async Tool Task value must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Async Tool Task value must contain plain objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function requireNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}
