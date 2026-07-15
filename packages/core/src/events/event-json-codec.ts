import { errorMessage } from "../shared/errors.js";
import { AGENT_EVENT_TYPES, CORE_SCHEMA_VERSION } from "./types.js";
import type { AgentEvent, AgentEventType } from "./types.js";
import type { RunId } from "../shared/ids.js";

const EVENT_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "id",
  "seq",
  "timestamp",
  "type",
  "runId",
  "sessionId",
  "data"
]);

const CHANNEL_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "mention",
  "command"
]);

const AGENT_RUNTIME_TRIGGERS: ReadonlySet<string> = new Set([
  "user",
  "agent_call_input_required",
  "agent_call_terminal"
]);

const TASK_EXECUTION_MODES: ReadonlySet<string> = new Set([
  "async",
  "blocking"
]);

const AGENT_CALL_TASK_STATES: ReadonlySet<string> = new Set([
  "unknown",
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected"
]);

export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

export function parseEventsJsonl(content: string, runId: RunId): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmedLine = line.trim();
    if (trimmedLine.length > 0) {
      events.push(parseEventLine(trimmedLine, index + 1, runId));
    }
  }

  return events;
}

function parseEventLine(
  line: string,
  lineNumber: number,
  runId: RunId
): AgentEvent {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse JSONL EventLog line ${lineNumber} for run "${runId}": ${errorMessage(error)}`,
      { cause: error }
    );
  }

  assertAgentEventEnvelope(value, lineNumber, runId);
  return value;
}

function assertAgentEventEnvelope(
  value: unknown,
  lineNumber: number,
  runId: RunId
): asserts value is AgentEvent {
  const record = isRecord(value) ? value : undefined;
  const seq = record?.seq;

  if (
    record === undefined ||
    Object.keys(record).length !== EVENT_ENVELOPE_KEYS.size ||
    Object.keys(record).some((key) => !EVENT_ENVELOPE_KEYS.has(key)) ||
    record.schemaVersion !== CORE_SCHEMA_VERSION ||
    typeof record.id !== "string" ||
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !isTimestamp(record.timestamp) ||
    !isAgentEventType(record.type) ||
    typeof record.runId !== "string" ||
    typeof record.sessionId !== "string" ||
    !isAgentEventData(record.type, record.data)
  ) {
    throw new Error(
      `Invalid JSONL EventLog event envelope on line ${lineNumber} for run "${runId}"`
    );
  }
}

function isAgentEventData(type: AgentEventType, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  switch (type) {
    case "channel.message.received":
      return (
        value.channel === "onebot11" &&
        hasString(value, "conversationId") &&
        hasString(value, "messageId") &&
        hasString(value, "senderId") &&
        hasString(value, "senderName") &&
        hasString(value, "text") &&
        (value.trigger === undefined || isChannelTrigger(value.trigger))
      );
    case "main_agent.run.started":
      return (
        (value.trigger === undefined ||
          isAllowedString(value.trigger, AGENT_RUNTIME_TRIGGERS)) &&
        (value.cause === undefined || isAgentCallCause(value.cause))
      );
    case "main_agent.run.completed":
      return hasString(value, "output");
    case "main_agent.run.failed":
      return hasString(value, "error");
    case "main_agent.run.cancelled":
      return hasString(value, "reason");
    case "agent_call.created":
      return (
        hasString(value, "agentCallId") &&
        hasString(value, "taskId") &&
        hasString(value, "skillId") &&
        isAllowedString(value.executionMode, TASK_EXECUTION_MODES) &&
        isAllowedString(value.state, AGENT_CALL_TASK_STATES)
      );
    case "agent_call.state.changed":
      return (
        hasString(value, "agentCallId") &&
        hasString(value, "taskId") &&
        isAllowedString(value.state, AGENT_CALL_TASK_STATES)
      );
    case "channel.reply.sent":
      return hasString(value, "conversationId") && hasString(value, "text");
    case "channel.reply.failed":
      return (
        hasString(value, "conversationId") &&
        hasString(value, "text") &&
        hasString(value, "error")
      );
  }
}

function isChannelTrigger(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAllowedString(value.kind, CHANNEL_TRIGGER_KINDS) &&
    hasString(value, "text")
  );
}

function isAgentCallCause(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, "agentCallId") &&
    hasString(value, "taskId") &&
    isAllowedString(value.state, AGENT_CALL_TASK_STATES)
  );
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function isAllowedString(
  value: unknown,
  allowedValues: ReadonlySet<string>
): boolean {
  return typeof value === "string" && allowedValues.has(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isAgentEventType(value: unknown): value is AgentEventType {
  return (
    typeof value === "string" &&
    (AGENT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
