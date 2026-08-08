import type { AgentCallTaskState } from "../agent-call/types.js";
import type { InboundChannelMessageV1 } from "../channels/contract-v1.js";
import type { AgentRuntimeTrigger } from "../runtime/agent-runtime.js";
import type { AgentCallId, RunId, SessionId } from "../shared/ids.js";
import type { TaskExecutionMode } from "../tasks/types.js";

export const RUN_VIEW_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunViewStatus = (typeof RUN_VIEW_STATUSES)[number];

export interface RunViewCause {
  readonly agentCallId: AgentCallId;
  readonly taskId: string;
  readonly state: AgentCallTaskState;
}

export type ChannelInputView = InboundChannelMessageV1;

export interface AgentCallView {
  readonly agentCallId: AgentCallId;
  readonly taskId: string;
  readonly skillId: string;
  readonly executionMode: TaskExecutionMode;
  readonly state: AgentCallTaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReplyView =
  | { readonly status: "not-sent" }
  | {
      readonly status: "sent";
      readonly conversationId: string;
      readonly text: string;
      readonly sentAt: string;
    }
  | {
      readonly status: "failed";
      readonly conversationId: string;
      readonly text: string;
      readonly error: string;
      readonly failedAt: string;
    };

export interface RunView {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly status: RunViewStatus;
  readonly trigger?: AgentRuntimeTrigger;
  readonly cause?: RunViewCause;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationSeconds?: number;
  readonly eventCount: number;
  readonly lastSeq: number;
  readonly input?: ChannelInputView;
  readonly output?: string;
  readonly error?: string;
  readonly agentCalls: AgentCallView[];
  readonly reply: ReplyView;
}
