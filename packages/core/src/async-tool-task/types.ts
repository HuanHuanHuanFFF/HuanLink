import type { HuanLinkTaskId, RunId, SessionId } from "../shared/ids.js";
import type {
  SessionTaskQuotaLease,
  TaskQuotaPool,
} from "../tasks/session-task-quota-service.js";
import type { AsyncToolTaskPrivateReference } from "./async-tool-task-store.js";

export const ASYNC_TOOL_TASK_STATES = [
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

export type AsyncToolTaskState = (typeof ASYNC_TOOL_TASK_STATES)[number];

export const ASYNC_TOOL_TASK_TERMINAL_STATES = [
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const satisfies readonly AsyncToolTaskState[];

const terminalStates = new Set<AsyncToolTaskState>(
  ASYNC_TOOL_TASK_TERMINAL_STATES,
);
const taskStates = new Set<AsyncToolTaskState>(ASYNC_TOOL_TASK_STATES);

export function isAsyncToolTaskState(
  value: unknown,
): value is AsyncToolTaskState {
  return (
    typeof value === "string" && taskStates.has(value as AsyncToolTaskState)
  );
}

export function isAsyncToolTaskTerminalState(
  state: AsyncToolTaskState,
): boolean {
  return terminalStates.has(state);
}

export type AsyncToolTaskJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AsyncToolTaskJsonValue[]
  | { readonly [key: string]: AsyncToolTaskJsonValue };

export type AsyncToolTaskPayload = Readonly<
  Record<string, AsyncToolTaskJsonValue>
>;

export type AsyncToolTaskPublicStatusProjectionInput = {
  readonly state: AsyncToolTaskState;
  readonly payload: AsyncToolTaskPayload;
  readonly statusMessage?: string;
};

export type AsyncToolTaskPublicStatusProjection = {
  readonly payload: AsyncToolTaskPayload;
  readonly statusMessage?: string;
};

export type AsyncToolTaskKindDefinition = {
  readonly kind: string;
  /** Selects the independent per-Session quota pool used by this Task kind. */
  readonly quotaPool: TaskQuotaPool;
  validatePayload(payload: unknown): AsyncToolTaskPayload;
  /** Explicitly selects the model-visible fields for this Task kind. */
  projectPublicStatus(
    input: AsyncToolTaskPublicStatusProjectionInput,
  ): AsyncToolTaskPublicStatusProjection;
};

export type AsyncToolTask = {
  readonly taskId: HuanLinkTaskId;
  readonly kind: string;
  /** Persisted admission ownership; a registered kind may never silently change it. */
  readonly quotaPool: TaskQuotaPool;
  readonly sessionId: SessionId;
  readonly sourceRunId: RunId;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly state: AsyncToolTaskState;
  readonly payload: AsyncToolTaskPayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusMessage?: string;
};

export type AsyncToolTaskReserveRequest = {
  readonly sessionId: SessionId;
  readonly sourceRunId: RunId;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly kind: string;
  readonly payload: unknown;
};

export type AsyncToolTaskReserveResult =
  | {
      readonly status: "reserved" | "duplicate";
      readonly task: AsyncToolTask;
    }
  | {
      readonly status: "limit-reached";
      readonly quotaPool: TaskQuotaPool;
      readonly maxActiveTasksPerSession: number;
    };

export type AsyncToolTaskAdoptAcceptedRequest = {
  readonly taskId: HuanLinkTaskId;
  readonly sessionId: SessionId;
  readonly sourceRunId: RunId;
  readonly sourceToolCallId: string;
  readonly toolName: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: "unknown";
  readonly quotaLease: SessionTaskQuotaLease;
  readonly statusMessage?: string;
  readonly privateReference?: AsyncToolTaskPrivateReference;
};

export type AsyncToolTaskAdoptAcceptedResult = {
  readonly status: "adopted" | "duplicate";
  readonly task: AsyncToolTask;
};

/** Safe task view for a same-Session status query. */
export type AsyncToolTaskStatus = {
  readonly status: "found";
  readonly taskId: HuanLinkTaskId;
  readonly kind: string;
  readonly toolName: string;
  readonly state: AsyncToolTaskState;
  readonly payload: AsyncToolTaskPayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusMessage?: string;
};

export type AsyncToolTaskStatusQueryResult =
  | AsyncToolTaskStatus
  | {
      readonly status: "not-found";
      readonly taskId: HuanLinkTaskId;
    };

export interface AsyncToolTaskStatusReader {
  getStatus(
    sessionId: SessionId,
    taskId: HuanLinkTaskId,
  ): AsyncToolTaskStatusQueryResult;
}

export type AsyncToolTaskAcceptedUpdate = {
  readonly state: Exclude<AsyncToolTaskState, "submitting">;
  readonly payload?: unknown;
  readonly statusMessage?: string;
};

export type AsyncToolTaskMutationOptions = {
  readonly privateReference?: AsyncToolTaskPrivateReference;
};

export type AsyncToolTaskRetainPersistenceUncertainRequest = Omit<
  AsyncToolTaskAdoptAcceptedRequest,
  "quotaLease"
> & {
  /** Last Task fact already known by the caller when the Store is unreadable. */
  readonly knownTask?: AsyncToolTask;
  /** Required when no durable submitting Task already owns the quota slot. */
  readonly quotaLease?: SessionTaskQuotaLease;
};

export type AsyncToolTaskTerminalListener = (task: AsyncToolTask) => void;

export type AsyncToolTaskInputRequiredListener = (task: AsyncToolTask) => void;

export type AsyncToolTaskTerminalListenerError = {
  readonly taskId: HuanLinkTaskId;
  readonly kind: string;
  readonly sessionId: SessionId;
  readonly error: unknown;
};
