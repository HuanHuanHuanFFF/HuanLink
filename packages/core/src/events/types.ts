// HuanLink 外层编排事件 schema。
import type { AgentCallTaskState } from "../agent-call/types.js";
import type { ChannelTrigger } from "../channels/types.js";
import type { AgentRuntimeTrigger } from "../runtime/agent-runtime.js";
import type { AgentCallId, RunId, SessionId } from "../shared/ids.js";
import type { TaskExecutionMode } from "../tasks/types.js";

export const CORE_SCHEMA_VERSION = "2.0" as const;

export type CoreSchemaVersion = typeof CORE_SCHEMA_VERSION;

export const AGENT_EVENT_TYPES = [
  "channel.message.received",
  "main_agent.run.started",
  "main_agent.run.completed",
  "main_agent.run.failed",
  "main_agent.run.cancelled",
  "agent_call.created",
  "agent_call.state.changed",
  "channel.reply.sent",
  "channel.reply.failed"
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentCallCause = {
  agentCallId: AgentCallId;
  taskId: string;
  state: AgentCallTaskState;
};

export type AgentEventDataByType = {
  "channel.message.received": {
    channel: "onebot11";
    conversationId: string;
    messageId: string;
    senderId: string;
    senderName: string;
    text: string;
    trigger?: ChannelTrigger;
  };
  "main_agent.run.started": {
    trigger?: AgentRuntimeTrigger;
    cause?: AgentCallCause;
  };
  "main_agent.run.completed": {
    output: string;
  };
  "main_agent.run.failed": {
    error: string;
  };
  "main_agent.run.cancelled": {
    reason: string;
  };
  "agent_call.created": {
    agentCallId: AgentCallId;
    taskId: string;
    skillId: string;
    executionMode: TaskExecutionMode;
    state: AgentCallTaskState;
  };
  "agent_call.state.changed": {
    agentCallId: AgentCallId;
    taskId: string;
    state: AgentCallTaskState;
  };
  "channel.reply.sent": {
    conversationId: string;
    text: string;
  };
  "channel.reply.failed": {
    conversationId: string;
    text: string;
    error: string;
  };
};

export type AgentEventDraftOf<Type extends AgentEventType> = {
  type: Type;
  runId: RunId;
  sessionId: SessionId;
  data: AgentEventDataByType[Type];
};

export type AgentEventDraft = {
  [Type in AgentEventType]: AgentEventDraftOf<Type>;
}[AgentEventType];

export type AgentEventOf<Type extends AgentEventType> =
  AgentEventDraftOf<Type> & {
    schemaVersion: CoreSchemaVersion;
    id: string;
    seq: number;
    timestamp: string;
  };

export type AgentEvent = {
  [Type in AgentEventType]: AgentEventOf<Type>;
}[AgentEventType];
