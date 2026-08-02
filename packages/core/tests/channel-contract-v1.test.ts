import { describe, expect, test, vi } from "vitest";

import {
  CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1,
  CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
  ChannelOperationError,
  assertValidChannelConversationRoute,
  assertValidInboundChannelMessage,
  assertValidOutboundChannelMessageParts,
  assertValidRetractChannelMessageCommand,
  assertValidSendChannelMessageCommand,
  channelSessionIdFor,
  type ChannelAdapterV1,
  type ChannelCapabilitiesV1,
  type ChannelConversationRouteV1,
  type ChannelDescriptorV1,
  type ChannelMessageListenerV1,
  type InboundChannelMessageV1,
  type RetractChannelMessageCommandV1,
  type SendChannelMessageCommandV1
} from "../src/index.js";

const capabilities: ChannelCapabilitiesV1 = {
  conversationKinds: ["direct", "group"],
  threads: false,
  inboundContentFormats: ["onebot11.cq"],
  outboundPartTypes: [
    "text",
    "mention",
    "attachmentLink",
    "attachmentLocalPath"
  ],
  reply: true,
  edit: false,
  retract: true,
  reaction: false,
  typing: false,
  streaming: false
};

const descriptor: ChannelDescriptorV1 = {
  channelId: "qq-main",
  platform: "onebot11",
  accountId: "10000",
  capabilities
};

function route(
  overrides: Partial<ChannelConversationRouteV1> = {}
): ChannelConversationRouteV1 {
  return {
    channelId: "qq-main",
    conversationKind: "group",
    conversationId: "20000",
    ...overrides
  };
}

function inbound(
  overrides: Partial<InboundChannelMessageV1> = {}
): InboundChannelMessageV1 {
  return {
    messageId: "message-1",
    route: route(),
    sender: {
      id: "30000",
      username: "Alice",
      displayName: "Alice",
      isSelf: false
    },
    receivedAt: "2026-07-22T00:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...overrides
  };
}

