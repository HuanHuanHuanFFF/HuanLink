import type { InboundChannelMessage } from "../channels/contract.js";
import type { SessionId } from "../shared/ids.js";

import type {
  AppendConversationAgentToolCall,
  AppendConversationAgentToolResult,
  ConversationSession,
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
  getSession(sessionId: SessionId): ConversationSession | undefined;
  getSessionMetadata(
    sessionId: SessionId,
  ): ConversationSessionMetadata | undefined;
}
