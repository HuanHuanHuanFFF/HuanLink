import { randomUUID } from "node:crypto";

import { CORE_SCHEMA_VERSION } from "./types.js";
import type { AgentEvent, AgentEventDraft } from "./types.js";

// 根据 EventLog 分配的 seq，把 draft 补齐成完整 AgentEvent。
export function completeAgentEvent(
  draft: AgentEventDraft,
  seq: number
): AgentEvent {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    id: randomUUID(),
    seq,
    timestamp: new Date().toISOString(),
    type: draft.type,
    runId: draft.runId,
    sessionId: draft.sessionId,
    data: draft.data
  } as AgentEvent;
}
