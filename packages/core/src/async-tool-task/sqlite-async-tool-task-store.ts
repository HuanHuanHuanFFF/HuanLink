import type { HuanLinkTaskId, RunId, SessionId } from "../shared/ids.js";
import {
  TASK_QUOTA_POOLS,
  type TaskQuotaPool,
} from "../tasks/session-task-quota-service.js";
import {
  openSqliteDatabaseConnection,
  type SqliteDatabaseConnection,
} from "../conversations/sqlite-database-connection.js";

import {
  isAsyncToolTaskState,
  isAsyncToolTaskTerminalState,
  type AsyncToolTask,
  type AsyncToolTaskJsonValue,
  type AsyncToolTaskPayload,
} from "./types.js";
import type {
  AsyncToolTaskPrivateReference,
  AsyncToolTaskStore,
  AsyncToolTaskStoreInsertOptions,
  AsyncToolTaskStoreInsertResult,
  AsyncToolTaskStoreReplaceOptions,
} from "./async-tool-task-store.js";

type SqliteTaskRow = {
  task_id: string;
  session_id: string;
  source_run_id: string;
  source_tool_call_id: string;
  kind: string;
  quota_pool: string;
  tool_name: string;
  state: string;
  payload_json: string;
  status_message: string | null;
  created_at: string;
  updated_at: string;
};

type SqlitePrivateReferenceRow = {
  namespace: string;
  agent_id: string;
  external_task_id: string | null;
  context_id: string | null;
  metadata_json: string | null;
};

/**
 * SQLite Task Store. Direct path construction owns a test-local connection;
 * B05-B production composition uses one shared owner for both Store facades.
 */
export class SqliteAsyncToolTaskStore implements AsyncToolTaskStore {
  private readonly database: SqliteDatabaseConnection["database"];
  private readonly connection: SqliteDatabaseConnection;
  private readonly ownsConnection: boolean;

  constructor(databasePathOrConnection: string | SqliteDatabaseConnection) {
    if (typeof databasePathOrConnection === "string") {
      this.ownsConnection = true;
      this.connection = openSqliteDatabaseConnection(databasePathOrConnection);
    } else {
      this.ownsConnection = false;
      this.connection = databasePathOrConnection;
    }
    this.database = this.connection.database;
  }

  static fromSharedConnection(
    connection: SqliteDatabaseConnection,
  ): SqliteAsyncToolTaskStore {
    return new SqliteAsyncToolTaskStore(connection);
  }

