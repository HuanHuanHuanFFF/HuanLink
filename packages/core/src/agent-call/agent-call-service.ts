import { randomUUID } from "node:crypto";

import { NoopRuntimeLogger } from "../logging/noop-runtime-logger.js";
import { AsyncToolTaskService } from "../async-tool-task/async-tool-task-service.js";
import type {
  RuntimeLogFields,
  RuntimeLogLevel,
  RuntimeLogger,
} from "../logging/types.js";
import type { AgentCallId, RunId } from "../shared/ids.js";
import {
  isAgentCallOutcomeState,
  isAgentCallTerminalState,
  AGENT_CALL_TASK_KIND,
  type AgentCallAsyncInvocationResult,
  type AgentCallAsyncRequest,
  type AgentCallBackgroundErrorListener,
  type AgentCallContinuator,
  type AgentCallContinueRequest,
  type AgentCallContinueResult,
  type AgentCallInvocationResult,
  type AgentCallInputAnswers,
  type AgentCallInvoker,
  type AgentCallRecord,
  type AgentCallReader,
  type AgentCallRequest,
  type AgentCallSubmitter,
  type AgentCallTaskSnapshot,
  type AgentCallTransport,
} from "./types.js";

export type AgentCallServiceOptions = {
  transport: AgentCallTransport;
  taskService: AsyncToolTaskService;
  createId?: () => AgentCallId;
  createMessageId?: () => string;
  logger?: RuntimeLogger;
  now?: () => Date;
};

type ActiveWatcher = {
  controller: AbortController;
  promise: Promise<void>;
};

type ActiveContinuation = {
  controller: AbortController;
  promise: Promise<AgentCallRecord>;
};

type AgentCallOutcomeWaiter = (record: AgentCallRecord) => void;

type AgentCallSubmission = {
  agentCallId: AgentCallId;
  a2aTaskId: string;
  state: AgentCallRecord["state"];
};

class AgentCallPreacceptFailure extends Error {
  constructor(readonly originalError: unknown) {
    super("AgentCall transport failed before remote acceptance", {
      cause: originalError,
    });
  }
}

