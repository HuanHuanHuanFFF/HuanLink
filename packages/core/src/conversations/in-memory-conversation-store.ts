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
        messages: [cloneMessage(message)]
      });
      return;
    }

    assertSameRoute(sessionId, existing.route, route);
    existing.messages.push(cloneMessage(message));
    if (existing.messages.length > this.maxMessagesPerSession) {
      existing.messages.splice(
        0,
        existing.messages.length - this.maxMessagesPerSession
      );
    }
  }

  getMessages(sessionId: SessionId): InboundChannelMessage[] {
    return (this.conversations.get(sessionId)?.messages ?? []).map(cloneMessage);
  }

  getRoute(sessionId: SessionId): ChannelConversationRoute | undefined {
    const route = this.conversations.get(sessionId)?.route;
    return route === undefined ? undefined : { ...route };
  }

  formatLatestContext(sessionId: SessionId): string {
    return (this.conversations.get(sessionId)?.messages ?? [])
      .map((message) => `${message.senderName}: ${message.text}`)
      .join("\n");
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
