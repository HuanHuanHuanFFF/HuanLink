import { describe, expect, test, vi } from "vitest";

import {
  ChannelOperationError,
  assertValidChannelMessageParts,
  assertValidRetractChannelMessageCommand,
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
  inboundPartTypes: ["text", "mention", "attachmentRef"],
  outboundPartTypes: ["text", "mention", "attachmentRef"],
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
      displayName: "Alice"
    },
    receivedAt: "2026-07-22T00:00:00.000Z",
    parts: [{ type: "text", text: "hello" }],
    ...overrides
  };
}

describe("Channel Contract v1", () => {
  test("sends a message and retracts it through a platform-independent fake adapter", async () => {
    let listener: ChannelMessageListenerV1 | undefined;
    const receive = vi.fn();
    const stopListening = vi.fn();
    const sendCommand: SendChannelMessageCommandV1 = {
      route: route(),
      parts: [
        { type: "text", text: "result: " },
        {
          type: "attachmentRef",
          kind: "file",
          source: {
            type: "remoteUrl",
            url: "https://example.com/result.txt"
          },
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
    const incoming = inbound();
    listener?.(incoming);
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
    expect(receive).toHaveBeenCalledWith(incoming);
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
        displayName: "Alice Card"
      }
    });
    const second = inbound({
      sender: {
        id: "40000",
        username: "bob",
        displayName: "Bob Card"
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
        displayName: "Backend-Alice"
      }
    });

    expect(message.sender).toEqual({
      id: "30000",
      username: "Alice",
      displayName: "Backend-Alice"
    });
  });

  test("accepts ordered text, mention, and remote attachment reference parts", () => {
    const parts = [
      { type: "text", text: "see " },
      { type: "mention", targetId: "30000", displayName: "Alice" },
      {
        type: "attachmentRef",
        kind: "image",
        source: {
          type: "remoteUrl",
          url: "https://example.com/image.png"
        },
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 128
      }
    ] as const;

    expect(() => assertValidChannelMessageParts(parts)).not.toThrow();
    expect(parts.map(({ type }) => type)).toEqual([
      "text",
      "mention",
      "attachmentRef"
    ]);
  });

  test("accepts a HuanLink-managed local cache reference", () => {
    expect(() =>
      assertValidChannelMessageParts([
        {
          type: "attachmentRef",
          kind: "file",
          source: {
            type: "localCache",
            attachmentId: "attachment-01"
          },
          name: "result.txt"
        }
      ])
    ).not.toThrow();
  });

  test.each([
    "file:///tmp/image.png",
    "base64://aGVsbG8=",
    "ftp://example.com/image.png",
    "C:/images/image.png"
  ])("rejects non-HTTP remote attachment reference %s", (url) => {
    expect(() =>
      assertValidChannelMessageParts([
        {
          type: "attachmentRef",
          kind: "image",
          source: { type: "remoteUrl", url }
        }
      ])
    ).toThrow(/HTTP\(S\)/);
  });

  test.each(["../secret", "C:/images/image.png", "file://image.png"])(
    "rejects path-like managed attachment ID %s",
    (attachmentId) => {
      expect(() =>
        assertValidChannelMessageParts([
          {
            type: "attachmentRef",
            kind: "image",
            source: { type: "localCache", attachmentId }
          }
        ])
      ).toThrow(/stable attachment ID/);
    }
  );

  test("rejects a raw path hidden inside a managed cache reference", () => {
    expect(() =>
      assertValidChannelMessageParts([
        {
          type: "attachmentRef",
          kind: "image",
          source: {
            type: "localCache",
            attachmentId: "attachment-01",
            path: "C:/images/image.png"
          }
        } as never
      ])
    ).toThrow(/must not include a raw path/);
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
});
