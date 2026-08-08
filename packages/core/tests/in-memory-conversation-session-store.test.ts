import { describe, expect, test } from "vitest";

import {
  InMemoryConversationSessionStore,
  type InboundChannelMessageV1,
} from "../src/index.js";

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
    receivedAt: "2026-08-02T08:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...overrides,
  };
}

describe("InMemoryConversationSessionStore", () => {
  test("creates fixed session metadata and keeps channel messages as structured entries", () => {
    const store = new InMemoryConversationSessionStore();

    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    expect(store.getSession("session-a")).toEqual({
      metadata: {
        kind: "external_channel",
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "10001",
        },
        contentFormat: "onebot11.cq",
      },
      timeline: [
        {
          type: "channel_message",
          channelId: "qq-main",
          messageId: "message-1",
          observed: inboundMessage("message-1"),
        },
      ],
    });
  });

  test("returns explicit external-channel metadata without copying the timeline", () => {
    const store = new InMemoryConversationSessionStore();
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
    expect(metadata).not.toBe(store.getSession("session-a")?.metadata);
  });

  test("keeps Agent Tool Call and Tool Result as separate structured entries", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    store.appendAgentToolCall("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      arguments: { parts: [{ type: "text", text: "done" }] },
    });
    store.appendAgentToolResult("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      output: {
        status: "sent",
        target: "group:10001",
        messageId: "message-2",
      },
    });

    expect(store.getSession("session-a")?.timeline.slice(1)).toEqual([
      {
        type: "agent_tool_call",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { parts: [{ type: "text", text: "done" }] },
      },
      {
        type: "agent_tool_result",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: {
          status: "sent",
          target: "group:10001",
          messageId: "message-2",
        },
      },
    ]);
  });

  test("allows the same Tool Call ID to be reused by different Agent runs", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    for (const runId of ["run-1", "run-2"]) {
      store.appendAgentToolCall("session-a", {
        runId,
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: runId },
      });
      store.appendAgentToolResult("session-a", {
        runId,
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent", messageId: `${runId}-message` },
      });
    }

    expect(
      store
        .getSession("session-a")
        ?.timeline.filter((entry) => entry.type !== "channel_message"),
    ).toEqual([
      {
        type: "agent_tool_call",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "run-1" },
      },
      {
        type: "agent_tool_result",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent", messageId: "run-1-message" },
      },
      {
        type: "agent_tool_call",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "reply",
        arguments: { content: "run-2" },
      },
      {
        type: "agent_tool_result",
        runId: "run-2",
        toolCallId: "call-1",
        toolName: "reply",
        output: { status: "sent", messageId: "run-2-message" },
      },
    ]);
  });

  test("keeps a Tool Result adjacent to its call when a channel event arrives during execution", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));
    store.appendAgentToolCall("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      arguments: { parts: [{ type: "text", text: "done" }] },
    });
    store.appendChannelMessage(
      "session-a",
      inboundMessage("message-2", {
        sender: { id: "30003", username: "HuanLink", isSelf: true },
        content: "done",
      }),
    );

    store.appendAgentToolResult("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      output: { status: "sent", messageId: "message-2" },
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

  test("merges a successful delivery and later self event by channelId plus messageId", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));
    store.appendAgentToolCall("session-a", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "reply",
      arguments: { parts: [{ type: "text", text: "done" }] },
    });

    store.recordOutboundDelivery("session-a", {
      route: inboundMessage("unused").route,
      contentFormat: "onebot11.cq",
      receipt: { channelId: "qq-main", messageId: "message-2" },
      sentAt: "2026-08-02T08:01:00.000Z",
      runId: "run-1",
      toolCallId: "call-1",
      sourceSessionId: "session-a",
    });

    expect(
      store
        .getSession("session-a")
        ?.timeline.some(
          (entry) =>
            entry.type === "channel_message" && entry.messageId === "message-2",
        ),
    ).toBe(false);

    store.appendChannelMessage(
      "session-a",
      inboundMessage("message-2", {
        sender: {
          id: "30003",
          username: "HuanLink",
          isSelf: true,
        },
        receivedAt: "2026-08-02T08:01:01.000Z",
        content: "done",
      }),
    );

    expect(store.getSession("session-a")?.timeline.slice(2)).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-2",
        observed: inboundMessage("message-2", {
          sender: {
            id: "30003",
            username: "HuanLink",
            isSelf: true,
          },
          receivedAt: "2026-08-02T08:01:01.000Z",
          content: "done",
        }),
        outbound: {
          sentAt: "2026-08-02T08:01:00.000Z",
          runId: "run-1",
          toolCallId: "call-1",
          sourceSessionId: "session-a",
          origin: "current_session",
        },
      },
    ]);
  });

  test("also merges when the self event arrives before the delivery receipt", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage(
      "other-session",
      inboundMessage("source-message", {
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002",
        },
      }),
    );
    store.appendAgentToolCall("other-session", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "onebot_standard",
      arguments: { operation: "send_group_message" },
    });
    const selfEvent = inboundMessage("message-2", {
      sender: { id: "30003", username: "HuanLink", isSelf: true },
      content: "done",
    });

    store.appendChannelMessage("session-a", selfEvent);
    store.recordOutboundDelivery("session-a", {
      route: selfEvent.route,
      contentFormat: selfEvent.contentFormat,
      receipt: { channelId: "qq-main", messageId: "message-2" },
      sentAt: "2026-08-02T08:01:00.000Z",
      runId: "run-1",
      toolCallId: "call-1",
      sourceSessionId: "other-session",
    });

    expect(store.getSession("session-a")?.timeline).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-2",
        observed: selfEvent,
        outbound: {
          sentAt: "2026-08-02T08:01:00.000Z",
          runId: "run-1",
          toolCallId: "call-1",
          sourceSessionId: "other-session",
          origin: "cross_session",
        },
      },
    ]);
  });

  test("rejects an outbound association without its source Tool Call", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));

    expect(() =>
      store.recordOutboundDelivery("session-a", {
        route: inboundMessage("unused").route,
        contentFormat: "onebot11.cq",
        receipt: { channelId: "qq-main", messageId: "message-2" },
        sentAt: "2026-08-02T08:01:00.000Z",
        runId: "run-1",
        toolCallId: "missing-call",
        sourceSessionId: "session-a",
      }),
    ).toThrow(
      /source Tool Call run-1 \/ missing-call does not exist in session session-a/,
    );
  });

  test("accepts identical outbound receipts but rejects conflicting associations", () => {
    const store = new InMemoryConversationSessionStore();
    store.appendChannelMessage("session-a", inboundMessage("message-1"));
    for (const toolCallId of ["call-1", "call-2"]) {
      store.appendAgentToolCall("session-a", {
        runId: "run-1",
        toolCallId,
        toolName: "reply",
        arguments: { content: toolCallId },
      });
    }
    const receipt = {
      route: inboundMessage("unused").route,
      contentFormat: "onebot11.cq",
      receipt: { channelId: "qq-main", messageId: "message-2" },
      sentAt: "2026-08-02T08:01:00.000Z",
      runId: "run-1",
      toolCallId: "call-1",
      sourceSessionId: "session-a",
    } as const;

    store.recordOutboundDelivery("session-a", receipt);
    expect(() =>
      store.recordOutboundDelivery("session-a", receipt),
    ).not.toThrow();
    expect(() =>
      store.recordOutboundDelivery("session-a", {
        ...receipt,
        toolCallId: "call-2",
      }),
    ).toThrow(/message-2.*different outbound association/i);
  });

  test("deduplicates identical channel facts and returns defensive copies", () => {
    const store = new InMemoryConversationSessionStore();
    const message = inboundMessage("message-1");
    const repeated = {
      ...message,
      route: { ...message.route },
      sender: { ...message.sender },
    };

    expect(store.appendChannelMessage("session-a", message)).toBe("appended");
    expect(store.appendChannelMessage("session-a", repeated)).toBe("duplicate");

    const first = store.getSession("session-a")!;
    expect(first.timeline).toHaveLength(1);
    const observed = first.timeline[0];
    if (
      observed?.type !== "channel_message" ||
      observed.observed === undefined
    ) {
      throw new Error("expected an observed channel message");
    }
    (observed.observed.route as { conversationId: string }).conversationId =
      "mutated";
    (observed.observed.sender as { username: string }).username = "mutated";

    expect(store.getSession("session-a")?.metadata.route.conversationId).toBe(
      "10001",
    );
    const second = store.getSession("session-a")?.timeline[0];
    expect(
      second?.type === "channel_message"
        ? second.observed?.sender.username
        : undefined,
    ).toBe("Alice");
  });

  test.each([
    ["content", { content: "changed" }],
    [
      "sender",
      {
        sender: {
          id: "different-user",
          username: "Mallory",
          isSelf: false,
        },
      },
    ],
    [
      "route",
      {
        route: {
          channelId: "qq-main",
          conversationKind: "group" as const,
          conversationId: "different-group",
        },
      },
    ],
  ])(
    "rejects conflicting %s for the same Channel message key",
    (_label, overrides) => {
      const store = new InMemoryConversationSessionStore();
      const original = inboundMessage("message-1");
      store.appendChannelMessage("session-a", original);

      expect(() =>
        store.appendChannelMessage(
          "session-a",
          inboundMessage("message-1", overrides),
        ),
      ).toThrow(/message-1.*conflicts with existing observed facts/i);

      expect(store.getSession("session-a")?.timeline).toEqual([
        {
          type: "channel_message",
          channelId: "qq-main",
          messageId: "message-1",
          observed: original,
        },
      ]);
    },
  );

  test("keeps message identities distinct when IDs contain delimiter characters", () => {
    const store = new InMemoryConversationSessionStore();

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

  test("rejects route or content-format drift inside one session", () => {
    const store = new InMemoryConversationSessionStore();
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
  });
});
