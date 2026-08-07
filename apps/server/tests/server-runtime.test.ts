import type {
  ChannelAdapterV1,
  ChannelDescriptorV1,
  ChannelMessageListenerV1,
  DeliveryReceiptV1,
  InboundChannelMessageV1,
  RetractChannelMessageCommandV1,
  SendChannelMessageCommandV1
} from "@huanlink/core";
import { describe, expect, test, vi } from "vitest";

import type { ServerChannelRuntimeConfig } from "../src/local-user-config.js";
import { createServerRuntime } from "../src/server-runtime.js";

class FakeChannelAdapter implements ChannelAdapterV1 {
  readonly descriptor: ChannelDescriptorV1;
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  private readonly listeners = new Set<ChannelMessageListenerV1>();

  constructor(channelId: string) {
    this.descriptor = {
      channelId,
      platform: "onebot11",
      capabilities: {
        conversationKinds: ["group", "direct"],
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
    };
  }

  onMessage(listener: ChannelMessageListenerV1): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(
    _command: SendChannelMessageCommandV1
  ): Promise<DeliveryReceiptV1> {
    return { channelId: this.descriptor.channelId, messageId: "sent" };
  }

  async retract(_command: RetractChannelMessageCommandV1): Promise<void> {}

  emit(message: InboundChannelMessageV1): void {
    for (const listener of this.listeners) {
      void listener(message);
    }
  }
}

describe("ServerRuntime", () => {
  test("builds every configured V1 Channel and forwards self events without Agent decisions", async () => {
    const config = serverConfig();
    const adapters = new Map<string, FakeChannelAdapter>();
    const closeOrder: string[] = [];
    const createChannelAdapter = vi.fn((channel: ServerChannelRuntimeConfig["channels"][number]) => {
      const adapter = new FakeChannelAdapter(channel.channelId);
      adapter.close.mockImplementation(async () => {
        closeOrder.push(channel.channelId);
      });
      adapters.set(channel.channelId, adapter);
      return adapter;
    });
    const onChannelMessage = vi.fn();
    const watcherClose = vi.fn(() => {
      closeOrder.push("watcher");
    });
    const runtime = createServerRuntime({
      config,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadConfig: async () => config,
      createChannelAdapter,
      onChannelMessage,
      watchFactory: () => ({
        close: watcherClose,
        on: () => undefined
      })
    });

    expect(createChannelAdapter).toHaveBeenCalledTimes(2);
    await runtime.start();

    adapters.get("qq-main")!.emit(inbound({
      channelId: "qq-main",
      messageId: "self-message",
      isSelf: true
    }));
    adapters.get("qq-secondary")!.emit(inbound({
      channelId: "qq-secondary",
      messageId: "user-message",
      isSelf: false
    }));

    await vi.waitFor(() => expect(onChannelMessage).toHaveBeenCalledTimes(2));
    expect(
      onChannelMessage.mock.calls.map(([input]) => ({
        sessionId: input.sessionId,
        messageId: input.message.messageId,
        isSelf: input.message.sender.isSelf
      }))
    ).toEqual([
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "self-message",
        isSelf: true
      },
      {
        sessionId: "channel:qq-secondary:group:10001",
        messageId: "user-message",
        isSelf: false
      }
    ]);
    expect("sessions" in runtime).toBe(false);
    expect("runMainAgent" in runtime).toBe(false);

    await runtime.close();
    expect(watcherClose).toHaveBeenCalledOnce();
    expect(adapters.get("qq-main")!.close).toHaveBeenCalledOnce();
    expect(adapters.get("qq-secondary")!.close).toHaveBeenCalledOnce();
    expect(closeOrder[0]).toBe("watcher");
  });

  test("closes already started Channels when a later Channel fails to start", async () => {
    const config = serverConfig();
    const adapters: FakeChannelAdapter[] = [];
    const runtime = createServerRuntime({
      config,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadConfig: async () => config,
      onChannelMessage: () => undefined,
      createChannelAdapter: (channel) => {
        const adapter = new FakeChannelAdapter(channel.channelId);
        if (channel.channelId === "qq-secondary") {
          adapter.start.mockRejectedValueOnce(new Error("connect failed"));
        }
        adapters.push(adapter);
        return adapter;
      },
      watchFactory: () => ({ close: vi.fn(), on: () => undefined })
    });

    await expect(runtime.start()).rejects.toThrow("connect failed");
    expect(adapters[0]!.close).toHaveBeenCalledOnce();
    expect(adapters[1]!.close).toHaveBeenCalledOnce();
  });

  test("starts a Channel-only runtime without MainAgent or external Agents", async () => {
    const config = serverConfig();
    delete config.mainAgent;
    config.agents = [];
    delete config.sources.mainAgent;
    config.sources.agents = [];
    const adapters: FakeChannelAdapter[] = [];
    const runtime = createServerRuntime({
      config,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadConfig: async () => config,
      onChannelMessage: () => undefined,
      createChannelAdapter: (channel) => {
        const adapter = new FakeChannelAdapter(channel.channelId);
        adapters.push(adapter);
        return adapter;
      },
      watchFactory: () => ({ close: vi.fn(), on: () => undefined })
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(adapters).toHaveLength(2);
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  test("connects a valid config reload to the live Channel access policy", async () => {
    const initialConfig = serverConfig();
    initialConfig.channels[0]!.inboundPolicy = {
      groups: { mode: "allowlist", ids: ["10001"] },
      directs: { mode: "denylist", ids: [] }
    };
    const nextConfig = structuredClone(initialConfig);
    nextConfig.channels[0]!.inboundPolicy = {
      groups: { mode: "allowlist", ids: ["20002"] },
      directs: { mode: "denylist", ids: [] }
    };
    const adapters = new Map<string, FakeChannelAdapter>();
    const onChannelMessage = vi.fn();
    let notifyConfigChange:
      | ((eventType: string, filename: string | Buffer | null) => void)
      | undefined;
    const runtime = createServerRuntime({
      config: initialConfig,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadConfig: async () => nextConfig,
      onChannelMessage,
      createChannelAdapter: (channel) => {
        const adapter = new FakeChannelAdapter(channel.channelId);
        adapters.set(channel.channelId, adapter);
        return adapter;
      },
      watchFactory: (_path, _options, listener) => {
        notifyConfigChange = listener;
        return { close: vi.fn(), on: () => undefined };
      }
    });
    await runtime.start();

    adapters.get("qq-main")!.emit(inbound({
      channelId: "qq-main",
      messageId: "before",
      isSelf: false,
      conversationId: "10001"
    }));
    await vi.waitFor(() => expect(onChannelMessage).toHaveBeenCalledOnce());

    notifyConfigChange?.("rename", null);
    await vi.waitFor(() =>
      expect(
        runtime.channels.isRouteAllowed({
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "20002"
        })
      ).toBe(true)
    );
    adapters.get("qq-main")!.emit(inbound({
      channelId: "qq-main",
      messageId: "now-blocked",
      isSelf: false,
      conversationId: "10001"
    }));
    adapters.get("qq-main")!.emit(inbound({
      channelId: "qq-main",
      messageId: "now-allowed",
      isSelf: false,
      conversationId: "20002"
    }));

    await vi.waitFor(() => expect(onChannelMessage).toHaveBeenCalledTimes(2));
    expect(onChannelMessage.mock.calls[1]?.[0].message.messageId).toBe(
      "now-allowed"
    );
    await runtime.close();
  });
});

function serverConfig(): ServerChannelRuntimeConfig {
  return {
    mainAgent: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com/beta",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    },
    channels: ["qq-main", "qq-secondary"].map((channelId) => ({
      channelId,
      type: "onebot11-forward-websocket" as const,
      url: "ws://127.0.0.1:3001/",
      inboundPolicy: {
        groups: { mode: "denylist" as const, ids: [] },
        directs: { mode: "denylist" as const, ids: [] }
      },
      enableUnsafePrivilegedOperations: false,
      accessToken: "onebot-secret"
    })),
    agents: [
      {
        agentId: "codex-local",
        displayName: "Codex Local",
        transport: "a2a",
        origin: "http://127.0.0.1:4000",
        skillId: "codex-code-task",
        enabled: true
      },
      {
        agentId: "future-agent",
        displayName: "Future Agent",
        transport: "a2a",
        origin: "http://127.0.0.1:4001",
        skillId: "future-skill",
        enabled: true
      }
    ],
    sources: {
      mainAgent: "server/main-agent.json",
      channels: [
        "server/channels/onebot11.json",
        "server/channels/onebot11-secondary.json"
      ],
      agents: [
        "server/agents/codex-local.json",
        "server/agents/future-agent.json"
      ]
    }
  };
}

function inbound(input: {
  channelId: string;
  messageId: string;
  isSelf: boolean;
  conversationId?: string;
}): InboundChannelMessageV1 {
  return {
    messageId: input.messageId,
    route: {
      channelId: input.channelId,
      conversationKind: "group",
      conversationId: input.conversationId ?? "10001"
    },
    sender: {
      id: input.isSelf ? "bot" : "user",
      username: input.isSelf ? "HuanLink" : "Alice",
      isSelf: input.isSelf
    },
    receivedAt: "2026-08-07T00:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq"
  };
}
