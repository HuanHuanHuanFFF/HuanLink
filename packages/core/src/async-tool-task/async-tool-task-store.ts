import type { HuanLinkTaskId, RunId, SessionId } from "../shared/ids.js";

import type { AsyncToolTask, AsyncToolTaskJsonValue } from "./types.js";

/**
 * Private provider reference for later reconciliation. It is never part of an
 * AsyncToolTask public status projection or a model-visible Tool result.
 */
export type AsyncToolTaskPrivateReference = {
  readonly namespace: string;
  readonly agentId: string;
  readonly externalTaskId?: string;
  readonly contextId?: string;
  readonly metadata?: Readonly<Record<string, AsyncToolTaskJsonValue>>;
};

export type AsyncToolTaskStoreInsertOptions = {
  readonly privateReference?: AsyncToolTaskPrivateReference;
};

export type AsyncToolTaskStoreReplaceOptions = AsyncToolTaskStoreInsertOptions;

export type AsyncToolTaskStoreInsertResult = {
  readonly status: "inserted" | "duplicate";
  readonly task: AsyncToolTask;
};

/**
 * Sync persistence boundary for Task facts. Implementations own copying,
 * uniqueness checks, and the atomicity of a Task update plus its private ref.
 */
export interface AsyncToolTaskStore {
  get(sessionId: SessionId, taskId: HuanLinkTaskId): AsyncToolTask | undefined;
  getBySource(
    sessionId: SessionId,
    sourceRunId: RunId,
    sourceToolCallId: string,
  ): AsyncToolTask | undefined;
  list(): readonly AsyncToolTask[];
  insert(
    task: AsyncToolTask,
    options?: AsyncToolTaskStoreInsertOptions,
  ): AsyncToolTaskStoreInsertResult;
  replace(
    expected: AsyncToolTask,
    next: AsyncToolTask,
    options?: AsyncToolTaskStoreReplaceOptions,
  ): AsyncToolTask;
  recoverNonTerminal(input: {
    readonly updatedAt: string;
    readonly statusMessage: string;
  }): readonly AsyncToolTask[];
  getPrivateReference(
    taskId: HuanLinkTaskId,
  ): AsyncToolTaskPrivateReference | undefined;
}
