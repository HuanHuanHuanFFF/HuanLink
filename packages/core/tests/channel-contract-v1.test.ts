import { describe, expect, test, vi } from "vitest";

import {
  ChannelOperationError,
  assertValidChannelMessageParts,
  channelSessionIdFor,
  type ChannelAdapterV1,
  type ChannelCapabilitiesV1,
  type ChannelConversationRouteV1,
  type ChannelDescriptorV1,
  type ChannelMessageListenerV1,
  type InboundChannelMessageV1,
  type OutboundChannelCommandV1
} from "../src/index.js";

const capabilities: ChannelCapabilitiesV1 = {
  conversationKinds: ["direct", "group"],
  threads: false,
  inboundPartTypes: ["text", "mention", "attachmentRef"],
  outboundPartTypes: ["text", "mention", "attachmentRef"],
  reply: true,
  edit: false,
  retract: false,
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
  test("supports a platform-independent fake adapter lifecycle and send receipt", async () => {
    let listener: ChannelMessageListenerV1 | undefined;
    const receive = vi.fn();
    const stopListening = vi.fn();
    const command: OutboundChannelCommandV1 = {
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
        platformMessageId: "sent-1"
      }))
    };

    const unsubscribe = adapter.onMessage(receive);
    await adapter.start();
    const incoming = inbound();
    listener?.(incoming);
    await expect(adapter.send(command)).resolves.toEqual({
      channelId: "qq-main",
      platformMessageId: "sent-1"
    });
    await adapter.close();
    unsubscribe();

    expect(adapter.send).toHaveBeenCalledWith(command);
    expect(receive).toHaveBeenCalledWith(incoming);
    expect(stopListening).toHaveBeenCalledTimes(1);
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