export class AgentCallService
  implements
    AgentCallSubmitter,
    AgentCallInvoker,
    AgentCallReader,
    AgentCallContinuator
{
  private readonly transport: AgentCallTransport;
  private readonly taskService: AsyncToolTaskService;
  private readonly createId: () => AgentCallId;
  private readonly createMessageId: () => string;
  private readonly logger: RuntimeLogger;
  private readonly now: () => Date;
  private readonly recordsByAgentCallId = new Map<
    AgentCallId,
    AgentCallRecord
  >();
  private readonly agentCallIdByTaskId = new Map<string, AgentCallId>();
  private readonly terminalHandled = new Set<AgentCallId>();
  private readonly inputRequiredHandled = new Set<AgentCallId>();
  private readonly backgroundErrorListeners =
    new Set<AgentCallBackgroundErrorListener>();
  private readonly activeSubmissions = new Set<Promise<unknown>>();
  private readonly activeWatchers = new Map<AgentCallId, ActiveWatcher>();
  private readonly activeContinuationByTaskId = new Map<
    string,
    ActiveContinuation
  >();
  private readonly activeCancellationByTaskId = new Map<
    string,
    Promise<AgentCallRecord>
  >();
  private readonly activeCancellations = new Set<Promise<AgentCallRecord>>();
  private readonly outcomeWaiters = new Map<
    AgentCallId,
    Set<AgentCallOutcomeWaiter>
  >();
  private closed = false;
  private closeOperation?: Promise<void>;

  constructor(options: AgentCallServiceOptions) {
    this.transport = options.transport;
    this.taskService = options.taskService;
    this.createId = options.createId ?? randomUUID;
    this.createMessageId = options.createMessageId ?? randomUUID;
    this.logger = options.logger ?? new NoopRuntimeLogger();
    this.now = options.now ?? (() => new Date());
  }

  async invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult> {
    if (request.executionMode === "async") {
      return this.submit(request);
    }

    this.assertOpen();
    let submission: AgentCallSubmission;
    try {
      submission = await this.trackSubmission(
        this.performSubmit(request, this.createId()),
      );
    } catch (error) {
      if (error instanceof AgentCallPreacceptFailure) {
        throw error.originalError;
      }
      throw error;
    }

    let record: AgentCallRecord;
    try {
      record = await this.waitForOutcome(
        submission.agentCallId,
        request.signal,
      );
    } catch (error) {
      if (request.signal?.aborted) {
        this.activeWatchers.get(submission.agentCallId)?.controller.abort();
        this.cancelAfterAbortedWait(submission.agentCallId);
      }
      throw error;
    }
    if (record.state === "input-required" || record.state === "auth-required") {
      await this.interruptBlocking(record);
      return {
        status: "blocking-interrupted",
        executionMode: "blocking",
        state: record.state,
        ...(record.questions === undefined
          ? {}
          : { questions: cloneQuestions(record.questions) }),
        ...(record.statusMessage === undefined
          ? {}
          : { statusMessage: record.statusMessage }),
      };
    }
    if (!isAgentCallTerminalState(record.state)) {
      throw new Error(
        `Blocking AgentCall ${record.agentCallId} stopped in unexpected state ${record.state}`,
      );
    }
    return {
      status: "result",
      executionMode: "blocking",
      state: record.state,
      artifacts: record.artifacts,
      ...(record.statusMessage === undefined
        ? {}
        : { statusMessage: record.statusMessage }),
    };
  }

  submit(
    request: AgentCallAsyncRequest,
  ): Promise<AgentCallAsyncInvocationResult> {
    this.assertOpen();
    const reservation = this.taskService.reserve({
      sessionId: request.sessionId,
      sourceRunId: request.runId,
      sourceToolCallId: request.sourceToolCallId,
      toolName: request.toolName,
      kind: AGENT_CALL_TASK_KIND,
      payload: { artifacts: [] },
    });
    if (reservation.status === "limit-reached") {
      return Promise.resolve({
        status: "error",
        error: "task-limit-reached",
        maxActiveTasksPerSession: reservation.maxActiveTasksPerSession,
      });
    }
    if (reservation.status === "duplicate") {
      if (reservation.task.state === "submitting") {
        return Promise.reject(
          new Error(
            `AgentCall Task ${reservation.task.taskId} is still submitting`,
          ),
        );
      }
      if (reservation.task.state === "rejected") {
        return Promise.resolve({
          status: "error",
          error: "task-preaccept-rejected",
        });
      }
      return Promise.resolve({
        status: "accepted",
        taskId: reservation.task.taskId,
        state: reservation.task.state,
      });
    }

    const operation = this.performAsyncSubmit(request, reservation.task.taskId);
    return this.trackSubmission(operation);
  }

  private async performAsyncSubmit(
    request: AgentCallAsyncRequest,
    agentCallId: AgentCallId,
  ): Promise<AgentCallAsyncInvocationResult> {
    try {
      const submission = await this.performSubmit(request, agentCallId, () => {
        const record = this.requireRecord(agentCallId);
        this.taskService.accept(request.sessionId, agentCallId, {
          state: record.state,
          payload: agentCallTaskPayload(record),
          ...(record.statusMessage === undefined
            ? {}
            : { statusMessage: record.statusMessage }),
        });
      });
      return {
        status: "accepted",
        taskId: submission.agentCallId,
        state: submission.state,
      };
    } catch (error) {
      let task = this.taskService.get(request.sessionId, agentCallId);
      if (error instanceof AgentCallPreacceptFailure) {
        if (task?.state !== "submitting") {
          throw error.originalError;
        }
        this.taskService.rejectBeforeAcceptance(
          request.sessionId,
          agentCallId,
          errorMessage(error.originalError),
        );
        return {
          status: "error",
          error: "task-preaccept-rejected",
        };
      }
      if (task?.state === "submitting") {
        task = this.taskService.accept(request.sessionId, agentCallId, {
          state: "unknown",
          payload: { artifacts: [] },
        });
      }
      if (
        task === undefined ||
        task.state === "submitting" ||
        task.state === "rejected"
      ) {
        throw error;
      }
      this.reportBackgroundError(error, agentCallId);
      return {
        status: "accepted",
        taskId: agentCallId,
        state: task.state,
      };
    }
  }

  private trackSubmission<T>(operation: Promise<T>): Promise<T> {
    this.activeSubmissions.add(operation);
    void operation.then(
      () => this.activeSubmissions.delete(operation),
      () => this.activeSubmissions.delete(operation),
    );
    return operation;
  }

  private async interruptBlocking(record: AgentCallRecord): Promise<void> {
    try {
      await this.cancel(record.agentCallId);
    } catch (error) {
      this.reportBackgroundError(
        new Error("Failed to cancel an interrupted blocking AgentCall", {
          cause: error,
        }),
        record.agentCallId,
      );
    }
  }

  private async performSubmit(
    request: AgentCallRequest,
    agentCallId: AgentCallId,
    beforeWatcher?: () => void,
  ): Promise<AgentCallSubmission> {
    let remoteAccepted = false;
    const startedFields: RuntimeLogFields = {
      sessionId: request.sessionId,
      runId: request.runId,
      agentCallId,
      skillId: request.skillId,
      executionMode: request.executionMode,
      inputLength: request.input.length,
      ...(request.contextId === undefined
        ? {}
        : { contextId: request.contextId }),
      ...(request.sourceToolCallId === undefined
        ? {}
        : { sourceToolCallId: request.sourceToolCallId }),
    };
    this.writeLog("info", "agent_call.submit.started", startedFields);
    this.writeLog("debug", "agent_call.submit.started", startedFields);
    try {
      const capability = await this.transport.discoverCapability(
        request.skillId,
        { signal: request.signal },
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
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      remoteAccepted = true;

      if (this.closed) {
        try {
          await this.transport.cancelTask(submitted.taskId);
        } catch (error) {
          this.reportBackgroundError(
            new Error(
              `Failed to cancel remote task ${submitted.taskId} accepted during shutdown`,
              { cause: error },
            ),
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
        ...(request.sourceToolCallId === undefined
          ? {}
          : { sourceToolCallId: request.sourceToolCallId }),
        state: submitted.state,
        artifacts: cloneArtifacts(submitted.artifacts),
        ...(submitted.questions === undefined
          ? {}
          : { questions: cloneQuestions(submitted.questions) }),
        ...(submitted.statusMessage === undefined
          ? {}
          : { statusMessage: submitted.statusMessage }),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      this.recordsByAgentCallId.set(agentCallId, record);
      this.agentCallIdByTaskId.set(submitted.taskId, agentCallId);
      const acceptedFields = {
        ...agentCallLogFields(record),
        ...snapshotCountFields(submitted),
      };
      this.writeLog("info", "agent_call.submit.accepted", acceptedFields);
      this.writeLog("debug", "agent_call.submit.accepted", acceptedFields);
      this.startWatcher(agentCallId, submitted);
      beforeWatcher?.();

      return {
        agentCallId,
        a2aTaskId: submitted.taskId,
        state: submitted.state,
      };
    } catch (error) {
      const failedFields = { ...startedFields, ...errorLogFields(error) };
      this.writeLog("error", "agent_call.submit.failed", failedFields);
      this.writeLog("debug", "agent_call.submit.failed", failedFields);
      if (!remoteAccepted) {
        throw new AgentCallPreacceptFailure(error);
      }
      throw error;
    }
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
    signal?: AbortSignal,
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
                `AgentCall ${agentCallId} stopped before an outcome`,
              );
            }
            return this.requireRecordClone(agentCallId);
          }),
        ]),
        signal,
      );
    } finally {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        this.outcomeWaiters.delete(agentCallId);
      }
    }
  }

  onBackgroundError(listener: AgentCallBackgroundErrorListener): () => void {
    this.backgroundErrorListeners.add(listener);
    return () => this.backgroundErrorListeners.delete(listener);
  }

  cancel(agentCallId: AgentCallId): Promise<AgentCallRecord> {
    const record = this.requireRecord(agentCallId);
    const activeCancellation = this.activeCancellationByTaskId.get(
      record.taskId,
    );
    if (activeCancellation) {
      return activeCancellation;
    }
    const startedFields = agentCallLogFields(record);
    this.writeLog("info", "agent_call.cancel.started", startedFields);
    this.writeLog("debug", "agent_call.cancel.started", startedFields);
    this.activeContinuationByTaskId.get(record.taskId)?.controller.abort();
    const operation = Promise.resolve()
      .then(() => this.performCancel(agentCallId, record.taskId))
      .then((canceledRecord) => {
        const completedFields = {
          ...agentCallLogFields(canceledRecord),
          artifactCount: canceledRecord.artifacts.length,
          questionCount: canceledRecord.questions?.length ?? 0,
          statusMessageLength: canceledRecord.statusMessage?.length ?? 0,
        };
        this.writeLog("info", "agent_call.cancel.completed", completedFields);
        this.writeLog("debug", "agent_call.cancel.completed", completedFields);
        return canceledRecord;
      })
      .catch((error: unknown) => {
        const failedFields = { ...startedFields, ...errorLogFields(error) };
        this.writeLog("error", "agent_call.cancel.failed", failedFields);
        this.writeLog("debug", "agent_call.cancel.failed", failedFields);
        throw error;
      });
    this.activeCancellationByTaskId.set(record.taskId, operation);
    this.activeCancellations.add(operation);
    void operation.then(
      () => this.finishCancellation(record.taskId, operation),
      () => this.finishCancellation(record.taskId, operation),
    );
    return operation;
  }

  private async performCancel(
    agentCallId: AgentCallId,
    taskId: string,
  ): Promise<AgentCallRecord> {
    const continuation = this.activeContinuationByTaskId.get(taskId);
    if (continuation) {
      continuation.controller.abort();
      await Promise.allSettled([continuation.promise]);
    }
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

  private finishCancellation(
    taskId: string,
    operation: Promise<AgentCallRecord>,
  ): void {
    if (this.activeCancellationByTaskId.get(taskId) === operation) {
      this.activeCancellationByTaskId.delete(taskId);
    }
    this.activeCancellations.delete(operation);
  }

  continueTask(
    request: AgentCallContinueRequest,
  ): Promise<AgentCallContinueResult> {
    this.assertOpen();
    const task = this.taskService.get(request.sessionId, request.taskId);
    if (task === undefined) {
      return Promise.resolve({ status: "not-found", taskId: request.taskId });
    }
    if (task.kind !== AGENT_CALL_TASK_KIND) {
      return Promise.resolve({
        status: "unsupported",
        taskId: request.taskId,
        operation: "continue",
      });
    }
    if (task.state !== "input-required") {
      return Promise.resolve({
        status: "invalid-state",
        taskId: request.taskId,
        state: task.state,
      });
    }
    const initialRecord = this.getByAgentCallId(request.taskId);
    if (initialRecord === undefined) {
      return Promise.reject(
        new Error(`AgentCall Task ${request.taskId} has no internal record`),
      );
    }
    if (initialRecord.state !== "input-required") {
      return Promise.resolve({
        status: "invalid-state",
        taskId: request.taskId,
        state: task.state,
      });
    }
    const answers = validateContinuationAnswers(
      initialRecord.questions,
      request.answers,
    );
    if (answers === undefined) {
      return Promise.resolve({
        status: "invalid-answers",
        taskId: request.taskId,
        error:
          "Answers must cover every pending question exactly once with at least one non-blank answer.",
      });
    }
    const a2aTaskId = initialRecord.taskId;
    const questionIds = Object.keys(answers);
    const startedFields: RuntimeLogFields = {
      taskId: request.taskId,
      ...agentCallLogFields(initialRecord),
      questionIds,
      count: questionIds.length,
    };
    this.writeLog("info", "agent_call.continue.started", startedFields);
    this.writeLog("debug", "agent_call.continue.started", startedFields);
    if (this.activeCancellationByTaskId.has(a2aTaskId)) {
      return Promise.reject(
        new Error(`Remote task ${a2aTaskId} is being canceled`),
      );
    }
    if (this.activeContinuationByTaskId.has(a2aTaskId)) {
      return Promise.reject(
        new Error(
          `Remote task ${a2aTaskId} already has an active continuation`,
        ),
      );
    }
    const controller = new AbortController();
    const continuationSignal =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([request.signal, controller.signal]);
    const internalOperation = Promise.resolve()
      .then(() =>
        this.performContinueTask(
          a2aTaskId,
          answers,
          continuationSignal,
          controller.signal,
        ),
      )
      .then((record) => {
        const acceptedFields = {
          ...agentCallLogFields(record),
          questionIds,
          count: questionIds.length,
        };
        this.writeLog("info", "agent_call.continue.accepted", acceptedFields);
        this.writeLog("debug", "agent_call.continue.accepted", acceptedFields);
        return record;
      })
      .catch((error: unknown) => {
        const failedFields = { ...startedFields, ...errorLogFields(error) };
        this.writeLog("error", "agent_call.continue.failed", failedFields);
        this.writeLog("debug", "agent_call.continue.failed", failedFields);
        throw error;
      });
    const activeContinuation = { controller, promise: internalOperation };
    this.activeContinuationByTaskId.set(a2aTaskId, activeContinuation);
    void internalOperation.then(
      () => {
        if (
          this.activeContinuationByTaskId.get(a2aTaskId) === activeContinuation
        ) {
          this.activeContinuationByTaskId.delete(a2aTaskId);
        }
      },
      () => {
        if (
          this.activeContinuationByTaskId.get(a2aTaskId) === activeContinuation
        ) {
          this.activeContinuationByTaskId.delete(a2aTaskId);
        }
      },
    );
    return internalOperation.then((record) => ({
      status: "continued",
      taskId: request.taskId,
      state: record.state,
    }));
  }

  private async performContinueTask(
    taskId: string,
    answers: AgentCallInputAnswers,
    signal: AbortSignal,
    internalSignal: AbortSignal,
  ): Promise<AgentCallRecord> {
    const agentCallId = this.agentCallIdByTaskId.get(taskId);
    if (agentCallId === undefined) {
      throw new Error(`Unknown remote task ${taskId}`);
    }
    const record = this.requireRecord(agentCallId);
    if (record.state !== "input-required") {
      throw new Error(
        `Remote task ${taskId} must be input-required before it can continue`,
      );
    }
    const previousWatcher = this.activeWatchers.get(agentCallId);
    if (previousWatcher) {
      previousWatcher.controller.abort();
      await previousWatcher.promise;
    }
    signal.throwIfAborted();
    this.assertOpen();

    const latestRecord = this.requireRecord(agentCallId);
    if (latestRecord.state !== "input-required") {
      throw new Error(
        `Remote task ${taskId} must be input-required before it can continue`,
      );
    }

    const continued = await this.transport.continueTask({
      taskId,
      ...(latestRecord.contextId === undefined
        ? {}
        : { contextId: latestRecord.contextId }),
      messageId: this.createMessageId(),
      signal,
      answers: cloneAnswers(answers),
    });
    if (this.closed) {
      await this.rejectContinuationDuringShutdown(agentCallId, taskId);
    }
    internalSignal.throwIfAborted();
    this.assertMatchingTask(latestRecord, continued);
    if (continued.state !== "working") {
      throw new Error(
        `Remote task ${taskId} continued in unexpected state ${continued.state}`,
      );
    }
    await this.applySnapshot(agentCallId, continued);
    if (this.closed) {
      this.recordsByAgentCallId.set(agentCallId, latestRecord);
      await this.rejectContinuationDuringShutdown(agentCallId, taskId);
    }
    internalSignal.throwIfAborted();
    this.startWatcher(agentCallId, continued);
    return this.requireRecordClone(agentCallId);
  }

  private async rejectContinuationDuringShutdown(
    agentCallId: AgentCallId,
    taskId: string,
  ): Promise<never> {
    try {
      await this.transport.cancelTask(taskId);
    } catch (error) {
      this.reportBackgroundError(
        new Error(
          `Failed to cancel remote task ${taskId} continued during shutdown`,
          { cause: error },
        ),
        agentCallId,
      );
    }
    throw new Error(
      `AgentCallService closed during continuation of remote task ${taskId}`,
    );
  }

  async waitForIdle(): Promise<void> {
    while (
      this.activeWatchers.size > 0 ||
      this.activeContinuationByTaskId.size > 0 ||
      this.activeCancellations.size > 0
    ) {
      await Promise.allSettled([
        ...[...this.activeWatchers.values()].map((watcher) => watcher.promise),
        ...[...this.activeContinuationByTaskId.values()].map(
          (continuation) => continuation.promise,
        ),
        ...this.activeCancellations,
      ]);
    }
  }

  close(): Promise<void> {
    if (this.closeOperation) {
      return this.closeOperation;
    }
    this.closed = true;
    this.writeLog("info", "agent_call.service.closing", {
      count:
        this.activeSubmissions.size +
        this.activeWatchers.size +
        this.activeContinuationByTaskId.size +
        this.activeCancellations.size,
      submissionCount: this.activeSubmissions.size,
      watcherCount: this.activeWatchers.size,
      continuationCount: this.activeContinuationByTaskId.size,
      cancellationCount: this.activeCancellations.size,
    });
    this.closeOperation = Promise.resolve().then(() => this.drainClose());
    return this.closeOperation;
  }

  private async drainClose(): Promise<void> {
    for (const continuation of this.activeContinuationByTaskId.values()) {
      continuation.controller.abort();
    }
    await Promise.allSettled([...this.activeSubmissions]);
    for (const watcher of this.activeWatchers.values()) {
      watcher.controller.abort();
    }
    await Promise.allSettled(
      [...this.activeContinuationByTaskId.values()].map(
        (continuation) => continuation.promise,
      ),
    );
    await this.waitForIdle();
    this.writeLog("info", "agent_call.service.closed", {
      count: this.recordsByAgentCallId.size,
    });
  }

  private cancelAfterAbortedWait(agentCallId: AgentCallId): void {
    void this.cancel(agentCallId).catch((cancelError) => {
      this.reportBackgroundError(
        new Error(
          `Failed to cancel AgentCall ${agentCallId} after its wait was aborted`,
          { cause: cancelError },
        ),
        agentCallId,
      );
    });
  }

  private startWatcher(
    agentCallId: AgentCallId,
    initial: AgentCallTaskSnapshot,
  ): void {
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const startedRecord = this.requireRecord(agentCallId);
      const startedFields = agentCallLogFields(startedRecord);
      this.writeLog("info", "agent_call.watcher.started", startedFields);
      this.writeLog("debug", "agent_call.watcher.started", startedFields);
      try {
        if (isAgentCallOutcomeState(initial.state)) {
          await this.applySnapshot(agentCallId, initial);
          return;
        }

        let sawOutcome = false;
        for await (const snapshot of this.transport.watchTask(initial.taskId, {
          signal: controller.signal,
        })) {
          this.assertMatchingTask(this.requireRecord(agentCallId), snapshot);
          await this.applySnapshot(agentCallId, snapshot);
          if (isAgentCallOutcomeState(snapshot.state)) {
            sawOutcome = true;
            break;
          }
        }

        const finalState = this.requireRecord(agentCallId).state;
        const isPaused =
          finalState === "input-required" || finalState === "auth-required";
        if (
          !sawOutcome &&
          !isPaused &&
          !this.closed &&
          !controller.signal.aborted
        ) {
          throw new Error(
            "Remote task subscription ended before a terminal state",
          );
        }
      } catch (error) {
        if (!this.closed && !controller.signal.aborted) {
          const failedFields = {
            ...agentCallLogFields(this.requireRecord(agentCallId)),
            ...errorLogFields(error),
          };
          this.writeLog("error", "agent_call.watcher.failed", failedFields);
          this.writeLog("debug", "agent_call.watcher.failed", failedFields);
        }
        if (isAgentCallOutcomeState(this.requireRecord(agentCallId).state)) {
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
              statusMessage: errorMessage(error),
            });
          } catch (notificationError) {
            this.reportBackgroundError(notificationError, agentCallId);
          }
        }
      } finally {
        const stoppedRecord = this.getByAgentCallId(agentCallId);
        if (stoppedRecord !== undefined) {
          this.writeLog(
            "info",
            "agent_call.watcher.stopped",
            agentCallLogFields(stoppedRecord),
          );
        }
      }
    });

    const activeWatcher = { controller, promise };
    this.activeWatchers.set(agentCallId, activeWatcher);
    void promise.then(
      () => {
        if (this.activeWatchers.get(agentCallId) === activeWatcher) {
          this.activeWatchers.delete(agentCallId);
        }
      },
      () => {
        if (this.activeWatchers.get(agentCallId) === activeWatcher) {
          this.activeWatchers.delete(agentCallId);
        }
      },
    );
  }

  private async applySnapshot(
    agentCallId: AgentCallId,
    snapshot: AgentCallTaskSnapshot,
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
      questions:
        snapshot.state === "input-required" && snapshot.questions !== undefined
          ? cloneQuestions(snapshot.questions)
          : undefined,
      ...(snapshot.statusMessage === undefined
        ? {
            statusMessage:
              current.state === "input-required" && snapshot.state === "working"
                ? undefined
                : current.statusMessage,
          }
        : { statusMessage: snapshot.statusMessage }),
      updatedAt: this.now().toISOString(),
    };
    this.recordsByAgentCallId.set(agentCallId, updated);
    if (updated.executionMode === "async") {
      this.taskService.updateAccepted(updated.sessionId, agentCallId, {
        state: updated.state,
        payload: agentCallTaskPayload(updated),
        ...(updated.statusMessage === undefined
          ? {}
          : { statusMessage: updated.statusMessage }),
      });
    }

    if (current.state !== updated.state) {
      const stateFields = {
        ...agentCallLogFields(updated),
        previousState: current.state,
        ...snapshotCountFields(snapshot),
      };
      this.writeLog("info", "agent_call.state.changed", stateFields);
      this.writeLog("debug", "agent_call.state.changed", stateFields);
    }

    if (snapshot.state === "working") {
      this.inputRequiredHandled.delete(agentCallId);
    } else if (
      snapshot.state === "input-required" &&
      !this.inputRequiredHandled.has(agentCallId)
    ) {
      this.inputRequiredHandled.add(agentCallId);
      const questions = updated.questions ?? [];
      const pausedFields = {
        ...agentCallLogFields(updated),
        questionIds: questions.map(({ id }) => id),
        questionCount: questions.length,
        statusMessageLength: updated.statusMessage?.length ?? 0,
      };
      this.writeLog("info", "agent_call.paused", pausedFields);
      this.writeLog("debug", "agent_call.paused", pausedFields);
    }

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
    const terminalFields = {
      ...agentCallLogFields(updated),
      artifactCount: updated.artifacts.length,
      statusMessageLength: updated.statusMessage?.length ?? 0,
    };
    this.writeLog("info", "agent_call.terminal", terminalFields);
    this.writeLog("debug", "agent_call.terminal", terminalFields);
    this.activeWatchers.get(agentCallId)?.controller.abort();
  }

  private assertMatchingTask(
    record: AgentCallRecord,
    snapshot: AgentCallTaskSnapshot,
  ): void {
    if (record.taskId !== snapshot.taskId) {
      throw new Error(
        `Remote update task ${snapshot.taskId} does not match ${record.taskId}`,
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

  private writeLog(
    level: RuntimeLogLevel,
    message: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Runtime logging must never change AgentCall lifecycle semantics.
    }
  }

  private reportBackgroundError(
    error: unknown,
    agentCallId?: AgentCallId,
  ): void {
    const normalized =
      error instanceof Error ? error : new Error(errorMessage(error));
    const record =
      agentCallId === undefined
        ? undefined
        : this.getByAgentCallId(agentCallId);
    const fields = {
      ...(record === undefined ? {} : agentCallLogFields(record)),
      ...errorLogFields(normalized),
    };
    this.writeLog("error", "agent_call.background_error", fields);
    this.writeLog("debug", "agent_call.background_error", fields);
    for (const listener of this.backgroundErrorListeners) {
      try {
        void Promise.resolve(listener(normalized, record)).catch(
          () => undefined,
        );
      } catch {
        // Error observers must not create another unhandled background failure.
      }
    }
  }
}

function cloneArtifacts(
  artifacts: readonly AgentCallRecord["artifacts"][number][],
): AgentCallRecord["artifacts"] {
  return artifacts.map((artifact) => ({ ...artifact }));
}

function agentCallLogFields(record: AgentCallRecord): RuntimeLogFields {
  return {
    sessionId: record.sessionId,
    runId: record.runId,
    agentCallId: record.agentCallId,
    a2aTaskId: record.taskId,
    ...(record.contextId === undefined ? {} : { contextId: record.contextId }),
    ...(record.sourceToolCallId === undefined
      ? {}
      : { sourceToolCallId: record.sourceToolCallId }),
    skillId: record.skillId,
    state: record.state,
    executionMode: record.executionMode,
  };
}

function snapshotCountFields(
  snapshot: AgentCallTaskSnapshot,
): RuntimeLogFields {
  return {
    artifactCount: snapshot.artifacts.length,
    questionCount: snapshot.questions?.length ?? 0,
    statusMessageLength: snapshot.statusMessage?.length ?? 0,
  };
}

function errorLogFields(error: unknown): RuntimeLogFields {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    errorMessageLength: errorMessage(error).length,
  };
}

