import type { ChannelConversationRouteV1 } from "../channels/contract-v1.js";

/** 校验 Session 和 Tool 关联使用的非空标识。 */
export function requireConversationIdentifier(
  value: unknown,
  label: string
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** 校验 Tool Call/Result 的三元关联标识。 */
export function validateConversationToolIdentity(
  value: { runId: string; toolCallId: string; toolName: string },
  label: string
): void {
  requireConversationIdentifier(value.runId, `${label} runId`);
  requireConversationIdentifier(value.toolCallId, `${label} toolCallId`);
  requireConversationIdentifier(value.toolName, `${label} toolName`);
}

/** 比较同一 Session 的固定 Channel 路由。 */
export function isSameConversationRoute(
  left: ChannelConversationRouteV1,
  right: ChannelConversationRouteV1
): boolean {
  return (
    left.channelId === right.channelId &&
    left.conversationKind === right.conversationKind &&
    left.conversationId === right.conversationId &&
    left.threadId === right.threadId
  );
}

/** 校验发送关联使用的 UTC ISO-8601 时间。 */
export function requireConversationUtcTimestamp(
  value: unknown,
  label: string
): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a UTC ISO-8601 timestamp`);
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(
      value
    );
  if (match === null) {
    throw new Error(`${label} must be a UTC ISO-8601 timestamp`);
  }

  const timestamp = new Date(value);
  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.getUTCFullYear() !== Number(match[1]) ||
    timestamp.getUTCMonth() + 1 !== Number(match[2]) ||
    timestamp.getUTCDate() !== Number(match[3]) ||
    timestamp.getUTCHours() !== Number(match[4]) ||
    timestamp.getUTCMinutes() !== Number(match[5]) ||
    timestamp.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(`${label} must be a UTC ISO-8601 timestamp`);
  }
}
