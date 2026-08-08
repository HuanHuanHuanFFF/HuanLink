import type { SessionId } from "../shared/ids.js";

import type { ChannelConversationRouteV1 } from "./channel-instance-v1.js";
import { assertValidChannelConversationRoute } from "./channel-validation-v1.js";

export function channelSessionIdFor(
  route: ChannelConversationRouteV1,
): SessionId {
  assertValidChannelConversationRoute(route);

  const channelId = encodeURIComponent(route.channelId);
  const conversationId = encodeURIComponent(route.conversationId);
  const base = `channel:${channelId}:${route.conversationKind}:${conversationId}`;
  return route.threadId === undefined
    ? base
    : `${base}:thread:${encodeURIComponent(route.threadId)}`;
}
