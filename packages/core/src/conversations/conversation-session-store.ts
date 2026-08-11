import type { InboundChannelMessage } from "../channels/contract.js";
import type { RunId, SessionId } from "../shared/ids.js";

import type {
  AppendConversationAgentToolCall,
  AppendConversationAgentToolResult,
  ConversationAgentToolCallEntry,
  ConversationSession,
  ConversationSessionContextWindow,
  ConversationSessionMetadata,
  RecordConversationOutboundDelivery,
} from "./conversation-session.js";

/** Conversation facts exposed to orchestration, independent of storage. */
export interface ConversationSessionStore {
  appendChannelMessage(
    sessionId: SessionId,
    message: InboundChannelMessage,
  ): "appended" | "duplicate" | "associated";
  recordOutboundDelivery(
    targetSessionId: SessionId,
    delivery: RecordConversationOutboundDelivery,
  ): void;
  appendAgentToolCall(
    sessionId: SessionId,
    call: AppendConversationAgentToolCall,
  ): void;
  appendAgentToolResult(
    sessionId: SessionId,
    result: AppendConversationAgentToolResult,
  ): void;
  getAgentToolCall(
    sessionId: SessionId,
    runId: RunId,
    toolCallId: string,
  ): ConversationAgentToolCallEntry | undefined;
  getSession(sessionId: SessionId): ConversationSession | undefined;
  getSessionContextWindow(
    sessionId: SessionId,
  ): ConversationSessionContextWindow | undefined;
  getSessionMetadata(
    sessionId: SessionId,
  ): ConversationSessionMetadata | undefined;
}
