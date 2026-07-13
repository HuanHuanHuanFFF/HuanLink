import type {
  ChannelConversationRoute,
  InboundChannelMessage
} from "../channels/types.js";
import type { SessionId } from "../shared/ids.js";

export type InMemoryConversationStoreOptions = {
  maxMessagesPerSession?: number;
};

type Conversation = {
  route: ChannelConversationRoute;
  messages: InboundChannelMessage[];
  timeline: ConversationTimelineEntry[];
};

type ConversationTimelineEntry = {
  senderName: string;
  text: string;
};

const DEFAULT_MAX_MESSAGES_PER_SESSION = 50;

export class InMemoryConversationStore {
  private readonly maxMessagesPerSession: number;
  private readonly conversations = new Map<SessionId, Conversation>();

  constructor(options: InMemoryConversationStoreOptions = {}) {
    this.maxMessagesPerSession =
      options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
    if (
      !Number.isInteger(this.maxMessagesPerSession) ||
      this.maxMessagesPerSession <= 0
    ) {
      throw new Error("maxMessagesPerSession must be a positive integer");
    }
  }

  append(sessionId: SessionId, message: InboundChannelMessage): void {
    const route = routeFromMessage(message);
    const existing = this.conversations.get(sessionId);
    if (existing === undefined) {
      this.conversations.set(sessionId, {
        route,
        messages: [cloneMessage(message)],
        timeline: [timelineEntryFromInbound(message)]
      });
      return;
    }

    assertSameRoute(sessionId, existing.route, route);
    existing.messages.push(cloneMessage(message));
    trimToLatest(existing.messages, this.maxMessagesPerSession);
    existing.timeline.push(timelineEntryFromInbound(message));
    trimToLatest(existing.timeline, this.maxMessagesPerSession);
  }

  appendOutbound(sessionId: SessionId, text: string): void {
    const existing = this.conversations.get(sessionId);
    if (existing === undefined) {
      throw new Error(`Unknown conversation session ${sessionId}`);
    }
    existing.timeline.push({ senderName: "HuanLink", text });
    trimToLatest(existing.timeline, this.maxMessagesPerSession);
  }

  getMessages(sessionId: SessionId): InboundChannelMessage[] {
    return (this.conversations.get(sessionId)?.messages ?? []).map(cloneMessage);
  }

  getRoute(sessionId: SessionId): ChannelConversationRoute | undefined {
    const route = this.conversations.get(sessionId)?.route;
    return route === undefined ? undefined : { ...route };
  }

  formatLatestContext(sessionId: SessionId): string {
    return (this.conversations.get(sessionId)?.timeline ?? [])
      .map((entry) => `${entry.senderName}: ${entry.text}`)
      .join("\n");
  }
}

function timelineEntryFromInbound(
  message: InboundChannelMessage
): ConversationTimelineEntry {
  return { senderName: message.senderName, text: message.text };
}

function trimToLatest<T>(entries: T[], maximum: number): void {
  if (entries.length > maximum) {
    entries.splice(0, entries.length - maximum);
  }
}

function routeFromMessage(
  message: InboundChannelMessage
): ChannelConversationRoute {
  return {
    channel: message.channel,
    conversationId: message.conversationId
  };
}

function cloneMessage(message: InboundChannelMessage): InboundChannelMessage {
  return {
    ...message,
    ...(message.trigger === undefined
      ? {}
      : { trigger: { ...message.trigger } })
  };
}

function assertSameRoute(
  sessionId: SessionId,
  existing: ChannelConversationRoute,
  incoming: ChannelConversationRoute
): void {
  if (
    existing.channel === incoming.channel &&
    existing.conversationId === incoming.conversationId
  ) {
    return;
  }

  throw new Error(
    `Session ${sessionId} is routed to ${existing.channel}:${existing.conversationId}; cannot use ${incoming.channel}:${incoming.conversationId}`
  );
}
