import {
  A2A_PROTOCOL_VERSION,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState,
  type Artifact,
  type Message,
  type SendMessageResult,
  type Task
} from "@a2a-js/sdk";
import {
  ClientFactory,
  TaskNotCancelableError,
  UnsupportedOperationError,
  type Client
} from "@a2a-js/sdk/client";
import type {
  AgentCallArtifact,
  AgentCallCapability,
  AgentCallTaskSnapshot,
  AgentCallTaskState,
  AgentCallTransport,
  AgentCallTransportSubmitRequest
} from "@huanlink/core";

export type A2aAgentCallTransportOptions = {
  origin: string;
};

const MAX_SUBSCRIPTION_ATTEMPTS = 3;
const TERMINAL_RECONCILIATION_ATTEMPTS = 4;
const RECONCILIATION_DELAY_MS = 20;

export class A2aAgentCallTransport implements AgentCallTransport {
  private readonly origin: string;
  private readonly clientFactory: ClientFactory;
  private clientPromise: Promise<Client> | undefined;

  constructor(options: A2aAgentCallTransportOptions) {
    this.origin = options.origin;
    this.clientFactory = new ClientFactory();
  }

  async discoverCapability(
    skillId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<AgentCallCapability> {
    const client = await this.getClient();
    if (client.protocolVersion !== A2A_PROTOCOL_VERSION) {
      throw new Error(
        `A2A agent negotiated protocol ${client.protocolVersion}; expected ${A2A_PROTOCOL_VERSION}`
      );
    }

    const card = await client.getAgentCard(
      options.signal === undefined ? undefined : { signal: options.signal }
    );
    if (!card.capabilities?.streaming) {
      throw new Error("A2A agent does not advertise task streaming");
    }

    const skill = card.skills.find((candidate) => candidate.id === skillId);
    if (!skill) {
      throw new Error(`A2A Agent Card does not declare skill ${skillId}`);
    }

    return {
      id: skill.id,
      name: skill.name,
      ...(skill.description === "" ? {} : { description: skill.description })
    };
  }

  async submitTask(
    request: AgentCallTransportSubmitRequest
  ): Promise<AgentCallTaskSnapshot> {
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

    return snapshotFromTask(requireTask(result));
  }

  async *watchTask(
    taskId: string,
    options: { signal: AbortSignal }
  ): AsyncIterable<AgentCallTaskSnapshot> {
    const client = await this.getClient();
    let lastStreamError: unknown;

    for (let attempt = 1; attempt <= MAX_SUBSCRIPTION_ATTEMPTS; attempt += 1) {
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
            yield {
              taskId: update.taskId,
              contextId: update.contextId,
              state,
              artifacts: [],
              ...messageField(update.status?.message)
            };
          }
        }
      } catch (error) {
        if (options.signal.aborted) {
          throw error;
        }
        streamError = error;
        lastStreamError = error;
      }

      const reconciled = await this.reconcileTask(
        taskId,
        options.signal,
        terminalEventSeen || isUnsupportedOperation(streamError)
          ? TERMINAL_RECONCILIATION_ATTEMPTS
          : 1
      );
      if (isTerminal(reconciled.state)) {
        yield reconciled;
        return;
      }

      if (isPaused(reconciled.state)) {
        yield reconciled;
        return;
      }

      if (attempt === MAX_SUBSCRIPTION_ATTEMPTS) {
        if (isUnsupportedOperation(lastStreamError)) {
          throw new Error(
            `A2A task ${taskId} cannot be subscribed and is not terminal`,
            { cause: lastStreamError }
          );
        }
        if (lastStreamError !== undefined) {
          throw lastStreamError;
        }
        throw new Error(
          `A2A task ${taskId} subscription ended while state was ${reconciled.state}`
        );
      }

      await abortableDelay(RECONCILIATION_DELAY_MS * attempt, options.signal);
    }
  }

  async cancelTask(taskId: string): Promise<AgentCallTaskSnapshot> {
    const client = await this.getClient();
    try {
      const task = await client.cancelTask(
        CancelTaskRequest.fromJSON({ id: taskId })
      );
      return snapshotFromTask(task);
    } catch (error) {
      if (!isTaskNotCancelable(error)) {
        throw error;
      }
      return this.getTask(taskId);
    }
  }

  private getClient(): Promise<Client> {
    if (this.clientPromise === undefined) {
      const pending = this.clientFactory.createFromUrl(this.origin);
      this.clientPromise = pending;
      void pending.catch(() => {
        if (this.clientPromise === pending) {
          this.clientPromise = undefined;
        }
      });
    }
    return this.clientPromise;
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

function requireTask(result: SendMessageResult): Task {
  if (!("status" in result)) {
    throw new Error(
      "A2A SendMessage returned a Message; AgentCall requires a Task"
    );
  }
  return result;
}

function snapshotFromTask(task: Task): AgentCallTaskSnapshot {
  return {
    taskId: task.id,
    contextId: task.contextId,
    state: stateFromTaskState(task.status?.state),
    artifacts: task.artifacts.map(artifactFromA2a),
    ...messageField(task.status?.message)
  };
}

function artifactFromA2a(artifact: Artifact): AgentCallArtifact {
  const text = artifact.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");

  return {
    id: artifact.artifactId,
    ...(artifact.name === "" ? {} : { name: artifact.name }),
    ...(artifact.description === ""
      ? {}
      : { description: artifact.description }),
    ...(text === "" ? {} : { text })
  };
}

function messageField(
  message: Message | undefined
): Pick<AgentCallTaskSnapshot, "statusMessage"> | Record<string, never> {
  if (!message) {
    return {};
  }
  const text = message.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");
  return text === "" ? {} : { statusMessage: text };
}

function stateFromTaskState(state: TaskState | undefined): AgentCallTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    default:
      return "unknown";
  }
}

function isTerminal(state: AgentCallTaskState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected"
  );
}

function isPaused(state: AgentCallTaskState): boolean {
  return state === "input-required" || state === "auth-required";
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
    throw new Error(`A2A update belongs to task ${actual}, expected ${expected}`);
  }
}

function isUnsupportedOperation(error: unknown): boolean {
  return hasCause(
    error,
    (candidate) => candidate instanceof UnsupportedOperationError
  );
}

function isTaskNotCancelable(error: unknown): boolean {
  return hasCause(
    error,
    (candidate) => candidate instanceof TaskNotCancelableError
  );
}

function hasCause(
  error: unknown,
  predicate: (candidate: unknown) => boolean
): boolean {
  let candidate = error;
  const seen = new Set<unknown>();
  while (candidate !== undefined && candidate !== null && !seen.has(candidate)) {
    if (predicate(candidate)) {
      return true;
    }
    seen.add(candidate);
    candidate =
      typeof candidate === "object" && "cause" in candidate
        ? candidate.cause
        : undefined;
  }
  return false;
}
