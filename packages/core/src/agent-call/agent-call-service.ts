import { randomUUID } from "node:crypto";

import type { AgentCallId, RunId } from "../shared/ids.js";
import {
  isAgentCallOutcomeState,
  isAgentCallTerminalState,
  type AgentCallInvocationResult,
  type AgentCallInvoker,
  type AgentCallRecord,
  type AgentCallBackgroundErrorListener,
  type AgentCallReceipt,
  type AgentCallReader,
  type AgentCallRequest,
  type AgentCallSubmitter,
  type AgentCallTaskSnapshot,
  type AgentCallTerminalListener,
  type AgentCallTransport
} from "./types.js";

export type AgentCallServiceOptions = {
  transport: AgentCallTransport;
  createId?: () => AgentCallId;
  now?: () => Date;
};

type ActiveWatcher = {
  controller: AbortController;
  promise: Promise<void>;
};

type AgentCallOutcomeWaiter = (record: AgentCallRecord) => void;

export class AgentCallService
  implements AgentCallSubmitter, AgentCallInvoker, AgentCallReader
{
  private readonly transport: AgentCallTransport;
  private readonly createId: () => AgentCallId;
  private readonly now: () => Date;
  private readonly recordsByAgentCallId = new Map<AgentCallId, AgentCallRecord>();
  private readonly agentCallIdByTaskId = new Map<string, AgentCallId>();
  private readonly terminalHandled = new Set<AgentCallId>();
  private readonly terminalListeners = new Set<AgentCallTerminalListener>();
  private readonly backgroundErrorListeners =
    new Set<AgentCallBackgroundErrorListener>();
  private readonly activeSubmissions = new Set<Promise<AgentCallReceipt>>();
  private readonly activeWatchers = new Map<AgentCallId, ActiveWatcher>();
  private readonly activeCancellations = new Set<Promise<AgentCallRecord>>();
  private readonly outcomeWaiters = new Map<
    AgentCallId,
    Set<AgentCallOutcomeWaiter>
  >();
  private closed = false;

  constructor(options: AgentCallServiceOptions) {
    this.transport = options.transport;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult> {
    const receipt = await this.submit(request);
    if (request.executionMode === "async") {
      return receipt;
    }

    let record: AgentCallRecord;
    try {
      record = await this.waitForOutcome(receipt.agentCallId, request.signal);
    } catch (error) {
      if (request.signal?.aborted) {
        this.activeWatchers.get(receipt.agentCallId)?.controller.abort();
        this.cancelAfterAbortedWait(receipt.agentCallId);
      }
      throw error;
    }
    return {
      status: "result",
      executionMode: "blocking",
      agentCallId: record.agentCallId,
      taskId: record.taskId,
      state: record.state,
      artifacts: record.artifacts,
      ...(record.statusMessage === undefined
        ? {}
        : { statusMessage: record.statusMessage })
    };
  }

  submit(request: AgentCallRequest): Promise<AgentCallReceipt> {
    this.assertOpen();

    const operation = this.performSubmit(request);
    this.activeSubmissions.add(operation);
    void operation.then(
      () => this.activeSubmissions.delete(operation),
      () => this.activeSubmissions.delete(operation)
    );
    return operation;
  }

  private async performSubmit(
    request: AgentCallRequest
  ): Promise<AgentCallReceipt> {
    const agentCallId = this.createId();
    const capability = await this.transport.discoverCapability(
      request.skillId,
      { signal: request.signal }
    );
    if (this.closed) {
      throw new Error("AgentCallService closed during submission");
    }
    const submitted = await this.transport.submitTask({
      messageId: agentCallId,
      skillId: capability.id,
      input: request.input,
      ...(request.contextId === undefined
        ? {}
        : { contextId: request.contextId }),
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });

    if (this.closed) {
      try {
        await this.transport.cancelTask(submitted.taskId);
      } catch (error) {
        this.reportBackgroundError(
          new Error(
            `Failed to cancel remote task ${submitted.taskId} accepted during shutdown`,
            { cause: error }
          )
        );
      }
      throw new Error("AgentCallService closed during submission");
    }

    if (this.agentCallIdByTaskId.has(submitted.taskId)) {
      throw new Error(`Remote task ${submitted.taskId} is already tracked`);
    }

    const timestamp = this.now().toISOString();
    const record: AgentCallRecord = {
      agentCallId,
      taskId: submitted.taskId,
      ...(submitted.contextId === undefined
        ? {}
        : { contextId: submitted.contextId }),
      runId: request.runId,
      sessionId: request.sessionId,
      skillId: capability.id,
      capabilityName: capability.name,
      input: request.input,
      executionMode: request.executionMode,
      state: submitted.state,
      artifacts: cloneArtifacts(submitted.artifacts),
      ...(submitted.statusMessage === undefined
        ? {}
        : { statusMessage: submitted.statusMessage }),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.recordsByAgentCallId.set(agentCallId, record);
    this.agentCallIdByTaskId.set(submitted.taskId, agentCallId);
    this.startWatcher(agentCallId, submitted);

    return {
      status: "accepted",
      executionMode: request.executionMode,
      agentCallId,
      taskId: submitted.taskId,
      state: submitted.state
    };
  }

  getByAgentCallId(agentCallId: AgentCallId): AgentCallRecord | undefined {
    return cloneRecord(this.recordsByAgentCallId.get(agentCallId));
  }

  getByTaskId(taskId: string): AgentCallRecord | undefined {
    const agentCallId = this.agentCallIdByTaskId.get(taskId);
    return agentCallId === undefined
      ? undefined
      : this.getByAgentCallId(agentCallId);
  }

  listByRunId(runId: RunId): AgentCallRecord[] {
    return [...this.recordsByAgentCallId.values()]
      .filter((record) => record.runId === runId)
      .map((record) => cloneRecord(record)!);
  }

  async waitForOutcome(
    agentCallId: AgentCallId,
    signal?: AbortSignal
  ): Promise<AgentCallRecord> {
    const current = this.requireRecord(agentCallId);
    if (isAgentCallOutcomeState(current.state)) {
      return this.requireRecordClone(agentCallId);
    }

    const watcher = this.activeWatchers.get(agentCallId);
    if (!watcher) {
      throw new Error(`AgentCall ${agentCallId} has no active watcher`);
    }

    let resolveOutcome!: (record: AgentCallRecord) => void;
    const outcomePromise = new Promise<AgentCallRecord>((resolve) => {
      resolveOutcome = resolve;
    });
    const waiter: AgentCallOutcomeWaiter = (record) => {
      resolveOutcome(cloneRecord(record)!);
    };
    const waiters = this.outcomeWaiters.get(agentCallId) ?? new Set();
    waiters.add(waiter);
    this.outcomeWaiters.set(agentCallId, waiters);

    try {
      const latest = this.requireRecord(agentCallId);
      if (isAgentCallOutcomeState(latest.state)) {
        return this.requireRecordClone(agentCallId);
      }

      return await waitWithSignal(
        Promise.race([
          outcomePromise,
          watcher.promise.then(() => {
            const outcome = this.requireRecord(agentCallId);
            if (!isAgentCallOutcomeState(outcome.state)) {
              throw new Error(
                `AgentCall ${agentCallId} stopped before an outcome`
              );
            }
            return this.requireRecordClone(agentCallId);
          })
        ]),
        signal
      );
    } finally {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        this.outcomeWaiters.delete(agentCallId);
      }
    }
  }

  onTerminal(listener: AgentCallTerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  onBackgroundError(listener: AgentCallBackgroundErrorListener): () => void {
    this.backgroundErrorListeners.add(listener);
    return () => this.backgroundErrorListeners.delete(listener);
  }

  async cancel(agentCallId: AgentCallId): Promise<AgentCallRecord> {
    const record = this.requireRecord(agentCallId);
    const canceled = await this.transport.cancelTask(record.taskId);
    this.assertMatchingTask(record, canceled);
    try {
      await this.applySnapshot(agentCallId, canceled);
    } catch (error) {
      this.reportBackgroundError(error, agentCallId);
    }
    return this.requireRecordClone(agentCallId);
  }

  async waitForIdle(): Promise<void> {
    while (this.activeWatchers.size > 0) {
      await Promise.all(
        [...this.activeWatchers.values()].map((watcher) => watcher.promise)
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.allSettled([...this.activeSubmissions]);
    for (const watcher of this.activeWatchers.values()) {
      watcher.controller.abort();
    }
    await Promise.allSettled([...this.activeCancellations]);
    await this.waitForIdle();
  }

  private cancelAfterAbortedWait(agentCallId: AgentCallId): void {
    const operation = this.cancel(agentCallId);
    this.activeCancellations.add(operation);
    void operation.then(
      () => this.activeCancellations.delete(operation),
      (cancelError) => {
        this.activeCancellations.delete(operation);
        this.reportBackgroundError(
          new Error(
            `Failed to cancel AgentCall ${agentCallId} after its wait was aborted`,
            { cause: cancelError }
          ),
          agentCallId
        );
      }
    );
  }

  private startWatcher(
    agentCallId: AgentCallId,
    initial: AgentCallTaskSnapshot
  ): void {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        try {
          const initialIsConsumedOutcome =
            isAgentCallOutcomeState(initial.state) &&
            this.requireRecord(agentCallId).executionMode === "blocking";
          if (
            isAgentCallTerminalState(initial.state) ||
            initialIsConsumedOutcome
          ) {
            await this.applySnapshot(agentCallId, initial);
            return;
          }

          let sawTerminal = false;
          for await (const snapshot of this.transport.watchTask(initial.taskId, {
            signal: controller.signal
          })) {
            this.assertMatchingTask(this.requireRecord(agentCallId), snapshot);
            await this.applySnapshot(agentCallId, snapshot);
            if (isAgentCallTerminalState(snapshot.state)) {
              sawTerminal = true;
              break;
            }
          }

          const finalState = this.requireRecord(agentCallId).state;
          const isPaused =
            finalState === "input-required" || finalState === "auth-required";
          if (
            !sawTerminal &&
            !isPaused &&
            !this.closed &&
            !controller.signal.aborted
          ) {
            throw new Error(
              "Remote task subscription ended before a terminal state"
            );
          }
        } catch (error) {
          if (this.terminalHandled.has(agentCallId)) {
            this.reportBackgroundError(error, agentCallId);
            return;
          }
          if (
            !this.closed &&
            !controller.signal.aborted &&
            !this.terminalHandled.has(agentCallId)
          ) {
            try {
              await this.applySnapshot(agentCallId, {
                taskId: initial.taskId,
                contextId: initial.contextId,
                state: "failed",
                artifacts: this.requireRecord(agentCallId).artifacts,
                statusMessage: errorMessage(error)
              });
            } catch (notificationError) {
              this.reportBackgroundError(notificationError, agentCallId);
            }
          }
        }
      });

    this.activeWatchers.set(agentCallId, { controller, promise });
    void promise.then(
      () => this.activeWatchers.delete(agentCallId),
      () => this.activeWatchers.delete(agentCallId)
    );
  }

  private async applySnapshot(
    agentCallId: AgentCallId,
    snapshot: AgentCallTaskSnapshot
  ): Promise<void> {
    if (this.terminalHandled.has(agentCallId)) {
      return;
    }

    const current = this.requireRecord(agentCallId);
    const updated: AgentCallRecord = {
      ...current,
      ...(snapshot.contextId === undefined
        ? {}
        : { contextId: snapshot.contextId }),
      state: snapshot.state,
      artifacts: cloneArtifacts(snapshot.artifacts),
      ...(snapshot.statusMessage === undefined
        ? { statusMessage: current.statusMessage }
        : { statusMessage: snapshot.statusMessage }),
      updatedAt: this.now().toISOString()
    };
    this.recordsByAgentCallId.set(agentCallId, updated);

    if (isAgentCallOutcomeState(snapshot.state)) {
      for (const waiter of this.outcomeWaiters.get(agentCallId) ?? []) {
        waiter(updated);
      }
      if (updated.executionMode === "blocking") {
        this.activeWatchers.get(agentCallId)?.controller.abort();
      }
    }

    if (!isAgentCallTerminalState(snapshot.state)) {
      return;
    }

    this.terminalHandled.add(agentCallId);
    if (updated.executionMode === "blocking") {
      return;
    }
    this.activeWatchers.get(agentCallId)?.controller.abort();
    const results = await Promise.allSettled(
      [...this.terminalListeners].map((listener) =>
        Promise.resolve().then(() => listener(cloneRecord(updated)!))
      )
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : []
    );
    if (failures.length > 0) {
      const terminalNotificationError = failures.join("; ");
      this.recordsByAgentCallId.set(agentCallId, {
        ...updated,
        terminalNotificationError
      });
      throw new Error(terminalNotificationError);
    }
  }

  private assertMatchingTask(
    record: AgentCallRecord,
    snapshot: AgentCallTaskSnapshot
  ): void {
    if (record.taskId !== snapshot.taskId) {
      throw new Error(
        `Remote update task ${snapshot.taskId} does not match ${record.taskId}`
      );
    }
  }

  private requireRecord(agentCallId: AgentCallId): AgentCallRecord {
    const record = this.recordsByAgentCallId.get(agentCallId);
    if (!record) {
      throw new Error(`Unknown AgentCall ${agentCallId}`);
    }
    return record;
  }

  private requireRecordClone(agentCallId: AgentCallId): AgentCallRecord {
    return cloneRecord(this.requireRecord(agentCallId))!;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("AgentCallService is closed");
    }
  }

  private reportBackgroundError(
    error: unknown,
    agentCallId?: AgentCallId
  ): void {
    const normalized =
      error instanceof Error ? error : new Error(errorMessage(error));
    const record =
      agentCallId === undefined
        ? undefined
        : this.getByAgentCallId(agentCallId);
    for (const listener of this.backgroundErrorListeners) {
      try {
        void Promise.resolve(listener(normalized, record)).catch(() => undefined);
      } catch {
        // Error observers must not create another unhandled background failure.
      }
    }
  }
}

function cloneArtifacts(
  artifacts: readonly AgentCallRecord["artifacts"][number][]
): AgentCallRecord["artifacts"] {
  return artifacts.map((artifact) => ({ ...artifact }));
}

function cloneRecord(
  record: AgentCallRecord | undefined
): AgentCallRecord | undefined {
  return record === undefined
    ? undefined
    : { ...record, artifacts: cloneArtifacts(record.artifacts) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("AgentCall wait aborted");
}
