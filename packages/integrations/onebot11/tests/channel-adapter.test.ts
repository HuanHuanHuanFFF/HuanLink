import { describe, expect, test, vi } from "vitest";

import {
  OneBot11ChannelAdapter,
  type OneBot11Action,
  type OneBot11ActionContext,
  type OneBot11EventListener,
  type OneBot11JsonObject,
  type OneBot11Transport,
} from "../src/index.js";

class FakeOneBot11Transport implements OneBot11Transport {
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly actions: Array<{
    action: OneBot11Action;
    context: OneBot11ActionContext;
  }> = [];
  private readonly listeners = new Set<OneBot11EventListener>();

  onEvent(listener: OneBot11EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<void> {
    this.actions.push({ action, context });
  }

  emit(event: OneBot11JsonObject): void {
    for (const listener of [...this.listeners]) {
      void listener(event);
    }
  }
}

function groupEvent(): OneBot11JsonObject {
  return {
    time: 1_704_067_200,
    self_id: "10001",
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 1,
    group_id: "20002",
    user_id: "30003",
    message: [{ type: "text", data: { text: "/huanlink hello" } }],
    sender: { nickname: "Alice", card: "Alice Card" },
  };
}

describe("OneBot11ChannelAdapter", () => {
  test("maps current group text behavior without owning a WebSocket", async () => {
    const transport = new FakeOneBot11Transport();
    const adapter = new OneBot11ChannelAdapter({
      commandPrefix: "/huanlink",
      transport,
    });
    const received = vi.fn();
    adapter.onMessage(received);

    await adapter.start();
    transport.emit(groupEvent());
    await adapter.sendText("20002", "accepted");
    await adapter.close();

    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "onebot11",
        conversationId: "20002",
        messageId: "1",
        senderId: "30003",
        senderName: "Alice Card",
        text: "/huanlink hello",
        trigger: { kind: "command", text: "hello" },
      }),
    );
    expect(transport.actions).toHaveLength(1);
    expect(transport.actions[0]).toMatchObject({
      action: {
        action: "send_group_msg",
        params: {
          group_id: 20002,
          message: [{ type: "text", data: { text: "accepted" } }],
        },
      },
      context: { conversationId: "20002" },
    });
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
