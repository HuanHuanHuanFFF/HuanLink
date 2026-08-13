import type {
  AgentCallId,
  HuanLinkTaskId,
  RunId,
  SessionId,
} from "../shared/ids.js";
import type {
  AsyncToolTaskKindDefinition,
  AsyncToolTaskPayload,
  AsyncToolTaskState,
} from "../async-tool-task/types.js";
import type { TaskExecutionMode } from "../tasks/types.js";

export type AgentCallTaskState =
  | "unknown"
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export const AGENT_CALL_TERMINAL_STATES = [
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const satisfies readonly AgentCallTaskState[];

export type AgentCallTerminalState =
  (typeof AGENT_CALL_TERMINAL_STATES)[number];

const terminalStates = new Set<AgentCallTaskState>(AGENT_CALL_TERMINAL_STATES);

export function isAgentCallTerminalState(
  state: AgentCallTaskState,
): state is AgentCallTerminalState {
  return terminalStates.has(state);
}

export function isAgentCallOutcomeState(state: AgentCallTaskState): boolean {
  return (
    isAgentCallTerminalState(state) ||
    state === "input-required" ||
    state === "auth-required"
  );
}

export type AgentCallCapability = {
  id: string;
  name: string;
  description?: string;
};

export type AgentCallArtifact = {
  id: string;
  name?: string;
  description?: string;
  text?: string;
};

export type AgentCallInputOption = {
  description: string;
  label: string;
};

export type AgentCallInputQuestion = {
  header: string;
  id: string;
  isOther: boolean;
  isSecret: boolean;
  options: AgentCallInputOption[] | null;
  question: string;
};

export type AgentCallInputAnswers = Record<string, string[]>;

export const AGENT_CALL_TASK_KIND = "agent-call" as const;

export type AgentCallTaskPublicPayload = {
  readonly artifacts: readonly AgentCallArtifact[];
  readonly questions?: readonly AgentCallInputQuestion[];
};

export const AGENT_CALL_TASK_KIND_DEFINITION: AsyncToolTaskKindDefinition = {
  kind: AGENT_CALL_TASK_KIND,
  quotaPool: "a2a",
  validatePayload: validateAgentCallTaskPayload,
  projectPublicStatus: ({ payload, statusMessage }) => ({
    payload: validateAgentCallTaskPayload(payload),
    ...(statusMessage === undefined ? {} : { statusMessage }),
  }),
};

export type AgentCallTaskSnapshot = {
  taskId: string;
  contextId?: string;
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  questions?: AgentCallInputQuestion[];
  statusMessage?: string;
};

export type AgentCallTransportSubmitRequest = {
  messageId: string;
  skillId: string;
  input: string;
  contextId?: string;
  signal?: AbortSignal;
};

export type AgentCallTransportContinueRequest = {
  answers: AgentCallInputAnswers;
  contextId?: string;
  messageId: string;
  signal?: AbortSignal;
  taskId: string;
};

/**
 * Describes what is known at the transport dispatch boundary.
 *
 * `dispatch-uncertain` means the request entered the remote send operation,
 * but HuanLink could not prove whether the remote Agent accepted it.
 */
export type AgentCallTransportSubmitResult =
  | {
      outcome: "accepted";
      snapshot: AgentCallTaskSnapshot;
    }
  | {
      outcome: "not-dispatched";
      error: unknown;
    }
  | {
      outcome: "dispatch-uncertain";
      error: unknown;
    };

export interface AgentCallTransport {
  discoverCapability(
    skillId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgentCallCapability>;
  submitTask(
    request: AgentCallTransportSubmitRequest,
  ): Promise<AgentCallTransportSubmitResult>;
  continueTask(
    request: AgentCallTransportContinueRequest,
  ): Promise<AgentCallTaskSnapshot>;
  watchTask(
    taskId: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<AgentCallTaskSnapshot>;
  cancelTask(taskId: string): Promise<AgentCallTaskSnapshot>;
}

type AgentCallRequestBase = {
  runId: RunId;
  sessionId: SessionId;
  skillId: string;
  input: string;
  contextId?: string;
  signal?: AbortSignal;
};

export type AgentCallAsyncRequest = AgentCallRequestBase & {
  executionMode: "async";
  toolName: string;
  sourceToolCallId: string;
};

export type AgentCallBlockingRequest = AgentCallRequestBase & {
  executionMode: "blocking";
  toolName: string;
  sourceToolCallId: string;
};

export type AgentCallRequest = AgentCallAsyncRequest | AgentCallBlockingRequest;

export type AgentCallReceipt = {
  status: "accepted";
  taskId: HuanLinkTaskId;
  state: AgentCallTaskState;
};

export type AgentCallTaskLimitResult = {
  status: "error";
  error: "task-limit-reached";
  maxActiveTasksPerSession: number;
};

export type AgentCallPreacceptRejectedResult = {
  status: "error";
  error: "task-preaccept-rejected";
};

export type AgentCallNonRetryableErrorResult = {
  status: "error";
  error: "remote-task-conflict";
  retrySafe: false;
};

export type AgentCallAsyncInvocationResult =
  | AgentCallReceipt
  | AgentCallTaskLimitResult
  | AgentCallPreacceptRejectedResult
  | AgentCallNonRetryableErrorResult;

export type AgentCallBlockingResult = {
  status: "result";
  executionMode: "blocking";
  state: AgentCallTerminalState;
  artifacts: AgentCallArtifact[];
  statusMessage?: string;
};

export type AgentCallBlockingInterruptedResult = {
  status: "blocking-interrupted";
  executionMode: "blocking";
  state: "input-required" | "auth-required";
  questions?: AgentCallInputQuestion[];
  statusMessage?: string;
};

export type AgentCallBlockingUncertainResult = {
  status: "blocking-uncertain";
  executionMode: "blocking";
  taskId: HuanLinkTaskId;
  state: "unknown";
  retrySafe: false;
};

export type AgentCallInvocationResult =
  | AgentCallAsyncInvocationResult
  | AgentCallBlockingResult
  | AgentCallBlockingInterruptedResult
  | AgentCallBlockingUncertainResult;

export type AgentCallRecord = {
  agentCallId: AgentCallId;
  taskId: string;
  contextId?: string;
  runId: RunId;
  sessionId: SessionId;
  skillId: string;
  capabilityName: string;
  input: string;
  executionMode: TaskExecutionMode;
  sourceToolCallId?: string;
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  questions?: AgentCallInputQuestion[];
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export interface AgentCallReader {
  getByAgentCallId(agentCallId: AgentCallId): AgentCallRecord | undefined;
  getByTaskId(taskId: string): AgentCallRecord | undefined;
}

export interface AgentCallSubmitter {
  submit(
    request: AgentCallAsyncRequest,
  ): Promise<AgentCallAsyncInvocationResult>;
}

export interface AgentCallInvoker {
  invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult>;
}

export type AgentCallContinueRequest = {
  sessionId: SessionId;
  taskId: HuanLinkTaskId;
  answers: AgentCallInputAnswers;
  signal?: AbortSignal;
};

export type AgentCallContinueResult =
  | { status: "not-found"; taskId: HuanLinkTaskId }
  | {
      status: "unsupported";
      taskId: HuanLinkTaskId;
      operation: "continue";
    }
  | {
      status: "invalid-state";
      taskId: HuanLinkTaskId;
      state: AsyncToolTaskState;
    }
  | { status: "invalid-answers"; taskId: HuanLinkTaskId; error: string }
  | {
      status: "continued";
      taskId: HuanLinkTaskId;
      state: AgentCallTaskState;
    };

export interface AgentCallContinuator {
  continueTask(
    request: AgentCallContinueRequest,
  ): Promise<AgentCallContinueResult>;
}

export type AgentCallBackgroundErrorListener = (
  error: Error,
  record: AgentCallRecord | undefined,
) => Promise<void> | void;

function validateAgentCallTaskPayload(payload: unknown): AsyncToolTaskPayload {
  if (!isRecord(payload) || !Array.isArray(payload.artifacts)) {
    throw new Error("AgentCall Task payload must contain artifacts");
  }
  const artifacts = payload.artifacts.map((artifact) => {
    if (!isRecord(artifact) || typeof artifact.id !== "string") {
      throw new Error("AgentCall Task artifact must contain an ID");
    }
    return copyOptionalStrings(artifact, ["id", "name", "description", "text"]);
  });
  const questions =
    payload.questions === undefined
      ? undefined
      : validateAgentCallTaskQuestions(payload.questions);
  return {
    artifacts,
    ...(questions === undefined ? {} : { questions }),
  };
}

function validateAgentCallTaskQuestions(
  value: unknown,
): AsyncToolTaskPayload["questions"] {
  if (!Array.isArray(value)) {
    throw new Error("AgentCall Task questions must be an array");
  }
  return value.map((question) => {
    if (
      !isRecord(question) ||
      typeof question.header !== "string" ||
      typeof question.id !== "string" ||
      typeof question.isOther !== "boolean" ||
      typeof question.isSecret !== "boolean" ||
      typeof question.question !== "string" ||
      (question.options !== null && !Array.isArray(question.options))
    ) {
      throw new Error("AgentCall Task question is invalid");
    }
    const options =
      question.options === null
        ? null
        : question.options.map((option) => {
            if (
              !isRecord(option) ||
              typeof option.description !== "string" ||
              typeof option.label !== "string"
            ) {
              throw new Error("AgentCall Task question option is invalid");
            }
            return {
              description: option.description,
              label: option.label,
            };
          });
    return {
      header: question.header,
      id: question.id,
      isOther: question.isOther,
      isSecret: question.isSecret,
      options,
      question: question.question,
    };
  });
}

function copyOptionalStrings(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined && typeof candidate !== "string") {
      throw new Error(`AgentCall Task field ${key} must be a string`);
    }
    if (candidate !== undefined) {
      result[key] = candidate;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
