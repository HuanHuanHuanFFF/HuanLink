import type { AgentCallReader, AgentCallRecord, SessionId } from "@huanlink/core";

export type TaskRecordResolution =
  | { status: "found"; record: AgentCallRecord }
  | { status: "not-found" }
  | { status: "ambiguous" };

export function resolveTaskRecord(
  reader: AgentCallReader,
  taskId: string,
  sessionId: SessionId
): TaskRecordResolution {
  const candidates = [
    reader.getByAgentCallId(taskId),
    reader.getByTaskId(taskId)
  ].filter(
    (candidate): candidate is AgentCallRecord =>
      candidate !== undefined && candidate.sessionId === sessionId
  );
  const recordsByAgentCallId = new Map(
    candidates.map((candidate) => [candidate.agentCallId, candidate])
  );
  if (recordsByAgentCallId.size === 0) {
    return { status: "not-found" };
  }
  if (recordsByAgentCallId.size > 1) {
    return { status: "ambiguous" };
  }
  return {
    status: "found",
    record: recordsByAgentCallId.values().next().value!
  };
}
