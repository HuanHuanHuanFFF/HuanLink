import {
  A2A_PROTOCOL_VERSION,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  type SendMessageResult,
  type Task
} from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger,
  type AgentCallCapability,
  type AgentCallTaskSnapshot,
  type AgentCallTransport,
  type AgentCallTransportContinueRequest,
  type AgentCallTransportSubmitRequest
} from "@huanlink/core";
import {
  isPaused,
  isTerminal,
  messageFields,
  snapshotFromTask,
  stateFromTaskState
} from "./a2a-task-snapshot.js";
import {
  A2aProtocolError,
  errorLogFields,
  isRetryableObservationError,
  isTaskNotCancelable,
  isUnsupportedOperation
} from "./a2a-transport-errors.js";
export type A2aAgentCallTransportOptions = {
  origin: string;
  logger?: RuntimeLogger;
};

const TERMINAL_RECONCILIATION_ATTEMPTS = 4;
const RECONCILIATION_DELAY_MS = 20;
const SUBSCRIPTION_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

export class A2aAgentCallTransport implements AgentCallTransport {
  private readonly origin: string;
  private readonly clientFactory: ClientFactory;
  private readonly logger: RuntimeLogger;
  private clientPromise: Promise<Client> | undefined;
  private clientCreationAttempt = 0;

  constructor(options: A2aAgentCallTransportOptions) {
    this.origin = options.origin;
    this.clientFactory = new ClientFactory();
    this.logger = options.logger ?? new NoopRuntimeLogger();
  }