describe("Channel Contract v1", () => {
  test("receives group and direct messages, then sends and retracts through a fake adapter", async () => {
    let listener: ChannelMessageListenerV1 | undefined;
    const receive = vi.fn();
    const stopListening = vi.fn();
    const sendCommand: SendChannelMessageCommandV1 = {
      route: route(),
      parts: [
        { type: "text", text: "result: " },
        {
          type: "attachmentLink",
          kind: "file",
          url: "https://example.com/result.txt",
          name: "result.txt"
        }
      ]
    };
    const adapter: ChannelAdapterV1 = {
      descriptor,
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onMessage(receive) {
        listener = receive;
        return stopListening;
      },
      send: vi.fn(async () => ({
        channelId: descriptor.channelId,
        messageId: "sent-1"
      })),
      retract: vi.fn(async () => undefined)
    };

    const unsubscribe = adapter.onMessage(receive);
    await adapter.start();
    const incomingGroup = inbound();
    const incomingDirect = inbound({
      messageId: "message-2",
      route: route({
        conversationKind: "direct",
        conversationId: "30000"
      })
    });
    listener?.(incomingGroup);
    listener?.(incomingDirect);
    const receipt = await adapter.send(sendCommand);
    const retractCommand: RetractChannelMessageCommandV1 = {
      route: sendCommand.route,
      messageId: receipt.messageId
    };
    await adapter.retract(retractCommand);
    expect(receipt).toEqual({
      channelId: "qq-main",
      messageId: "sent-1"
    });
    await adapter.close();
    unsubscribe();

    expect(adapter.send).toHaveBeenCalledWith(sendCommand);
    expect(adapter.retract).toHaveBeenCalledWith(retractCommand);
    expect(receive).toHaveBeenNthCalledWith(1, incomingGroup);
    expect(receive).toHaveBeenNthCalledWith(2, incomingDirect);
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, null, "", "   ", 123])(
    "rejects an invalid retract messageId %j before calling a platform",
    (messageId) => {
      expect(() =>
        assertValidRetractChannelMessageCommand({
          route: route(),
          messageId
        } as never)
      ).toThrow(/messageId must be a non-empty string/);
    }
  );

  test("accepts an opaque non-empty retract messageId without parsing its format", () => {
    expect(() =>
      assertValidRetractChannelMessageCommand({
        route: route(),
        messageId: "platform:message/42"
      })
    ).not.toThrow();
  });

  test.each([
    {
      name: "non-object",
      value: undefined,
      error: /route must be an object/
    },
    {
      name: "blank channelId",
      value: route({ channelId: " " }),
      error: /channelId must be a non-empty string/
    },
    {
      name: "unsupported conversationKind",
      value: route({ conversationKind: "room" as never }),
      error: /conversationKind must be direct, group, or channel/
    },
    {
      name: "blank conversationId",
      value: route({ conversationId: "" }),
      error: /conversationId must be a non-empty string/
    },
    {
      name: "non-string threadId",
      value: route({ threadId: 123 as never }),
      error: /threadId must be a non-empty string/
    },
    {
      name: "unsupported field",
      value: { ...route(), senderId: "30000" },
      error: /contains unsupported field senderId/
    }
  ])("rejects a Channel route with $name", ({ value, error }) => {
    expect(() => assertValidChannelConversationRoute(value)).toThrow(error);
  });

  test.each([
    {
      boundary: "inbound",
      validate: (invalidRoute: ChannelConversationRouteV1) =>
        assertValidInboundChannelMessage(inbound({ route: invalidRoute }))
    },
    {
      boundary: "send",
      validate: (invalidRoute: ChannelConversationRouteV1) =>
        assertValidSendChannelMessageCommand({
          route: invalidRoute,
          parts: [{ type: "text", text: "hello" }]
        })
    },
    {
      boundary: "retract",
      validate: (invalidRoute: ChannelConversationRouteV1) =>
        assertValidRetractChannelMessageCommand({
          route: invalidRoute,
          messageId: "message-1"
        })
    }
  ])("rejects an invalid route at the $boundary boundary", ({ validate }) => {
    expect(() => validate(route({ conversationId: " " }))).toThrow(
      /conversationId must be a non-empty string/
    );
  });

  test.each([
    "not-a-time",
    "2026-07-22",
    "2026-02-30T00:00:00.000Z"
  ])("rejects an invalid inbound receivedAt %s", (receivedAt) => {
    expect(() =>
      assertValidInboundChannelMessage(inbound({ receivedAt }))
    ).toThrow(/receivedAt must be a UTC ISO-8601 timestamp/);
  });

  test.each([
    "2026-07-22T00:00:00Z",
    "2026-07-22T00:00:00.123Z"
  ])("accepts a valid UTC ISO-8601 receivedAt %s", (receivedAt) => {
    expect(() =>
      assertValidInboundChannelMessage(inbound({ receivedAt }))
    ).not.toThrow();
  });

  test("returns not_supported when an adapter cannot retract messages", async () => {
    const unsupportedAdapter: ChannelAdapterV1 = {
      descriptor: {
        ...descriptor,
        capabilities: {
          ...capabilities,
          retract: false
        }
      },
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onMessage: vi.fn(() => vi.fn()),
      send: vi.fn(async () => ({
        channelId: descriptor.channelId,
        messageId: "sent-1"
      })),
      retract: vi.fn(async () => {
        throw new ChannelOperationError(
          "not_supported",
          "message retraction is not supported"
        );
      })
    };

    await expect(
      unsupportedAdapter.retract({
        route: route(),
        messageId: "sent-1"
      })
    ).rejects.toMatchObject({
      name: "ChannelOperationError",
      code: "not_supported"
    });
  });

  test("isolates sessions by channel, conversation kind, conversation, and thread", () => {
    const group = channelSessionIdFor(route());

    expect(group).toBe("channel:qq-main:group:20000");
    expect(channelSessionIdFor(route())).toBe(group);
    expect(
      channelSessionIdFor(route({ channelId: "qq-secondary" }))
    ).not.toBe(group);
    expect(
      channelSessionIdFor(route({ conversationKind: "direct" }))
    ).not.toBe(group);
    expect(
      channelSessionIdFor(route({ conversationId: "20001" }))
    ).not.toBe(group);
    expect(
      channelSessionIdFor(route({ threadId: "thread:one" }))
    ).toBe("channel:qq-main:group:20000:thread:thread%3Aone");
  });

  test("does not include the sender in a group session key", () => {
    const first = inbound({
      sender: {
        id: "30000",
        username: "alice",
        displayName: "Alice Card",
        isSelf: false
      }
    });
    const second = inbound({
      sender: {
        id: "40000",
        username: "bob",
        displayName: "Bob Card",
        isSelf: false
      }
    });

    expect(channelSessionIdFor(first.route)).toBe(
      channelSessionIdFor(second.route)
    );
  });

  test("keeps the required username separate from an optional conversation display name", () => {
    const message = inbound({
      sender: {
        id: "30000",
        username: "Alice",
        displayName: "Backend-Alice",
        isSelf: true
      }
    });

    expect(message.sender).toEqual({
      id: "30000",
      username: "Alice",
      displayName: "Backend-Alice",
      isSelf: true
    });
  });

  test("requires adapters to identify whether the sender is the channel account", () => {
    expect(() => assertValidInboundChannelMessage(inbound())).not.toThrow();
    expect(() =>
      assertValidInboundChannelMessage(
        inbound({
          sender: {
            id: "10000",
            username: "HuanLink",
            isSelf: true
          }
        })
      )
    ).not.toThrow();

    const withoutIsSelf = inbound() as unknown as {
      sender: Record<string, unknown>;
    };
    delete withoutIsSelf.sender.isSelf;
    expect(() =>
      assertValidInboundChannelMessage(
        withoutIsSelf as unknown as InboundChannelMessageV1
      )
    ).toThrow(/sender isSelf/i);
  });

  test("keeps complete inbound content and its platform format", () => {
    const content =
      "[CQ:at,qq=10000] /huanlink inspect [CQ:image,url=https://invalid.example/image.png,key=fixture-key][CQ:future,opaque=value]";
    const message = inbound({
      content
    });

    expect(() => assertValidInboundChannelMessage(message)).not.toThrow();
    expect(message.content).toBe(content);
    expect(message.contentFormat).toBe("onebot11.cq");
  });

  test("accepts whitespace-only inbound content without changing it", () => {
    const content = " ";
    const message = inbound({ content });

    expect(() => assertValidInboundChannelMessage(message)).not.toThrow();
    expect(message.content).toBe(content);
  });

  test("rejects an actually empty inbound content string", () => {
    expect(() =>
      assertValidInboundChannelMessage(inbound({ content: "" }))
    ).toThrow(/content must be a non-empty string/);
  });

  test("accepts complete inbound content at the 8 KiB UTF-8 limit", () => {
    const content = "a".repeat(CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1);

    expect(() =>
      assertValidInboundChannelMessage(inbound({ content }))
    ).not.toThrow();
  });

  test("rejects complete inbound content above the 8 KiB UTF-8 limit", () => {
    const content = "a".repeat(CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1 + 1);

    expect(() =>
      assertValidInboundChannelMessage(inbound({ content }))
    ).toThrow(/must not exceed 8192 UTF-8 bytes/);
  });

  test("measures the inbound limit in UTF-8 bytes instead of characters", () => {
    const content = "你".repeat(2731);

    expect(content.length).toBeLessThan(
      CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1
    );
    expect(() =>
      assertValidInboundChannelMessage(inbound({ content }))
    ).toThrow(/must not exceed 8192 UTF-8 bytes/);
  });

  test("accepts a bounded placeholder when original inbound content is too large", () => {
    const message = inbound({
      content: CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
      contentOmitted: {
        reason: "too_large",
        originalSizeBytes: CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1 + 1
      }
    });

    expect(() => assertValidInboundChannelMessage(message)).not.toThrow();
  });

  test.each([
    {
      content: "partial original content",
      contentOmitted: {
        reason: "too_large",
        originalSizeBytes: CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1 + 1
      }
    },
    {
      content: CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
      contentOmitted: {
        reason: "too_large",
        originalSizeBytes: CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1
      }
    }
  ])("rejects an invalid too-large placeholder %#", (overrides) => {
    expect(() =>
      assertValidInboundChannelMessage(inbound(overrides as never))
    ).toThrow(/omitted content/);
  });

  test("accepts ordered text, user mention, all mention, and HTTP attachment link parts", () => {
    const parts = [
      { type: "text", text: "see " },
      { type: "mention", targetId: "30000", displayName: "Alice" },
      { type: "mention", targetId: "all", displayName: "全体成员" },
      {
        type: "attachmentLink",
        kind: "image",
        url: "https://example.com/image.png",
        name: "image.png",
        mimeType: "image/png"
      }
    ] as const;

    expect(() => assertValidOutboundChannelMessageParts(parts)).not.toThrow();
    expect(parts.map(({ type }) => type)).toEqual([
      "text",
      "mention",
      "mention",
      "attachmentLink"
    ]);
  });

  test.each([
    "D:\\workspace\\result.txt",
    "/var/lib/huanlink/result.txt"
  ])("accepts an absolute local attachment path %s", (path) => {
    expect(() =>
      assertValidOutboundChannelMessageParts([
        {
          type: "attachmentLocalPath",
          kind: "file",
          path,
          name: "result.txt",
          mimeType: "text/plain"
        }
      ])
    ).not.toThrow();
  });

  test.each([
    "result.txt",
    "../result.txt",
    "file:///tmp/result.txt",
    "base64://aGVsbG8="
  ])("rejects a non-absolute local attachment path %s", (path) => {
    expect(() =>
      assertValidOutboundChannelMessageParts([
        {
          type: "attachmentLocalPath",
          kind: "file",
          path
        }
      ])
    ).toThrow(/local path must be absolute/);
  });

  test.each([
    "file:///tmp/image.png",
    "base64://aGVsbG8=",
    "ftp://example.com/image.png",
    "C:/images/image.png"
  ])("rejects non-HTTP remote attachment reference %s", (url) => {
    expect(() =>
      assertValidOutboundChannelMessageParts([
        {
          type: "attachmentLink",
          kind: "image",
          url
        }
      ])
    ).toThrow(/HTTP\(S\)/);
  });

  test("rejects credentials embedded in an outbound attachment URL", () => {
    expect(() =>
      assertValidOutboundChannelMessageParts([
        {
          type: "attachmentLink",
          kind: "image",
          url: "https://user:password@example.com/image.png"
        }
      ])
    ).toThrow(/must not include credentials/);
  });

  test("exposes a stable channel failure code", () => {
    const error = new ChannelOperationError(
      "not_supported",
      "attachments are not supported"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ChannelOperationError");
    expect(error.code).toBe("not_supported");
    expect(error.message).toBe("attachments are not supported");
  });

  test("exposes delivery_uncertain when a dispatched send has no known result", () => {
    const error = new ChannelOperationError(
      "delivery_uncertain",
      "the platform may have accepted the message"
    );

    expect(error.code).toBe("delivery_uncertain");
  });
});
