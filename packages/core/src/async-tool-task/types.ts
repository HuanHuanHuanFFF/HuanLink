import type { HuanLinkTaskId, RunId, SessionId } from "../shared/ids.js";

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
  validatePayload(payload: unknown): AsyncToolTaskPayload;
  /** Explicitly selects the model-visible fields for this Task kind. */
  projectPublicStatus(
    input: AsyncToolTaskPublicStatusProjectionInput,
  ): AsyncToolTaskPublicStatusProjection;
};

export type AsyncToolTask = {
  readonly taskId: HuanLinkTaskId;
  readonly kind: string;
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
      readonly maxActiveTasksPerSession: number;
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

export type AsyncToolTaskTerminalListener = (task: AsyncToolTask) => void;

export type AsyncToolTaskInputRequiredListener = (task: AsyncToolTask) => void;

export type AsyncToolTaskTerminalListenerError = {
  readonly taskId: HuanLinkTaskId;
  readonly kind: string;
  readonly sessionId: SessionId;
  readonly error: unknown;
};
