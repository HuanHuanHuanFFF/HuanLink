import type { SessionId } from "../shared/ids.js";

import type { ChannelConversationRoute } from "./channel-instance.js";
import { assertValidChannelConversationRoute } from "./channel-validation.js";

export function channelSessionIdFor(
  route: ChannelConversationRoute,
): SessionId {
  assertValidChannelConversationRoute(route);

  const channelId = encodeURIComponent(route.channelId);
  const conversationId = encodeURIComponent(route.conversationId);
  const base = `channel:${channelId}:${route.conversationKind}:${conversationId}`;
  return route.threadId === undefined
    ? base
    : `${base}:thread:${encodeURIComponent(route.threadId)}`;
}
