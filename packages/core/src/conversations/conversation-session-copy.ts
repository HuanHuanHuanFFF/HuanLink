import type {
  ChannelConversationRoute,
  InboundChannelMessage,
} from "../channels/contract.js";

import type {
  ConversationJsonValue,
  ConversationSession,
  ConversationSessionMetadata,
  ConversationTimelineEntry,
} from "./conversation-session.js";

type ConversationSessionSource = {
  metadata: ConversationSessionMetadata;
  timeline: readonly ConversationTimelineEntry[];
};

/** 返回 Session 的深层防御性副本。 */
export function cloneConversationSession(
  session: ConversationSessionSource,
): ConversationSession {
  return {
    metadata: {
      kind: session.metadata.kind,
      route: cloneChannelConversationRoute(session.metadata.route),
      contentFormat: session.metadata.contentFormat,
    },
    timeline: session.timeline.map(cloneConversationTimelineEntry),
  };
}

/** 返回固定 Session 元数据的防御性副本。 */
export function cloneConversationSessionMetadata(
  metadata: ConversationSessionMetadata,
): ConversationSessionMetadata {
  return {
    kind: metadata.kind,
    route: cloneChannelConversationRoute(metadata.route),
    contentFormat: metadata.contentFormat,
  };
}

/** 复制一条规范入站消息及其嵌套元数据。 */
export function cloneInboundChannelMessage(
  message: InboundChannelMessage,
): InboundChannelMessage {
  return {
    ...message,
    route: cloneChannelConversationRoute(message.route),
    sender: { ...message.sender },
    ...(message.contentOmitted === undefined
      ? {}
      : { contentOmitted: { ...message.contentOmitted } }),
    ...(message.trigger === undefined
      ? {}
      : { trigger: { ...message.trigger } }),
  };
}

/** 复制规范路由，避免调用方改写 Store 内部元数据。 */
export function cloneChannelConversationRoute(
  route: ChannelConversationRoute,
): ChannelConversationRoute {
  return { ...route };
}

/** 校验并复制 Tool 参数对象。 */
export function cloneConversationJsonRecord(
  value: Readonly<Record<string, ConversationJsonValue>>,
  label: string,
): Readonly<Record<string, ConversationJsonValue>> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      cloneConversationJsonValue(item, `${label}.${key}`),
    ]),
  );
}

/** 校验并深复制可进入会话历史的 JSON 值。 */
export function cloneConversationJsonValue(
  value: ConversationJsonValue,
  label: string,
): ConversationJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cloneConversationJsonValue(item, `${label}[${index}]`),
    );
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneConversationJsonValue(item, `${label}.${key}`),
      ]),
    );
  }
  throw new Error(`${label} must be JSON-compatible`);
}

function cloneConversationTimelineEntry(
  entry: ConversationTimelineEntry,
): ConversationTimelineEntry {
  switch (entry.type) {
    case "channel_message":
      return {
        ...entry,
        ...(entry.observed === undefined
          ? {}
          : { observed: cloneInboundChannelMessage(entry.observed) }),
        ...(entry.outbound === undefined
          ? {}
          : { outbound: { ...entry.outbound } }),
      };
    case "agent_tool_call":
      return {
        ...entry,
        arguments: cloneConversationJsonRecord(
          entry.arguments,
          "Agent Tool Call arguments",
        ),
      };
    case "agent_tool_result":
      return {
        ...entry,
        output: cloneConversationJsonValue(
          entry.output,
          "Agent Tool Result output",
        ),
      };
  }
}

function isPlainObject(
  value: unknown,
): value is Record<string, ConversationJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