function cloneQuestions(
  questions: NonNullable<AgentCallRecord["questions"]>,
): NonNullable<AgentCallRecord["questions"]> {
  return questions.map((question) => ({
    ...question,
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({ ...option })),
  }));
}

function cloneAnswers(answers: AgentCallInputAnswers): AgentCallInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, values]) => [
      questionId,
      [...values],
    ]),
  );
}

function validateContinuationAnswers(
  questions: AgentCallRecord["questions"],
  answers: AgentCallInputAnswers,
): AgentCallInputAnswers | undefined {
  if (questions === undefined || questions.length === 0) {
    return undefined;
  }
  const questionIds = new Set(questions.map((question) => question.id));
  if (questionIds.size !== questions.length) {
    return undefined;
  }
  const answerEntries = Object.entries(answers);
  if (answerEntries.length !== questionIds.size) {
    return undefined;
  }
  for (const [questionId, values] of answerEntries) {
    if (
      !questionIds.has(questionId) ||
      values.length === 0 ||
      values.some((value) => value.trim().length === 0)
    ) {
      return undefined;
    }
  }
  return cloneAnswers(answers);
}

function agentCallTaskPayload(record: AgentCallRecord) {
  return {
    artifacts: cloneArtifacts(record.artifacts),
    ...(record.questions === undefined
      ? {}
      : { questions: cloneQuestions(record.questions) }),
  };
}

function cloneRecord(
  record: AgentCallRecord | undefined,
): AgentCallRecord | undefined {
  return record === undefined
    ? undefined
    : {
        ...record,
        artifacts: cloneArtifacts(record.artifacts),
        ...(record.questions === undefined
          ? {}
          : { questions: cloneQuestions(record.questions) }),
      };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
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
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("AgentCall wait aborted");
}
