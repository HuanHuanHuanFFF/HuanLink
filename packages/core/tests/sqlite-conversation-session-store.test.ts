import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  SqliteConversationSessionStore,
  type ConversationSessionStore,
  type InboundChannelMessageV1,
  type RecordConversationOutboundDelivery,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const openStores: SqliteConversationSessionStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(databasePath = ":memory:"): SqliteConversationSessionStore {
  const store = new SqliteConversationSessionStore(databasePath);
  openStores.push(store);
  return store;
}

function inboundMessage(
  messageId: string,
  overrides: Partial<InboundChannelMessageV1> = {},
): InboundChannelMessageV1 {
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

function appendToolCall(
  store: ConversationSessionStore,
  sessionId = "session-a",
  messageId = "message-1",
): void {
  if (store.getSession(sessionId) === undefined) {
    store.appendChannelMessage(sessionId, inboundMessage(messageId));
  }
  store.appendAgentToolCall(sessionId, {
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "reply",
    arguments: { content: "done" },
  });
}

function outboundDelivery(
  overrides: Partial<RecordConversationOutboundDelivery> = {},
): RecordConversationOutboundDelivery {
  return {
    route: inboundMessage("unused").route,
    contentFormat: "onebot11.cq",
    receipt: { channelId: "qq-main", messageId: "message-2" },
    sentAt: "2026-08-08T08:01:00.000Z",
    runId: "run-1",
    toolCallId: "call-1",
    sourceSessionId: "session-a",
    ...overrides,
  };
}

describe("SqliteConversationSessionStore", () => {
  test("persists a channel session after closing and reopening the same file", () => {
    const directory = mkdtempSync(join(tmpdir(), "huanlink-sqlite-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const message = inboundMessage("message-1");

    const first = openStore(databasePath);
    expect(first.appendChannelMessage("session-a", message)).toBe("appended");
    first.close();

    const reopened = openStore(databasePath);
    expect(reopened.getSession("session-a")).toEqual({
      metadata: {
        kind: "external_channel",
        route: message.route,
        contentFormat: "onebot11.cq",
      },
      timeline: [
        {
          type: "channel_message",
          channelId: "qq-main",
          messageId: "message-1",
          observed: message,
        },
      ],
    });
    reopened.close();
  });

  test("persists a Tool Call and adjacent Tool Result after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "huanlink-sqlite-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const first = openStore(databasePath);
    first.appendChannelMessage("session-a", inboundMessage("message-1"));
    first.appendAgentToolCall("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      arguments: { content: "done" },
    });
    first.appendChannelMessage(
      "session-a",
      inboundMessage("message-2", {
        sender: { id: "30003", username: "HuanLink", isSelf: true },
        content: "done",
      }),
    );
    first.appendAgentToolResult("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      output: { status: "sent", messageId: "message-2" },
    });
    first.close();

    const reopened = openStore(databasePath);
    expect(reopened.getSession("session-a")?.timeline).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-1",
        observed: inboundMessage("message-1"),
      },
      {
        type: "agent_tool_call",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "done" },
      },
      {
        type: "agent_tool_result",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent", messageId: "message-2" },
      },
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-2",
        observed: inboundMessage("message-2", {
          sender: { id: "30003", username: "HuanLink", isSelf: true },
          content: "done",
        }),
      },
    ]);
    reopened.close();
  });

  test("returns fixed metadata and defensive session copies", () => {
    const store: ConversationSessionStore = openStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    const metadata = store.getSessionMetadata("session-a");
    expect(metadata).toEqual({
      kind: "external_channel",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      contentFormat: "onebot11.cq",
    });
    (metadata!.route as { conversationId: string }).conversationId = "mutated";
    const session = store.getSession("session-a")!;
    const entry = session.timeline[0];
    if (entry?.type !== "channel_message" || entry.observed === undefined) {
      throw new Error("expected an observed channel message");
    }
    (entry.observed.sender as { username: string }).username = "mutated";

    expect(store.getSessionMetadata("session-a")?.route.conversationId).toBe(
      "10001",
    );
    const reloaded = store.getSession("session-a")?.timeline[0];
    expect(
      reloaded?.type === "channel_message"
        ? reloaded.observed?.sender.username
        : undefined,
    ).toBe("Alice");
  });

  test("deduplicates identical Channel facts and rejects conflicting facts", () => {
    const store = openStore();
    const message = inboundMessage("message-1");
    const identical = {
      ...message,
      route: { ...message.route },
      sender: { ...message.sender },
    };

    expect(store.appendChannelMessage("session-a", message)).toBe("appended");
    expect(store.appendChannelMessage("session-a", identical)).toBe(
      "duplicate",
    );
    expect(() =>
      store.appendChannelMessage(
        "session-a",
        inboundMessage("message-1", { content: "changed" }),
      ),
    ).toThrow(/message-1.*conflicts with existing observed facts/i);
    expect(store.getSession("session-a")?.timeline).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-1",
        observed: message,
      },
    ]);
    store.close();
  });

  test("rejects route and content-format drift within a session", () => {
    const store = openStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    expect(() =>
      store.appendChannelMessage(
        "session-a",
        inboundMessage("message-2", {
          route: {
            channelId: "qq-main",
            conversationKind: "group",
            conversationId: "different-group",
          },
        }),
      ),
    ).toThrow(/session-a.*route/i);
    expect(() =>
      store.appendChannelMessage(
        "session-a",
        inboundMessage("message-3", { contentFormat: "other.format" }),
      ),
    ).toThrow(/session-a.*content format/i);
    expect(store.getSession("session-a")?.timeline).toHaveLength(1);
    store.close();
  });

  test("persists a pending delivery and associates the later self event after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "huanlink-sqlite-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const first = openStore(databasePath);
    appendToolCall(first);

    first.recordOutboundDelivery("session-a", outboundDelivery());
    expect(
      first
        .getSession("session-a")
        ?.timeline.some(
          (entry) =>
            entry.type === "channel_message" && entry.messageId === "message-2",
        ),
    ).toBe(false);
    first.close();

    const reopened = openStore(databasePath);
    const selfEvent = inboundMessage("message-2", {
      sender: { id: "30003", username: "HuanLink", isSelf: true },
      receivedAt: "2026-08-08T08:01:01.000Z",
      content: "done",
    });
    expect(reopened.appendChannelMessage("session-a", selfEvent)).toBe(
      "appended",
    );
    expect(reopened.getSession("session-a")?.timeline.at(-1)).toEqual({
      type: "channel_message",
      channelId: "qq-main",
      messageId: "message-2",
      observed: selfEvent,
      outbound: {
        sentAt: "2026-08-08T08:01:00.000Z",
        runId: "run-1",
        toolCallId: "call-1",
        sourceSessionId: "session-a",
        origin: "current_session",
      },
    });
  });

  test("associates an earlier self event with a later cross-session delivery after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "huanlink-sqlite-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "conversation.sqlite");
    const first = openStore(databasePath);
    const sourceRoute = {
      channelId: "qq-main",
      conversationKind: "group" as const,
      conversationId: "20002",
    };
    first.appendChannelMessage(
      "source-session",
      inboundMessage("source-message", { route: sourceRoute }),
    );
    first.appendAgentToolCall("source-session", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "onebot_standard",
      arguments: { operation: "send_group_message" },
    });
    const selfEvent = inboundMessage("message-2", {
      sender: { id: "30003", username: "HuanLink", isSelf: true },
      content: "done",
    });
    first.appendChannelMessage("session-a", selfEvent);
    first.close();

    const reopened = openStore(databasePath);
    reopened.recordOutboundDelivery(
      "session-a",
      outboundDelivery({
        sourceSessionId: "source-session",
        toolCallId: "call-1",
      }),
    );
    reopened.close();

    const persisted = openStore(databasePath);
    expect(persisted.getSession("session-a")?.timeline).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-2",
        observed: selfEvent,
        outbound: {
          sentAt: "2026-08-08T08:01:00.000Z",
          runId: "run-1",
          toolCallId: "call-1",
          sourceSessionId: "source-session",
          origin: "cross_session",
        },
      },
    ]);
  });

  test("keeps identical outbound receipts idempotent and rejects conflicting facts", () => {
    const store = openStore();
    appendToolCall(store);
    store.appendAgentToolCall("session-a", {
      runId: "run-1",
      toolCallId: "call-2",
      toolName: "reply",
      arguments: { content: "other" },
    });
    const delivery = outboundDelivery();

    store.recordOutboundDelivery("session-a", delivery);
    expect(() =>
      store.recordOutboundDelivery("session-a", delivery),
    ).not.toThrow();
    expect(() =>
      store.recordOutboundDelivery(
        "session-a",
        outboundDelivery({ toolCallId: "call-2" }),
      ),
    ).toThrow(/message-2.*different outbound association/i);
  });

  test("rolls back a pending association when the observed event is not self", () => {
    const store = openStore();
    appendToolCall(store);
    store.recordOutboundDelivery("session-a", outboundDelivery());

    expect(() =>
      store.appendChannelMessage("session-a", inboundMessage("message-2")),
    ).toThrow(/outbound delivery.*not self/i);
    expect(
      store
        .getSession("session-a")
        ?.timeline.some(
          (entry) =>
            entry.type === "channel_message" && entry.messageId === "message-2",
        ),
    ).toBe(false);

    expect(
      store.appendChannelMessage(
        "session-a",
        inboundMessage("message-2", {
          sender: { id: "30003", username: "HuanLink", isSelf: true },
        }),
      ),
    ).toBe("appended");
  });

  test("rejects a delivery whose source Tool Call does not exist", () => {
    const store = openStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    expect(() =>
      store.recordOutboundDelivery("session-a", outboundDelivery()),
    ).toThrow(
      /source Tool Call run-1 \/ call-1 does not exist in session session-a/,
    );
  });

  test("enforces Tool identity and keeps failed writes out of the timeline", () => {
    const store = openStore();
    appendToolCall(store);

    expect(() =>
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: {},
      }),
    ).toThrow(/already exists/i);
    expect(() =>
      store.appendAgentToolResult("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "different-tool",
        output: { status: "error" },
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      store.appendAgentToolResult("session-a", {
        runId: "run-1",
        toolCallId: "missing-call",
        toolName: "reply",
        output: null,
      }),
    ).toThrow(/has no Tool Call/i);
    expect(store.getSession("session-a")?.timeline).toHaveLength(2);

    store.appendAgentToolResult("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      output: { status: "sent" },
    });
    expect(() =>
      store.appendAgentToolResult("session-a", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent" },
      }),
    ).toThrow(/already exists/i);
    expect(store.getSession("session-a")?.timeline).toHaveLength(3);
  });

  test("allows the same Tool Call ID in different runs", () => {
    const store = openStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    for (const runId of ["run-1", "run-2"]) {
      store.appendAgentToolCall("session-a", {
        runId,
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { runId },
      });
      store.appendAgentToolResult("session-a", {
        runId,
        toolCallId: "call-1",
        toolName: "reply",
        output: { runId },
      });
    }

    expect(
      store
        .getSession("session-a")
        ?.timeline.filter((entry) => entry.type !== "channel_message")
        .map((entry) => [entry.type, entry.runId]),
    ).toEqual([
      ["agent_tool_call", "run-1"],
      ["agent_tool_result", "run-1"],
      ["agent_tool_call", "run-2"],
      ["agent_tool_result", "run-2"],
    ]);
  });

  test("keeps delimiter-containing channel and message IDs distinct", () => {
    const store = openStore();
    store.appendChannelMessage(
      "session-a",
      inboundMessage("b\u0000c", {
        route: {
          channelId: "a",
          conversationKind: "group",
          conversationId: "10001",
        },
      }),
    );
    store.appendChannelMessage(
      "session-b",
      inboundMessage("c", {
        route: {
          channelId: "a\u0000b",
          conversationKind: "group",
          conversationId: "10002",
        },
      }),
    );

    expect(store.getSession("session-a")?.timeline).toHaveLength(1);
    expect(store.getSession("session-b")?.timeline).toHaveLength(1);
  });
});
