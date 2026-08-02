import type {
  OneBot11Action,
  OneBot11ActionContext,
  OneBot11EventListener,
  OneBot11JsonObject,
  OneBot11Transport
} from "../src/index.js";
import {
  createForwardWebSocketOneBot11ChannelAdapterV1,
  OneBot11ChannelAdapterV1,
  OneBot11DeliveryUncertainError,
  OneBot11RemoteActionError,
  OneBot11TransportUnavailableError
} from "../src/index.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";

class FakeOneBot11Transport implements OneBot11Transport {
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly actions: OneBot11Action[] = [];
  private readonly listeners = new Set<OneBot11EventListener>();

  onEvent(listener: OneBot11EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendAction(
    action: OneBot11Action,
    _context: OneBot11ActionContext
  ): Promise<OneBot11JsonObject> {
    this.actions.push(action);
    return {
      status: "ok",
      retcode: 0,
      data:
        action.action === "delete_msg" ? {} : { message_id: "5678" },
      echo: action.echo
    };
  }

  emit(event: OneBot11JsonObject): void {
    for (const listener of [...this.listeners]) {
      void listener(event);
    }
  }
}

function createAdapter(transport = new FakeOneBot11Transport()) {
  return {
    adapter: new OneBot11ChannelAdapterV1({
      channelId: "qq-main",
      accountId: "10001",
      transport
    }),
    transport
  };
}

describe("OneBot11ChannelAdapterV1", () => {
  test("declares only the group, direct, reply, retract, and implemented part capabilities", () => {
    const { adapter } = createAdapter();

    expect(adapter.descriptor).toEqual({
      channelId: "qq-main",
      platform: "onebot11",
      accountId: "10001",
      capabilities: {
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
      }
    });
  });

  test("forwards both ordinary and self-sent events without deciding whether to trigger an Agent", () => {
    const { adapter, transport } = createAdapter();
    const received = vi.fn();
    adapter.onMessage(received);

    transport.emit({
      time: 1_704_067_200,
      self_id: "10001",
      post_type: "message",
      message_type: "group",
      message_id: "1",
      group_id: "20002",
      user_id: "30003",
      message: "hello",
      sender: { nickname: "Alice" }
    });
    transport.emit({
      time: 1_704_067_201,
      self_id: "10001",
      post_type: "message_sent",
      message_type: "group",
      message_id: "2",
      group_id: "20002",
      user_id: "10001",
      message: "sent",
      sender: { nickname: "HuanLink" }
    });

    expect(received).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageId: "1",
        sender: expect.objectContaining({ isSelf: false })
      })
    );
    expect(received).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageId: "2",
        sender: expect.objectContaining({ isSelf: true })
      })
    );
  });

  test("sends one ordered group message and returns the platform message id", async () => {
    const { adapter, transport } = createAdapter();

    const receipt = await adapter.send({
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "20002"
      },
      replyToMessageId: "99",
      parts: [
        { type: "text", text: "result " },
        { type: "mention", targetId: "30003" },
        {
          type: "attachmentLink",
          kind: "image",
          url: "https://example.invalid/result.png"
        }
      ]
    });

    expect(receipt).toEqual({
      channelId: "qq-main",
      messageId: "5678"
    });
    expect(transport.actions).toHaveLength(1);
    expect(transport.actions[0]).toMatchObject({
      action: "send_group_msg",
      params: {
        group_id: 20002,
        message: [
          { type: "reply", data: { id: 99 } },
          { type: "text", data: { text: "result " } },
          { type: "at", data: { qq: 30003 } },
          {
            type: "image",
            data: { file: "https://example.invalid/result.png" }
          }
        ]
      },
      echo: expect.stringMatching(/^send-group:/)
    });
  });

  test("encodes an all-target mention for a group message", async () => {
    const { adapter, transport } = createAdapter();

    await adapter.send({
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "20002"
      },
      parts: [{ type: "mention", targetId: "all" }]
    });

    expect(transport.actions).toHaveLength(1);
    expect(transport.actions[0]).toMatchObject({
      action: "send_group_msg",
      params: {
        group_id: 20002,
        message: [{ type: "at", data: { qq: "all" } }]
      }
    });
  });

  test("maps a readable local media path to one direct-message action", async () => {
    const { adapter, transport } = createAdapter();
    const localPath = fileURLToPath(import.meta.url);

    await adapter.send({
      route: {
        channelId: "qq-main",
        conversationKind: "direct",
        conversationId: "40004"
      },
      parts: [
        {
          type: "attachmentLocalPath",
          kind: "audio",
          path: localPath
        }
      ]
    });

    expect(transport.actions).toHaveLength(1);
    expect(transport.actions[0]).toMatchObject({
      action: "send_private_msg",
      params: {
        user_id: 40004,
        message: [
          {
            type: "record",
            data: { file: pathToFileURL(localPath).href }
          }
        ]
      }
    });
  });

  test("rejects a generic file before sending any partial message", async () => {
    const { adapter, transport } = createAdapter();

    await expect(
      adapter.send({
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002"
        },
        parts: [
          { type: "text", text: "do not send partially" },
          {
            type: "attachmentLink",
            kind: "file",
            url: "https://example.invalid/result.zip"
          }
        ]
      })
    ).rejects.toMatchObject({ code: "not_supported" });
    expect(transport.actions).toEqual([]);
  });

  test("uses delete_msg for the message id returned by a send", async () => {
    const { adapter, transport } = createAdapter();
    const route = {
      channelId: "qq-main",
      conversationKind: "group" as const,
      conversationId: "20002"
    };
    const receipt = await adapter.send({
      route,
      parts: [{ type: "text", text: "temporary" }]
    });

    await adapter.retract({ route, messageId: receipt.messageId });

    expect(transport.actions[1]).toMatchObject({
      action: "delete_msg",
      params: { message_id: 5678 },
      echo: expect.stringMatching(/^delete:/)
    });
  });

  test("maps a dispatched action with no response to delivery_uncertain", async () => {
    const transport = new FakeOneBot11Transport();
    vi.spyOn(transport, "sendAction").mockRejectedValueOnce(
      new OneBot11DeliveryUncertainError(
        "OneBot 11 action may have reached the platform"
      )
    );
    const { adapter } = createAdapter(transport);

    await expect(
      adapter.send({
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002"
        },
        parts: [{ type: "text", text: "do not retry automatically" }]
      })
    ).rejects.toMatchObject({
      name: "ChannelOperationError",
      code: "delivery_uncertain"
    });
  });

  test("maps an unavailable transport to temporarily_unavailable", async () => {
    const transport = new FakeOneBot11Transport();
    vi.spyOn(transport, "sendAction").mockRejectedValueOnce(
      new OneBot11TransportUnavailableError("not connected")
    );
    const { adapter } = createAdapter(transport);

    await expect(
      adapter.send({
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002"
        },
        parts: [{ type: "text", text: "error mapping" }]
      })
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });

  test.each([
    { retcode: 1400, expectedCode: "invalid_target" },
    { retcode: 1401, expectedCode: "authentication_failed" },
    { retcode: 1403, expectedCode: "authentication_failed" },
    { retcode: 1404, expectedCode: "not_supported" },
    { retcode: 1999, expectedCode: "permanent_failure" }
  ])(
    "maps standard remote retcode $retcode to $expectedCode",
    async ({ retcode, expectedCode }) => {
      const transport = new FakeOneBot11Transport();
      vi.spyOn(transport, "sendAction").mockRejectedValueOnce(
        new OneBot11RemoteActionError({
          status: "failed",
          retcode
        })
      );
      const { adapter } = createAdapter(transport);

      await expect(
        adapter.send({
          route: {
            channelId: "qq-main",
            conversationKind: "group",
            conversationId: "20002"
          },
          parts: [{ type: "text", text: "error mapping" }]
        })
      ).rejects.toMatchObject({ code: expectedCode });
    }
  );

  test("rejects a successful response without message_id as a permanent failure", async () => {
    const transport = new FakeOneBot11Transport();
    vi.spyOn(transport, "sendAction").mockResolvedValueOnce({
      status: "ok",
      retcode: 0,
      data: {},
      echo: "send-response"
    });
    const { adapter } = createAdapter(transport);

    await expect(
      adapter.send({
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002"
        },
        parts: [{ type: "text", text: "missing receipt" }]
      })
    ).rejects.toMatchObject({ code: "permanent_failure" });
  });

  test("keeps a string message id exact so the same id can be retracted", async () => {
    const transport = new FakeOneBot11Transport();
    const hugeMessageId = "9223372036854775807";
    vi.spyOn(transport, "sendAction")
      .mockImplementationOnce(async (action) => {
        transport.actions.push(action);
        return {
          status: "ok",
          retcode: 0,
          data: { message_id: hugeMessageId },
          echo: "send-response"
        };
      })
      .mockImplementationOnce(async (action) => {
        transport.actions.push(action);
        return {
          status: "ok",
          retcode: 0,
          data: {},
          echo: "delete-response"
        };
      });
    const { adapter } = createAdapter(transport);
    const route = {
      channelId: "qq-main",
      conversationKind: "group" as const,
      conversationId: "20002"
    };

    const receipt = await adapter.send({
      route,
      parts: [{ type: "text", text: "large id" }]
    });
    await adapter.retract({ route, messageId: receipt.messageId });

    expect(receipt.messageId).toBe(hugeMessageId);
    expect(transport.actions[1]?.params.message_id).toBe(hugeMessageId);
  });

  test("maps contract validation failures to invalid_target without touching the transport", async () => {
    const { adapter, transport } = createAdapter();

    await expect(
      adapter.send({
        route: {
          channelId: "wrong-instance",
          conversationKind: "group",
          conversationId: "20002"
        },
        parts: [{ type: "text", text: "must not send" }]
      })
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(transport.actions).toEqual([]);
  });

  test("builds the V1 adapter factory without starting a connection", async () => {
    const adapter = createForwardWebSocketOneBot11ChannelAdapterV1({
      channelId: "qq-main",
      accountId: "10001",
      url: "ws://127.0.0.1:65535/"
    });

    expect(adapter.descriptor).toMatchObject({
      channelId: "qq-main",
      platform: "onebot11",
      accountId: "10001"
    });
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
