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
    !Number.isInteger(seq) ||
    seq < 1 ||
    typeof record.timestamp !== "string" ||
    !isAgentEventType(record.type) ||
    typeof record.runId !== "string" ||
    typeof record.sessionId !== "string" ||
    !isRecord(record.data)
  ) {
    throw new Error(
      `Invalid JSONL EventLog event envelope on line ${lineNumber} for run "${runId}"`
    );
  }
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
