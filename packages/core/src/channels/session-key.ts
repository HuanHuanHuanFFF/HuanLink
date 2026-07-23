import type { SessionId } from "../shared/ids.js";

import type { ChannelConversationRouteV1 } from "./contract-v1.js";

export function channelSessionIdFor(
  route: ChannelConversationRouteV1
): SessionId {
  const channelId = encodeComponent(route.channelId, "channelId");
  const conversationId = encodeComponent(
    route.conversationId,
    "conversationId"
  );
  if (!isConversationKind(route.conversationKind)) {
    throw new Error("conversationKind must be direct, group, or channel");
  }

  const base = `channel:${channelId}:${route.conversationKind}:${conversationId}`;
  return route.threadId === undefined
    ? base
    : `${base}:thread:${encodeComponent(route.threadId, "threadId")}`;
}

function encodeComponent(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return encodeURIComponent(value);
}

function isConversationKind(
  value: string
): value is ChannelConversationRouteV1["conversationKind"] {
  return value === "direct" || value === "group" || value === "channel";
}
