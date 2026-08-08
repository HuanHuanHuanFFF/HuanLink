import {
  assertValidChannelConversationRoute,
  type ChannelConversationRouteV1,
  type InboundChannelMessageV1,
} from "../channels/contract-v1.js";
import type { SessionId } from "../shared/ids.js";

import { cloneChannelConversationRoute } from "./conversation-session-copy.js";
import type {
  ConversationOutboundDelivery,
  RecordConversationOutboundDelivery,
} from "./conversation-session.js";
import {
  isSameConversationRoute,
  requireConversationIdentifier,
  requireConversationUtcTimestamp,
} from "./conversation-session-validation.js";

/** A delivery receipt waiting for its platform-observed public message. */
export type PendingConversationOutboundDelivery = {
  readonly targetSessionId: SessionId;
  readonly route: ChannelConversationRouteV1;
  readonly contentFormat: string;
  readonly outbound: ConversationOutboundDelivery;
};

/** Validates the trusted fields used to correlate an outbound receipt. */
export function validateConversationOutboundDeliveryRecord(
  targetSessionId: SessionId,
  delivery: RecordConversationOutboundDelivery,
): void {
  requireConversationIdentifier(
    targetSessionId,
    "Target conversation sessionId",
  );
  assertValidChannelConversationRoute(delivery.route);
  requireConversationIdentifier(
    delivery.contentFormat,
    "Conversation content format",
  );
  requireConversationIdentifier(
    delivery.receipt.channelId,
    "Delivery receipt channelId",
  );
  requireConversationIdentifier(
    delivery.receipt.messageId,
    "Delivery receipt messageId",
  );
  requireConversationUtcTimestamp(delivery.sentAt, "Outbound delivery sentAt");
  requireConversationIdentifier(delivery.runId, "Outbound delivery runId");
  requireConversationIdentifier(
    delivery.toolCallId,
    "Outbound delivery toolCallId",
  );
  requireConversationIdentifier(
    delivery.sourceSessionId,
    "Outbound delivery sourceSessionId",
  );
  if (delivery.receipt.channelId !== delivery.route.channelId) {
    throw new Error(
      "Delivery receipt channelId must match the target route channelId",
    );
  }
}

/** Builds the canonical pending fact after validation. */
export function createPendingConversationOutboundDelivery(
  targetSessionId: SessionId,
  delivery: RecordConversationOutboundDelivery,
): PendingConversationOutboundDelivery {
  return {
    targetSessionId,
    route: cloneChannelConversationRoute(delivery.route),
    contentFormat: delivery.contentFormat,
    outbound: {
      sentAt: delivery.sentAt,
      runId: delivery.runId,
      toolCallId: delivery.toolCallId,
      sourceSessionId: delivery.sourceSessionId,
      origin:
        delivery.sourceSessionId === targetSessionId
          ? "current_session"
          : "cross_session",
    },
  };
}

/** Validates an outbound association read from durable storage. */
export function assertValidConversationOutboundDelivery(
  outbound: ConversationOutboundDelivery,
): void {
  requireConversationUtcTimestamp(outbound.sentAt, "Outbound delivery sentAt");
  requireConversationIdentifier(outbound.runId, "Outbound delivery runId");
  requireConversationIdentifier(
    outbound.toolCallId,
    "Outbound delivery toolCallId",
  );
  requireConversationIdentifier(
    outbound.sourceSessionId,
    "Outbound delivery sourceSessionId",
  );
  if (
    outbound.origin !== "current_session" &&
    outbound.origin !== "cross_session"
  ) {
    throw new Error("Outbound delivery origin is unsupported");
  }
}

/** Ensures an observed message belongs to the target described by a receipt. */
export function assertPendingConversationTarget(
  pending: PendingConversationOutboundDelivery,
  messageKey: string,
  sessionId: SessionId,
  route: ChannelConversationRouteV1,
  contentFormat: string,
): void {
  assertSameChannelMessageSession(
    messageKey,
    sessionId,
    pending.targetSessionId,
  );
  if (!isSameConversationRoute(pending.route, route)) {
    throw new Error(`Conversation session ${sessionId} route cannot change`);
  }
  if (pending.contentFormat !== contentFormat) {
    throw new Error(
      `Conversation session ${sessionId} content format cannot change`,
    );
  }
}

export function isSameInboundChannelMessage(
  left: InboundChannelMessageV1,
  right: InboundChannelMessageV1,
): boolean {
  return (
    left.messageId === right.messageId &&
    isSameConversationRoute(left.route, right.route) &&
    left.sender.id === right.sender.id &&
    left.sender.username === right.sender.username &&
    left.sender.displayName === right.sender.displayName &&
    left.sender.isSelf === right.sender.isSelf &&
    left.receivedAt === right.receivedAt &&
    left.content === right.content &&
    left.contentFormat === right.contentFormat &&
    left.contentOmitted?.reason === right.contentOmitted?.reason &&
    left.contentOmitted?.originalSizeBytes ===
      right.contentOmitted?.originalSizeBytes &&
    left.replyToMessageId === right.replyToMessageId &&
    left.trigger?.kind === right.trigger?.kind
  );
}

export function isSameConversationOutboundDelivery(
  left: ConversationOutboundDelivery,
  right: ConversationOutboundDelivery,
): boolean {
  return (
    left.sentAt === right.sentAt &&
    left.runId === right.runId &&
    left.toolCallId === right.toolCallId &&
    left.sourceSessionId === right.sourceSessionId &&
    left.origin === right.origin
  );
}

export function isSamePendingConversationOutboundDelivery(
  left: PendingConversationOutboundDelivery,
  right: PendingConversationOutboundDelivery,
): boolean {
  return (
    left.targetSessionId === right.targetSessionId &&
    isSameConversationRoute(left.route, right.route) &&
    left.contentFormat === right.contentFormat &&
    isSameConversationOutboundDelivery(left.outbound, right.outbound)
  );
}

export function channelMessageKey(
  channelId: string,
  messageId: string,
): string {
  return JSON.stringify([channelId, messageId]);
}

export function assertSameChannelMessageSession(
  messageKey: string,
  incomingSessionId: SessionId,
  existingSessionId: SessionId,
): void {
  if (incomingSessionId !== existingSessionId) {
    throw new Error(
      `Channel message ${messageKey} belongs to session ${existingSessionId}, not ${incomingSessionId}`,
    );
  }
}
