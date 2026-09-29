import type { SessionId } from "../shared/ids.js";

import type {
  AppendConversationAgentToolCall,
  AppendConversationAgentToolResult,
} from "./conversation-session.js";
import type { ConversationSessionStore } from "./conversation-session-store.js";

/**
 * Protocol-neutral seam for recording a provider Tool Call/Result pair in a
 * Conversation Session. The caller owns all identifiers and transport work.
 */
export interface SessionToolHistoryRecorder {
  recordToolCall(
    sessionId: SessionId,
    call: AppendConversationAgentToolCall,
  ): void;
  recordToolResult(
    sessionId: SessionId,
    result: AppendConversationAgentToolResult,
  ): void;
}

/** Stores Tool history without generating IDs or emitting runtime logs. */
export class ConversationSessionStoreToolHistoryRecorder implements SessionToolHistoryRecorder {
  constructor(private readonly sessions: ConversationSessionStore) {}

  recordToolCall(
    sessionId: SessionId,
    call: AppendConversationAgentToolCall,
  ): void {
    this.sessions.appendAgentToolCall(sessionId, call);
  }

  recordToolResult(
    sessionId: SessionId,
    result: AppendConversationAgentToolResult,
  ): void {
    this.sessions.appendAgentToolResult(sessionId, result);
  }
}
