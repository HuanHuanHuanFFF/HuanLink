import {
  assertValidChannelConversationRoute,
  assertValidInboundChannelMessage,
  type ChannelConversationRoute,
  type InboundChannelMessage,
} from "../channels/contract.js";

import {
  cloneConversationJsonRecord,
  cloneConversationJsonValue,
} from "./conversation-session-copy.js";
import {
  assertValidConversationOutboundDelivery,
  type PendingConversationOutboundDelivery,
} from "./conversation-session-facts.js";
import type {
  ConversationSessionMetadata,
  ConversationTimelineEntry,
} from "./conversation-session.js";
import {
  requireConversationIdentifier,
  validateConversationToolIdentity,
} from "./conversation-session-validation.js";

export type SqliteSessionRow = {
  kind: string;
  route_json: string;
  content_format: string;
};

export type SqliteMessageRow = {
  session_id: string;
  entry_index: number;
  observed_json: string;
};

export type SqliteEntryRow = {
  entry_index: number;
  payload_json: string;
};

export type SqliteToolCallRow = {
  tool_name: string;
  entry_index: number;
};

export type SqliteOutboundDeliveryRow = { payload_json: string };

/** Decodes and validates a platform-observed message from SQLite. */
export function parseSqliteStoredMessage(
  row: Pick<SqliteMessageRow, "observed_json">,
): InboundChannelMessage {
  const message = JSON.parse(row.observed_json) as InboundChannelMessage;
  assertValidInboundChannelMessage(message);
  return message;
}

/** Decodes and validates one persisted Conversation timeline entry. */
export function parseSqliteStoredEntry(
  row: Pick<SqliteEntryRow, "payload_json">,
): ConversationTimelineEntry {
  const entry = JSON.parse(row.payload_json) as ConversationTimelineEntry;
  switch (entry.type) {
    case "channel_message":
      requireConversationIdentifier(entry.channelId, "Channel entry channelId");
      requireConversationIdentifier(entry.messageId, "Channel entry messageId");
      if (entry.observed === undefined) {
        throw new Error("SQLite channel entry is invalid");
      }
      assertValidInboundChannelMessage(entry.observed);
      if (
        entry.channelId !== entry.observed.route.channelId ||
        entry.messageId !== entry.observed.messageId
      ) {
        throw new Error("SQLite channel entry identity is inconsistent");
      }
      if (entry.outbound !== undefined) {
        assertValidConversationOutboundDelivery(entry.outbound);
      }
      return entry;
    case "agent_tool_call":
      validateConversationToolIdentity(entry, "Agent Tool Call");
      cloneConversationJsonRecord(entry.arguments, "Agent Tool Call arguments");
      return entry;
    case "agent_tool_result":
      validateConversationToolIdentity(entry, "Agent Tool Result");
      cloneConversationJsonValue(entry.output, "Agent Tool Result output");
      return entry;
    default:
      throw new Error("SQLite conversation entry type is unsupported");
  }
}

/** Decodes fixed Session metadata and rejects corrupt stored routes. */
export function parseSqliteSessionMetadata(
  row: SqliteSessionRow,
): ConversationSessionMetadata {
  if (row.kind !== "external_channel") {
    throw new Error("SQLite conversation session has an unsupported kind");
  }
  const route = JSON.parse(row.route_json) as ChannelConversationRoute;
  assertValidChannelConversationRoute(route);
  requireConversationIdentifier(
    row.content_format,
    "Conversation content format",
  );
  return {
    kind: "external_channel",
    route,
    contentFormat: row.content_format,
  };
}

/** Decodes a pending delivery and verifies its derived origin. */
export function parseSqlitePendingOutboundDelivery(
  row: SqliteOutboundDeliveryRow,
): PendingConversationOutboundDelivery {
  const pending = JSON.parse(
    row.payload_json,
  ) as PendingConversationOutboundDelivery;
  requireConversationIdentifier(
    pending.targetSessionId,
    "Target conversation sessionId",
  );
  assertValidChannelConversationRoute(pending.route);
  requireConversationIdentifier(
    pending.contentFormat,
    "Conversation content format",
  );
  assertValidConversationOutboundDelivery(pending.outbound);
  const expectedOrigin =
    pending.outbound.sourceSessionId === pending.targetSessionId
      ? "current_session"
      : "cross_session";
  if (pending.outbound.origin !== expectedOrigin) {
    throw new Error("SQLite outbound delivery origin is inconsistent");
  }
  return pending;
}
