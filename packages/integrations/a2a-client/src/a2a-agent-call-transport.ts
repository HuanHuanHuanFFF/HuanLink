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
import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger,
  type AgentCallArtifact,
  type AgentCallCapability,
  type AgentCallInputQuestion,
  type AgentCallTaskSnapshot,
  type AgentCallTaskState,
  type AgentCallTransport,
  type AgentCallTransportContinueRequest,
  type AgentCallTransportSubmitRequest
} from "@huanlink/core";
export type A2aAgentCallTransportOptions = {
  origin: string;
  logger?: RuntimeLogger;
};

const MAX_SUBSCRIPTION_ATTEMPTS = 3;
const TERMINAL_RECONCILIATION_ATTEMPTS = 4;
const RECONCILIATION_DELAY_MS = 20;

class A2aProtocolError extends Error {}

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
        lastStreamError = error;
      }

      const reconciled = await this.reconcileTask(
        taskId,
        options.signal,
        terminalEventSeen || isUnsupportedOperation(streamError)
          ? TERMINAL_RECONCILIATION_ATTEMPTS
          : 1
      );
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

      if (attempt === MAX_SUBSCRIPTION_ATTEMPTS) {
        if (isUnsupportedOperation(lastStreamError)) {
          throw new A2aProtocolError(
            `A2A task ${taskId} cannot be subscribed and is not terminal`,
            { cause: lastStreamError }
          );
        }
        if (lastStreamError !== undefined) {
          throw lastStreamError;
        }
        throw new A2aProtocolError(
          `A2A task ${taskId} subscription ended while state was ${reconciled.state}`
        );
      }

      this.writeLog("info", "a2a.watch.retry", {
        ...snapshotLogFields(reconciled),
        attempt
      });
      await abortableDelay(RECONCILIATION_DELAY_MS * attempt, options.signal);
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

type ErrorCategory = "abort" | "network" | "protocol" | "unknown";

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);
const ABORT_ERROR_CODES = new Set(["ABORT_ERR", "ERR_CANCELED"]);

function errorLogFields(
  error: unknown,
  categoryOverride?: ErrorCategory
): RuntimeLogFields {
  const errorCode = safeErrorCode(error);
  return {
    errorType: safeErrorType(error),
    errorMessageLength: safeOwnStringLength(error, "message"),
    errorCategory:
      categoryOverride ?? classifyErrorCategory(error, errorCode),
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

function classifyErrorCategory(
  error: unknown,
  errorCode: string | undefined
): ErrorCategory {
  if (errorCode !== undefined && ABORT_ERROR_CODES.has(errorCode)) {
    return "abort";
  }
  if (errorCode !== undefined && NETWORK_ERROR_CODES.has(errorCode)) {
    return "network";
  }
  try {
    return error instanceof A2aProtocolError ? "protocol" : "unknown";
  } catch {
    return "unknown";
  }
}

function safeErrorType(error: unknown): "Error" | "ThrownValue" {
  try {
    return error instanceof Error ? "Error" : "ThrownValue";
  } catch {
    return "ThrownValue";
  }
}

function safeErrorCode(error: unknown): string | undefined {
  const code = safeOwnDataValue(error, "code");
  return typeof code === "string" &&
    (NETWORK_ERROR_CODES.has(code) || ABORT_ERROR_CODES.has(code))
    ? code
    : undefined;
}

function safeOwnStringLength(value: unknown, key: string): number {
  const candidate = safeOwnDataValue(value, key);
  return typeof candidate === "string" ? candidate.length : 0;
}

function safeOwnDataValue(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function requireTask(result: SendMessageResult): Task {
  if (!("status" in result)) {
    throw new A2aProtocolError(
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
    ...messageFields(task.status?.message)
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

function messageFields(
  message: Message | undefined
): Pick<AgentCallTaskSnapshot, "statusMessage" | "questions"> {
  if (!message) {
    return {};
  }
  const text = message.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");
  const questions = message.parts.flatMap((part) =>
    part.content?.$case === "data"
      ? questionsFromData(part.content.value)
      : []
  );
  return {
    ...(text === "" ? {} : { statusMessage: text }),
    ...(questions.length === 0 ? {} : { questions })
  };
}

function questionsFromData(value: unknown): AgentCallInputQuestion[] {
  const data = asRecord(value);
  if (!data || !Array.isArray(data.questions)) {
    return [];
  }
  const questions = data.questions.map(questionFromData);
  return questions.some((question) => question === undefined)
    ? []
    : (questions as AgentCallInputQuestion[]);
}

function questionFromData(value: unknown): AgentCallInputQuestion | undefined {
  const question = asRecord(value);
  if (
    !question ||
    typeof question.id !== "string" ||
    typeof question.header !== "string" ||
    typeof question.question !== "string"
  ) {
    return undefined;
  }
  if (
    question.options !== undefined &&
    question.options !== null &&
    !Array.isArray(question.options)
  ) {
    return undefined;
  }
  const options =
    question.options === undefined || question.options === null
      ? null
      : question.options.map(optionFromData);
  if (options?.some((option) => option === undefined)) {
    return undefined;
  }
  return {
    header: question.header,
    id: question.id,
    isOther: question.isOther === true,
    isSecret: question.isSecret === true,
    options: options as AgentCallInputQuestion["options"],
    question: question.question
  };
}

function optionFromData(
  value: unknown
): NonNullable<AgentCallInputQuestion["options"]>[number] | undefined {
  const option = asRecord(value);
  return option &&
    typeof option.label === "string" &&
    typeof option.description === "string"
    ? { label: option.label, description: option.description }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    throw new A2aProtocolError(
      `A2A update belongs to task ${actual}, expected ${expected}`
    );
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