  async discoverCapability(
    skillId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<AgentCallCapability> {
    const fields = { skillId };
    this.writeLog("info", "a2a.discover.started", fields);
    try {
      const client = await this.getClient();
      if (client.protocolVersion !== A2A_PROTOCOL_VERSION) {
        throw new A2aProtocolError(
          `A2A agent negotiated protocol ${client.protocolVersion}; expected ${A2A_PROTOCOL_VERSION}`
        );
      }

      const card = await client.getAgentCard(
        options.signal === undefined ? undefined : { signal: options.signal }
      );
      if (!card.capabilities?.streaming) {
        throw new A2aProtocolError(
          "A2A agent does not advertise task streaming"
        );
      }

      const skill = card.skills.find((candidate) => candidate.id === skillId);
      if (!skill) {
        throw new A2aProtocolError(
          `A2A Agent Card does not declare skill ${skillId}`
        );
      }

      const capability = {
        id: skill.id,
        name: skill.name,
        ...(skill.description === "" ? {} : { description: skill.description })
      };
      this.writeLog("info", "a2a.discover.completed", fields);
      return capability;
    } catch (error) {
      this.writeLog("error", "a2a.discover.failed", {
        ...fields,
        ...errorLogFields(error)
      });
      throw error;
    }
  }

  async submitTask(
    request: AgentCallTransportSubmitRequest
  ): Promise<AgentCallTaskSnapshot> {
    const fields: RuntimeLogFields = {
      messageId: request.messageId,
      skillId: request.skillId,
      ...(request.contextId === undefined
        ? {}
        : { contextId: request.contextId })
    };
    this.writeLog("info", "a2a.submit.started", fields);
    try {
      await this.discoverCapability(request.skillId, { signal: request.signal });
      const client = await this.getClient();
      const result = await client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: request.messageId,
            ...(request.contextId === undefined
              ? {}
              : { contextId: request.contextId }),
            role: "ROLE_USER",
            parts: [{ text: request.input }]
          },
          configuration: { returnImmediately: true }
        }),
        request.signal === undefined ? undefined : { signal: request.signal }
      );

      const snapshot = snapshotFromTask(requireTask(result));
      this.writeLog("info", "a2a.submit.completed", {
        ...fields,
        ...snapshotLogFields(snapshot)
      });
      return snapshot;
    } catch (error) {
      this.writeLog("error", "a2a.submit.failed", {
        ...fields,
        ...errorLogFields(error)
      });
      throw error;
    }
  }

  async continueTask(
    request: AgentCallTransportContinueRequest
  ): Promise<AgentCallTaskSnapshot> {
    const questionIds = Object.keys(request.answers);
    const fields: RuntimeLogFields = {
      messageId: request.messageId,
      a2aTaskId: request.taskId,
      ...(request.contextId === undefined
        ? {}
        : { contextId: request.contextId }),
      questionIds,
      count: questionIds.length
    };
    this.writeLog("info", "a2a.continue.started", fields);
    try {
      const client = await this.getClient();
      const result = await client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: request.messageId,
            taskId: request.taskId,
            ...(request.contextId === undefined
              ? {}
              : { contextId: request.contextId }),
            role: "ROLE_USER",
            parts: [{ data: { answers: request.answers } }]
          },
          configuration: { returnImmediately: true }
        }),
        request.signal === undefined ? undefined : { signal: request.signal }
      );
      const task = requireTask(result);
      assertTaskId(request.taskId, task.id);
      if (
        request.contextId !== undefined &&
        task.contextId !== request.contextId
      ) {
        throw new A2aProtocolError(
          `A2A continuation returned context ${task.contextId}, expected ${request.contextId}`
        );
      }
      const snapshot = snapshotFromTask(task);
      this.writeLog("info", "a2a.continue.completed", {
        ...fields,
        ...snapshotLogFields(snapshot)
      });
      return snapshot;
    } catch (error) {
      this.writeLog("error", "a2a.continue.failed", {
        ...fields,
        ...errorLogFields(error)
      });
      throw error;
    }
  }

  async *watchTask(
    taskId: string,
    options: { signal: AbortSignal }
  ): AsyncIterable<AgentCallTaskSnapshot> {
    this.writeLog("info", "a2a.watch.started", {
      a2aTaskId: taskId,
      attempt: 1
    });
    let failed = false;
    let aborted = false;
    try {
      for await (const snapshot of this.watchTaskSnapshots(taskId, options)) {
        this.writeLog("debug", "a2a.watch.snapshot", snapshotLogFields(snapshot));
        yield snapshot;
      }
    } catch (error) {
      if (options.signal.aborted) {
        aborted = true;
        this.writeLog("debug", "a2a.watch.aborted", {
          a2aTaskId: taskId,
          ...errorLogFields(error, "abort")
        });
      } else {
        failed = true;
        this.writeLog("error", "a2a.watch.failed", {
          a2aTaskId: taskId,
          ...errorLogFields(error)
        });
      }
      throw error;
    } finally {
      if (!failed && !aborted) {
        this.writeLog("info", "a2a.watch.ended", { a2aTaskId: taskId });
      }
    }
  }

  private async *watchTaskSnapshots(
    taskId: string,
    options: { signal: AbortSignal }
  ): AsyncIterable<AgentCallTaskSnapshot> {
    const client = await this.getClient();

    for (let attempt = 1; ; attempt += 1) {
      let terminalEventSeen = false;
      let streamError: unknown;

      try {
        for await (const event of client.resubscribeTask(
          SubscribeToTaskRequest.fromJSON({ id: taskId }),
          { signal: options.signal }
        )) {
          if (event.payload?.$case === "task") {
            assertTaskId(taskId, event.payload.value.id);
            const snapshot = snapshotFromTask(event.payload.value);
            if (isTerminal(snapshot.state)) {
              terminalEventSeen = true;
              break;
            }
            yield snapshot;
            if (isPaused(snapshot.state)) {
              return;
            }
            continue;
          }

          if (event.payload?.$case === "statusUpdate") {
            const update = event.payload.value;
            assertTaskId(taskId, update.taskId);
            const state = stateFromTaskState(update.status?.state);
            if (isTerminal(state)) {
              terminalEventSeen = true;
              break;
            }
            const snapshot: AgentCallTaskSnapshot = {
              taskId: update.taskId,
              contextId: update.contextId,
              state,
              artifacts: [],
              ...messageFields(update.status?.message)
            };
            yield snapshot;
            if (isPaused(snapshot.state)) {
              return;
            }
          }
        }
      } catch (error) {
        if (options.signal.aborted) {
          throw error;
        }
        streamError = error;
      }

      let reconciled: AgentCallTaskSnapshot;
      try {
        reconciled = await this.reconcileTask(
          taskId,
          options.signal,
          terminalEventSeen || isUnsupportedOperation(streamError)
            ? TERMINAL_RECONCILIATION_ATTEMPTS
            : 1
        );
      } catch (error) {
        if (options.signal.aborted || !isRetryableObservationError(error)) {
          throw error;
        }
        this.writeLog("warn", "a2a.watch.reconcile_failed", {
          a2aTaskId: taskId,
          attempt,
          ...errorLogFields(error, "network")
        });
        await abortableDelay(subscriptionRetryDelayMs(attempt), options.signal);
        continue;
      }
      this.writeLog("info", "a2a.watch.reconciled", {
        ...snapshotLogFields(reconciled),
        attempt
      });
      if (isTerminal(reconciled.state)) {
        yield reconciled;
        return;
      }

      if (isPaused(reconciled.state)) {
        yield reconciled;
        return;
      }

      if (isUnsupportedOperation(streamError)) {
        throw new A2aProtocolError(
          `A2A task ${taskId} cannot be subscribed and is not terminal`,
          { cause: streamError }
        );
      }

      this.writeLog("info", "a2a.watch.retry", {
        ...snapshotLogFields(reconciled),
        attempt
      });
      await abortableDelay(subscriptionRetryDelayMs(attempt), options.signal);
    }
  }

  async cancelTask(taskId: string): Promise<AgentCallTaskSnapshot> {
    const fields = { a2aTaskId: taskId };
    this.writeLog("info", "a2a.cancel.started", fields);
    try {
      const client = await this.getClient();
      let snapshot: AgentCallTaskSnapshot;
      try {
        const task = await client.cancelTask(
          CancelTaskRequest.fromJSON({ id: taskId })
        );
        snapshot = snapshotFromTask(task);
      } catch (error) {
        if (!isTaskNotCancelable(error)) {
          throw error;
        }
        snapshot = await this.getTask(taskId);
      }
      this.writeLog("info", "a2a.cancel.completed", {
        ...fields,
        ...snapshotLogFields(snapshot)
      });
      return snapshot;
    } catch (error) {
      this.writeLog("error", "a2a.cancel.failed", {
        ...fields,
        ...errorLogFields(error)
      });
      throw error;
    }
  }

  private getClient(): Promise<Client> {
    if (this.clientPromise === undefined) {
      this.clientCreationAttempt += 1;
      const attempt = this.clientCreationAttempt;
      const pending = this.clientFactory.createFromUrl(this.origin);
      this.clientPromise = pending;
      void pending.catch((error: unknown) => {
        this.writeLog("error", "a2a.client.create_failed", {
          attempt,
          ...errorLogFields(error, "network")
        });
        if (this.clientPromise === pending) {
          this.clientPromise = undefined;
        }
      });
    }
    return this.clientPromise;
  }

  private writeLog(
    level: RuntimeLogLevel,
    message: string,
    fields: RuntimeLogFields
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging must never change A2A transport behavior.
    }
  }

  private async reconcileTask(
    taskId: string,
    signal: AbortSignal,
    attempts: number
  ): Promise<AgentCallTaskSnapshot> {
    let snapshot = await this.getTask(taskId, signal);
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (isTerminal(snapshot.state) || isPaused(snapshot.state)) {
        return snapshot;
      }
      await abortableDelay(RECONCILIATION_DELAY_MS * attempt, signal);
      snapshot = await this.getTask(taskId, signal);
    }
    return snapshot;
  }

  private async getTask(
    taskId: string,
    signal?: AbortSignal
  ): Promise<AgentCallTaskSnapshot> {
    const client = await this.getClient();
    const task = await client.getTask(
      GetTaskRequest.fromJSON({ id: taskId }),
      signal === undefined ? undefined : { signal }
    );
    assertTaskId(taskId, task.id);
    return snapshotFromTask(task);
  }
}

function snapshotLogFields(snapshot: AgentCallTaskSnapshot): RuntimeLogFields {
  return {
    a2aTaskId: snapshot.taskId,
    contextId: snapshot.contextId,
    state: snapshot.state,
    count: snapshot.artifacts.length
  };
}

function requireTask(result: SendMessageResult): Task {
  if (!("status" in result)) {
    throw new A2aProtocolError(
      "A2A SendMessage returned a Message; AgentCall requires a Task"
    );
  }
  return result;
}

function subscriptionRetryDelayMs(attempt: number): number {
  return SUBSCRIPTION_RETRY_DELAYS_MS[
    Math.min(attempt, SUBSCRIPTION_RETRY_DELAYS_MS.length) - 1
  ]!;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertTaskId(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new A2aProtocolError(
      `A2A update belongs to task ${actual}, expected ${expected}`
    );
  }
}
