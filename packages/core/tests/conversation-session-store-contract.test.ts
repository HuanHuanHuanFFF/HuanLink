import { afterEach, describe, expect, test } from "vitest";

import {
  InMemoryConversationSessionStore,
  SqliteConversationSessionStore,
  type ConversationSessionStore,
  type InboundChannelMessage,
} from "../src/index.js";

type StoreHandle = {
  readonly store: ConversationSessionStore;
  readonly close?: () => void;
};

function inboundMessage(
  messageId: string,
  overrides: Partial<InboundChannelMessage> = {},
): InboundChannelMessage {
  return {
    messageId,
    route: {
      channelId: "qq-main",
      conversationKind: "group",
      conversationId: "10001",
    },
    sender: {
      id: "20002",
      username: "Alice",
      displayName: "Alice in group",
      isSelf: false,
    },
    receivedAt: "2026-08-08T08:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...overrides,
  };
}

function defineConversationSessionStoreContract(
  name: string,
  factory: () => StoreHandle,
): void {
  describe(`${name} ConversationSessionStore contract`, () => {
    const handles: StoreHandle[] = [];
    const createStore = (): ConversationSessionStore => {
      const handle = factory();
      handles.push(handle);
      return handle.store;
    };

    afterEach(() => {
      for (const handle of handles.splice(0)) {
        handle.close?.();
      }
    });

    test("stores fixed metadata, deduplicates exact facts, and returns copies", () => {
      const store = createStore();
      const message = inboundMessage("message-1");
      expect(store.appendChannelMessage("session-a", message)).toBe("appended");
      expect(
        store.appendChannelMessage("session-a", {
          ...message,
          route: { ...message.route },
          sender: { ...message.sender },
        }),
      ).toBe("duplicate");

      const session = store.getSession("session-a")!;
      expect(session.metadata).toEqual({
        kind: "external_channel",
        route: message.route,
        contentFormat: "onebot11.cq",
      });
      (session.metadata.route as { conversationId: string }).conversationId =
        "mutated";
      expect(store.getSessionMetadata("session-a")?.route.conversationId).toBe(
        "10001",
      );
    });

    test("keeps a late Tool Result adjacent to its matching Tool Call", () => {
      const store = createStore();
      store.appendChannelMessage("session-a", inboundMessage("message-1"));
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "done" },
      });
      store.appendChannelMessage("session-a", inboundMessage("message-2"));
      store.appendAgentToolResult("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent" },
      });

      expect(
        store.getSession("session-a")?.timeline.map(({ type }) => type),
      ).toEqual([
        "channel_message",
        "agent_tool_call",
        "agent_tool_result",
        "channel_message",
      ]);
    });

    test("persists unparseable raw Tool Call arguments without a parsed fallback", () => {
      const store = createStore();
      store.appendChannelMessage("session-a", inboundMessage("message-1"));
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId: "call-raw",
        toolName: "reply",
        rawArguments: '{"content":',
      });

      const entry = store
        .getSession("session-a")
        ?.timeline.find(({ type }) => type === "agent_tool_call");
      expect(entry).toEqual({
        type: "agent_tool_call",
        runId: "run-1",
        toolCallId: "call-raw",
        toolName: "reply",
        rawArguments: '{"content":',
      });
      expect(entry).not.toHaveProperty("arguments");

      expect(() =>
        store.appendAgentToolCall("session-a", {
          runId: "run-1",
          toolCallId: "call-invalid",
          toolName: "reply",
          arguments: { content: "parsed" },
          rawArguments: '{"content":"raw"}',
        } as never),
      ).toThrow(/exactly one of arguments or rawArguments/i);
    });

    test("reads a defensive context window with stable entry indexes", () => {
      const store = createStore();
      const first = inboundMessage("message-1");
      const second = inboundMessage("message-2", { content: "later" });
      store.appendChannelMessage("session-a", first);
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "done" },
      });
      store.appendChannelMessage("session-a", second);
      store.appendAgentToolResult("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent" },
      });

      const window = store.getSessionContextWindow("session-a")!;

      expect(window.summary).toBeUndefined();
      expect(window.entries.map(({ entryIndex }) => entryIndex)).toEqual([
        1024, 2048, 2049, 3072,
      ]);
      expect(window.entries.map(({ entry }) => entry.type)).toEqual([
        "channel_message",
        "agent_tool_call",
        "agent_tool_result",
        "channel_message",
      ]);

      (window.metadata.route as { conversationId: string }).conversationId =
        "mutated";
      const observed = window.entries[0]?.entry;
      if (
        observed?.type === "channel_message" &&
        observed.observed !== undefined
      ) {
        (observed.observed.sender as { username: string }).username = "mutated";
      }

      const reloaded = store.getSessionContextWindow("session-a")!;
      expect(reloaded.metadata.route.conversationId).toBe("10001");
      const reloadedMessage = reloaded.entries[0]?.entry;
      expect(reloadedMessage).toMatchObject({
        type: "channel_message",
        observed: { sender: { username: "Alice" } },
      });
    });

    test("waits for a self event before exposing a successful delivery", () => {
      const store = createStore();
      store.appendChannelMessage("session-a", inboundMessage("message-1"));
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "done" },
      });
      store.recordOutboundDelivery("session-a", {
        route: inboundMessage("unused").route,
        contentFormat: "onebot11.cq",
        receipt: { channelId: "qq-main", messageId: "message-2" },
        sentAt: "2026-08-08T08:01:00.000Z",
        runId: "run-1",
        toolCallId: "call-1",
        sourceSessionId: "session-a",
      });
      expect(store.getSession("session-a")?.timeline).toHaveLength(2);

      const selfEvent = inboundMessage("message-2", {
        sender: { id: "30003", username: "HuanLink", isSelf: true },
        content: "done",
      });
      store.appendChannelMessage("session-a", selfEvent);
      expect(store.getSession("session-a")?.timeline.at(-1)).toMatchObject({
        type: "channel_message",
        observed: selfEvent,
        outbound: { origin: "current_session", toolCallId: "call-1" },
      });
    });

    test("associates a self event that arrives before its cross-session receipt", () => {
      const store = createStore();
      store.appendChannelMessage(
        "source-session",
        inboundMessage("source-message", {
          route: {
            channelId: "qq-main",
            conversationKind: "group",
            conversationId: "20002",
          },
        }),
      );
      store.appendAgentToolCall("source-session", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "onebot_standard",
        arguments: { operation: "send_group_message" },
      });
      const selfEvent = inboundMessage("message-2", {
        sender: { id: "30003", username: "HuanLink", isSelf: true },
      });
      store.appendChannelMessage("session-a", selfEvent);
      store.recordOutboundDelivery("session-a", {
        route: selfEvent.route,
        contentFormat: selfEvent.contentFormat,
        receipt: { channelId: "qq-main", messageId: "message-2" },
        sentAt: "2026-08-08T08:01:00.000Z",
        runId: "run-1",
        toolCallId: "call-1",
        sourceSessionId: "source-session",
      });

      expect(store.getSession("session-a")?.timeline[0]).toMatchObject({
        type: "channel_message",
        outbound: {
          origin: "cross_session",
          sourceSessionId: "source-session",
        },
      });
    });

    test("rejects conflicting message facts and keeps the first observation", () => {
      const store = createStore();
      const original = inboundMessage("message-1");
      store.appendChannelMessage("session-a", original);

      expect(() =>
        store.appendChannelMessage(
          "session-a",
          inboundMessage("message-1", { content: "changed" }),
        ),
      ).toThrow(/conflicts with existing observed facts/i);
      expect(store.getSession("session-a")?.timeline[0]).toMatchObject({
        type: "channel_message",
        observed: original,
      });
    });
  });
}

defineConversationSessionStoreContract("In-memory", () => ({
  store: new InMemoryConversationSessionStore(),
}));

defineConversationSessionStoreContract("SQLite", () => {
  const store = new SqliteConversationSessionStore(":memory:");
  return { store, close: () => store.close() };
});
