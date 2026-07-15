import { describe, expect, test, vi } from "vitest";

import {
  InMemoryConversationStore,
  type ChannelAdapter,
  type InboundChannelMessage
} from "../src/index.js";

function message(
  messageId: string,
  overrides: Partial<InboundChannelMessage> = {}
): InboundChannelMessage {
  return {
    channel: "onebot11",
    conversationId: "group-100",
    messageId,
    senderId: `sender-${messageId}`,
    senderName: `Sender ${messageId}`,
    text: `message ${messageId}`,
    receivedAt: "2026-07-12T00:00:00.000Z",
    ...overrides
  };
}

describe("Channel contracts", () => {
  test("support lifecycle, subscriptions, and conversation text output", async () => {
    const listener = vi.fn();
    const unsubscribe = vi.fn();
    const channel: ChannelAdapter = {
      channel: "onebot11",
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onMessage(receive) {
        receive(message("incoming"));
        return unsubscribe;
      },
      sendText: vi.fn(async () => undefined)
    };

    const stopListening = channel.onMessage(listener);
    await channel.start();
    await channel.sendText("group-100", "hello group");
    await channel.close();
    stopListening();

    expect(listener).toHaveBeenCalledWith(message("incoming"));
    expect(channel.sendText).toHaveBeenCalledWith("group-100", "hello group");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("InMemoryConversationStore", () => {
  test("keeps the newest messages in a fixed per-session window", () => {
    const store = new InMemoryConversationStore({
      maxMessagesPerSession: 2
    });

    store.append("session-a", message("1"));
    store.append("session-a", message("2"));
    store.append("session-a", message("3"));

    expect(
      store.getMessages("session-a").map(({ messageId }) => messageId)
    ).toEqual(["2", "3"]);
  });

  test("defaults to the latest 50 messages per session", () => {
    const store = new InMemoryConversationStore();

    for (let index = 1; index <= 51; index += 1) {
      store.append("session-a", message(String(index)));
    }

    const stored = store.getMessages("session-a");
    expect(stored).toHaveLength(50);
    expect(stored[0]?.messageId).toBe("2");
    expect(stored.at(-1)?.messageId).toBe("51");
  });

  test("isolates sessions and includes untriggered messages in deterministic context", () => {
    const store = new InMemoryConversationStore();
    store.append(
      "session-a",
      message("normal", {
        senderName: "Alice",
        text: "ordinary group context"
      })
    );
    store.append(
      "session-a",
      message("trigger", {
        senderName: "Bob",
        text: "please handle this",
        trigger: { kind: "mention", text: "please handle this" }
      })
    );
    store.append(
      "session-b",
      message("other", {
        conversationId: "group-200",
        senderName: "Carol",
        text: "different group"
      })
    );

    expect(store.formatLatestContext("session-a")).toBe(
      "Alice: ordinary group context\nBob: please handle this"
    );
    expect(
      store.getMessages("session-b").map(({ messageId }) => messageId)
    ).toEqual(["other"]);
    expect(store.getRoute("session-a")).toEqual({
      channel: "onebot11",
      conversationId: "group-100"
    });
    expect(store.getRoute("session-b")).toEqual({
      channel: "onebot11",
      conversationId: "group-200"
    });
    expect(store.getMessages("unknown")).toEqual([]);
    expect(store.getRoute("unknown")).toBeUndefined();
    expect(store.formatLatestContext("unknown")).toBe("");
  });

  test("formats inbound and HuanLink outbound entries in their append order", () => {
    const store = new InMemoryConversationStore();
    store.append(
      "session-a",
      message("first", { senderName: "Alice", text: "please inspect it" })
    );
    store.appendOutbound("session-a", "I accepted the task.");
    store.append(
      "session-a",
      message("second", { senderName: "Bob", text: "use the safer option" })
    );
    store.appendOutbound("session-a", "The task is complete.");

    expect(store.formatLatestContext("session-a")).toBe(
      [
        "Alice: please inspect it",
        "HuanLink: I accepted the task.",
        "Bob: use the safer option",
        "HuanLink: The task is complete."
      ].join("\n")
    );
    expect(
      store.getMessages("session-a").map(({ messageId }) => messageId)
    ).toEqual(["first", "second"]);
  });

  test("trims the mixed context window without consuming the inbound window", () => {
    const store = new InMemoryConversationStore({ maxMessagesPerSession: 2 });
    store.append(
      "session-a",
      message("first", { senderName: "Alice", text: "first request" })
    );
    store.appendOutbound("session-a", "first reply");
    store.append(
      "session-a",
      message("second", { senderName: "Bob", text: "second request" })
    );
    store.appendOutbound("session-a", "second reply");

    expect(store.formatLatestContext("session-a")).toBe(
      "Bob: second request\nHuanLink: second reply"
    );
    expect(
      store.getMessages("session-a").map(({ messageId }) => messageId)
    ).toEqual(["first", "second"]);
  });

  test("returns defensive copies including nested trigger and route data", () => {
    const store = new InMemoryConversationStore();
    store.append(
      "session-a",
      message("1", {
        trigger: { kind: "command", text: "original command" }
      })
    );

    const messages = store.getMessages("session-a");
    const route = store.getRoute("session-a");
    messages[0]!.text = "mutated text";
    messages[0]!.trigger!.text = "mutated command";
    route!.conversationId = "mutated group";

    expect(store.getMessages("session-a")[0]).toMatchObject({
      text: "message 1",
      trigger: { kind: "command", text: "original command" }
    });
    expect(store.getRoute("session-a")).toEqual({
      channel: "onebot11",
      conversationId: "group-100"
    });
  });

  test("rejects a different route for an existing session without replacing it", () => {
    const store = new InMemoryConversationStore();
    store.append("session-a", message("1"));

    expect(() =>
      store.append(
        "session-a",
        message("2", { conversationId: "group-200" })
      )
    ).toThrow(/session-a.*group-100.*group-200/);
    expect(store.getRoute("session-a")).toEqual({
      channel: "onebot11",
      conversationId: "group-100"
    });
    expect(
      store.getMessages("session-a").map(({ messageId }) => messageId)
    ).toEqual(["1"]);
  });

  test("rejects a non-positive or fractional message window", () => {
    expect(
      () => new InMemoryConversationStore({ maxMessagesPerSession: 0 })
    ).toThrow(/positive integer/);
    expect(
      () => new InMemoryConversationStore({ maxMessagesPerSession: 1.5 })
    ).toThrow(/positive integer/);
  });
});
