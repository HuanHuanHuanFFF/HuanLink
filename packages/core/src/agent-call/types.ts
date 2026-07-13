import type { AgentCallId, RunId, SessionId } from "../shared/ids.js";
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
  "rejected"
] as const satisfies readonly AgentCallTaskState[];

const terminalStates = new Set<AgentCallTaskState>(AGENT_CALL_TERMINAL_STATES);

export function isAgentCallTerminalState(state: AgentCallTaskState): boolean {
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

export type AgentCallTaskSnapshot = {
  taskId: string;
  contextId?: string;
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  statusMessage?: string;
};

export type AgentCallTransportSubmitRequest = {
  messageId: string;
  skillId: string;
  input: string;
  contextId?: string;
  signal?: AbortSignal;
};

export interface AgentCallTransport {
  discoverCapability(
    skillId: string,
    options?: { signal?: AbortSignal }
  ): Promise<AgentCallCapability>;
  submitTask(
    request: AgentCallTransportSubmitRequest
  ): Promise<AgentCallTaskSnapshot>;
  watchTask(
    taskId: string,
    options: { signal: AbortSignal }
  ): AsyncIterable<AgentCallTaskSnapshot>;
  cancelTask(taskId: string): Promise<AgentCallTaskSnapshot>;
}

export type AgentCallRequest = {
  runId: RunId;
  sessionId: SessionId;
  skillId: string;
  input: string;
  executionMode: TaskExecutionMode;
  contextId?: string;
  signal?: AbortSignal;
};

export type AgentCallReceipt = {
  status: "accepted";
  executionMode: TaskExecutionMode;
  agentCallId: AgentCallId;
  taskId: string;
  state: AgentCallTaskState;
};

export type AgentCallBlockingResult = {
  status: "result";
  executionMode: "blocking";
  agentCallId: AgentCallId;
  taskId: string;
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  statusMessage?: string;
};

export type AgentCallInvocationResult =
  | AgentCallReceipt
  | AgentCallBlockingResult;

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
  state: AgentCallTaskState;
  artifacts: AgentCallArtifact[];
  statusMessage?: string;
  terminalNotificationError?: string;
  createdAt: string;
  updatedAt: string;
};

export interface AgentCallReader {
  getByAgentCallId(agentCallId: AgentCallId): AgentCallRecord | undefined;
  getByTaskId(taskId: string): AgentCallRecord | undefined;
}

export interface AgentCallSubmitter {
  submit(request: AgentCallRequest): Promise<AgentCallReceipt>;
}

export interface AgentCallInvoker {
  invoke(request: AgentCallRequest): Promise<AgentCallInvocationResult>;
}

export type AgentCallTerminalListener = (
  record: AgentCallRecord
) => Promise<void> | void;

export type AgentCallBackgroundErrorListener = (
  error: Error,
  record: AgentCallRecord | undefined
) => Promise<void> | void;