  get(sessionId: SessionId, taskId: HuanLinkTaskId): AsyncToolTask | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT task_id, session_id, source_run_id, source_tool_call_id,
                kind, quota_pool, tool_name, state, payload_json, status_message,
                created_at, updated_at
           FROM async_tool_tasks
          WHERE session_id = ? AND task_id = ?`,
      )
      .get(sessionId, taskId) as SqliteTaskRow | undefined;
    return row === undefined ? undefined : parseTask(row);
  }

  getBySource(
    sessionId: SessionId,
    sourceRunId: RunId,
    sourceToolCallId: string,
  ): AsyncToolTask | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT task_id, session_id, source_run_id, source_tool_call_id,
                kind, quota_pool, tool_name, state, payload_json, status_message,
                created_at, updated_at
           FROM async_tool_tasks
          WHERE session_id = ? AND source_run_id = ? AND source_tool_call_id = ?`,
      )
      .get(sessionId, sourceRunId, sourceToolCallId) as
      | SqliteTaskRow
      | undefined;
    return row === undefined ? undefined : parseTask(row);
  }

  list(): readonly AsyncToolTask[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT task_id, session_id, source_run_id, source_tool_call_id,
                kind, quota_pool, tool_name, state, payload_json, status_message,
                created_at, updated_at
           FROM async_tool_tasks
          ORDER BY created_at ASC, task_id ASC`,
      )
      .all() as SqliteTaskRow[];
    return rows.map(parseTask);
  }

  insert(
    task: AsyncToolTask,
    options: AsyncToolTaskStoreInsertOptions = {},
  ): AsyncToolTaskStoreInsertResult {
    this.assertOpen();
    const candidate = cloneAndValidateTask(task);
    const reference = cloneAndValidatePrivateReference(
      options.privateReference,
    );
    return this.inTransaction(() => {
      const existingById = this.findTaskById(candidate.taskId);
      const existingBySource = this.findTaskBySource(
        candidate.sessionId,
        candidate.sourceRunId,
        candidate.sourceToolCallId,
      );
      if (existingById !== undefined || existingBySource !== undefined) {
        const existing = existingById ?? existingBySource;
        if (existing === undefined || !sameTask(existing, candidate)) {
          throw new Error(
            "Async Tool Task conflicts with an existing task or source",
          );
        }
        this.assertPrivateReference(existing.taskId, reference);
        return { status: "duplicate", task: existing };
      }
      this.assertExternalReferenceAvailable(candidate.taskId, reference);
      this.database
        .prepare(
          `INSERT INTO async_tool_tasks
             (task_id, session_id, source_run_id, source_tool_call_id, kind,
              quota_pool, tool_name, state, payload_json, status_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.taskId,
          candidate.sessionId,
          candidate.sourceRunId,
          candidate.sourceToolCallId,
          candidate.kind,
          candidate.quotaPool,
          candidate.toolName,
          candidate.state,
          JSON.stringify(candidate.payload),
          candidate.statusMessage ?? null,
          candidate.createdAt,
          candidate.updatedAt,
        );
      this.insertPrivateReference(candidate.taskId, reference);
      return { status: "inserted", task: candidate };
    });
  }

  replace(
    expected: AsyncToolTask,
    next: AsyncToolTask,
    options: AsyncToolTaskStoreReplaceOptions = {},
  ): AsyncToolTask {
    this.assertOpen();
    const expectedTask = cloneAndValidateTask(expected);
    const nextTask = cloneAndValidateTask(next);
    assertTaskIdentityIsStable(expectedTask, nextTask);
    const reference = cloneAndValidatePrivateReference(
      options.privateReference,
    );
    return this.inTransaction(() => {
      const current = this.findTaskById(expectedTask.taskId);
      if (current === undefined || !sameTask(current, expectedTask)) {
        throw new Error("Async Tool Task compare-and-replace conflict");
      }
      this.assertPrivateReference(nextTask.taskId, reference);
      this.assertExternalReferenceAvailable(nextTask.taskId, reference);
      const result = this.database
        .prepare(
          `UPDATE async_tool_tasks
              SET state = ?, payload_json = ?, status_message = ?, updated_at = ?
            WHERE task_id = ?`,
        )
        .run(
          nextTask.state,
          JSON.stringify(nextTask.payload),
          nextTask.statusMessage ?? null,
          nextTask.updatedAt,
          nextTask.taskId,
        );
      if (result.changes !== 1) {
        throw new Error("Async Tool Task compare-and-replace conflict");
      }
      this.insertPrivateReference(nextTask.taskId, reference);
      return nextTask;
    });
  }

  recoverNonTerminal(input: {
    readonly updatedAt: string;
    readonly statusMessage: string;
  }): readonly AsyncToolTask[] {
    this.assertOpen();
    requireTimestamp(input.updatedAt, "updatedAt");
    if (typeof input.statusMessage !== "string") {
      throw new Error(
        "Async Tool Task recovery statusMessage must be a string",
      );
    }
    return this.inTransaction(() => {
      this.database
        .prepare(
          `UPDATE async_tool_tasks
              SET state = ?, status_message = ?, updated_at = ?
            WHERE state NOT IN (?, ?, ?, ?)`,
        )
        .run(
          "unknown",
          input.statusMessage,
          input.updatedAt,
          "completed",
          "failed",
          "canceled",
          "rejected",
        );
      return this.list().filter(
        (task) => !isAsyncToolTaskTerminalState(task.state),
      );
    });
  }

  getPrivateReference(
    taskId: HuanLinkTaskId,
  ): AsyncToolTaskPrivateReference | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT namespace, agent_id, external_task_id, context_id, metadata_json
           FROM async_tool_task_private_refs
          WHERE task_id = ?`,
      )
      .get(taskId) as SqlitePrivateReferenceRow | undefined;
    return row === undefined ? undefined : parsePrivateReference(row);
  }

  /** Closes the test-local database connection. Safe to call repeatedly. */
  close(): void {
    if (this.ownsConnection) {
      this.connection.close();
    }
  }

  private findTaskById(taskId: HuanLinkTaskId): AsyncToolTask | undefined {
    const row = this.database
      .prepare(
        `SELECT task_id, session_id, source_run_id, source_tool_call_id,
                kind, quota_pool, tool_name, state, payload_json, status_message,
                created_at, updated_at
           FROM async_tool_tasks WHERE task_id = ?`,
      )
      .get(taskId) as SqliteTaskRow | undefined;
    return row === undefined ? undefined : parseTask(row);
  }

  private findTaskBySource(
    sessionId: SessionId,
    runId: RunId,
    toolCallId: string,
  ): AsyncToolTask | undefined {
    const row = this.database
      .prepare(
        `SELECT task_id, session_id, source_run_id, source_tool_call_id,
                kind, quota_pool, tool_name, state, payload_json, status_message,
                created_at, updated_at
           FROM async_tool_tasks
          WHERE session_id = ? AND source_run_id = ? AND source_tool_call_id = ?`,
      )
      .get(sessionId, runId, toolCallId) as SqliteTaskRow | undefined;
    return row === undefined ? undefined : parseTask(row);
  }

  private assertPrivateReference(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (candidate === undefined) return;
    const current = this.getPrivateReference(taskId);
    if (current !== undefined && !samePrivateReference(current, candidate)) {
      throw new Error("Async Tool Task private reference conflicts");
    }
  }

  private assertExternalReferenceAvailable(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (candidate?.externalTaskId === undefined) return;
    const row = this.database
      .prepare(
        `SELECT task_id FROM async_tool_task_private_refs
          WHERE namespace = ? AND agent_id = ? AND external_task_id = ?`,
      )
      .get(candidate.namespace, candidate.agentId, candidate.externalTaskId) as
      | { task_id: string }
      | undefined;
    if (row !== undefined && row.task_id !== taskId) {
      throw new Error("Async Tool Task external reference conflicts");
    }
  }

  private insertPrivateReference(
    taskId: HuanLinkTaskId,
    candidate: AsyncToolTaskPrivateReference | undefined,
  ): void {
    if (
      candidate === undefined ||
      this.getPrivateReference(taskId) !== undefined
    ) {
      return;
    }
    this.database
      .prepare(
        `INSERT INTO async_tool_task_private_refs
           (task_id, namespace, agent_id, external_task_id, context_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        candidate.namespace,
        candidate.agentId,
        candidate.externalTaskId ?? null,
        candidate.contextId ?? null,
        candidate.metadata === undefined
          ? null
          : JSON.stringify(candidate.metadata),
      );
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertOpen(): void {
    this.connection.assertOpen("SQLite Async Tool Task Store is closed");
  }
}

function parseTask(row: SqliteTaskRow): AsyncToolTask {
  const payload = parseJsonRecord(row.payload_json, "Async Tool Task payload");
  return cloneAndValidateTask({
    taskId: row.task_id,
    sessionId: row.session_id,
    sourceRunId: row.source_run_id,
    sourceToolCallId: row.source_tool_call_id,
    kind: row.kind,
    quotaPool: parseQuotaPool(row.quota_pool),
    toolName: row.tool_name,
    state: parseTaskState(row.state),
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.status_message === null
      ? {}
      : { statusMessage: row.status_message }),
  });
}

function parseTaskState(value: string): AsyncToolTask["state"] {
  if (!isAsyncToolTaskState(value)) {
    throw new Error("Async Tool Task state is unsupported");
  }
  return value;
}

function parseQuotaPool(value: string): TaskQuotaPool {
  if (!(TASK_QUOTA_POOLS as readonly string[]).includes(value)) {
    throw new Error("Async Tool Task quota pool is unsupported");
  }
  return value as TaskQuotaPool;
}

function parsePrivateReference(
  row: SqlitePrivateReferenceRow,
): AsyncToolTaskPrivateReference {
  return cloneAndValidatePrivateReference({
    namespace: row.namespace,
    agentId: row.agent_id,
    ...(row.external_task_id === null
      ? {}
      : { externalTaskId: row.external_task_id }),
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    ...(row.metadata_json === null
      ? {}
      : {
          metadata: parseJsonRecord(
            row.metadata_json,
            "Async Tool Task metadata",
          ),
        }),
  })!;
}

function cloneAndValidateTask(task: AsyncToolTask): AsyncToolTask {
  requireNonBlank(task.taskId, "taskId");
  requireNonBlank(task.kind, "kind");
  parseQuotaPool(task.quotaPool);
  requireNonBlank(task.sessionId, "sessionId");
  requireNonBlank(task.sourceRunId, "sourceRunId");
  requireNonBlank(task.sourceToolCallId, "sourceToolCallId");
  requireNonBlank(task.toolName, "toolName");
  if (!isAsyncToolTaskState(task.state))
    throw new Error("Async Tool Task state is unsupported");
  requireTimestamp(task.createdAt, "createdAt");
  requireTimestamp(task.updatedAt, "updatedAt");
  if (
    task.statusMessage !== undefined &&
    typeof task.statusMessage !== "string"
  ) {
    throw new Error("Async Tool Task statusMessage must be a string");
  }
  return { ...task, payload: cloneJsonRecord(task.payload) };
}

function cloneAndValidatePrivateReference(
  reference: AsyncToolTaskPrivateReference | undefined,
): AsyncToolTaskPrivateReference | undefined {
  if (reference === undefined) return undefined;
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

function sameTask(left: AsyncToolTask, right: AsyncToolTask): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function samePrivateReference(
  left: AsyncToolTaskPrivateReference,
  right: AsyncToolTaskPrivateReference,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function parseJsonRecord(
  raw: string,
  label: string,
): Readonly<Record<string, AsyncToolTaskJsonValue>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error();
    }
    return cloneJsonRecord(parsed as Record<string, AsyncToolTaskJsonValue>);
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
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
    if (!Number.isFinite(value))
      throw new Error("Async Tool Task JSON value must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object")
    throw new Error("Async Tool Task value must be JSON");
  if (ancestors.has(value))
    throw new Error("Async Tool Task value must not contain cycles");
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
