import type {
  AgentCallCapability,
  AgentCallTaskSnapshot,
  AgentCallTransport,
  AgentCallTransportContinueRequest,
  AgentCallTransportSubmitRequest,
  AgentCallTransportSubmitResult,
  ChannelAdapter,
  ChannelDescriptor,
  ChannelMessageListener,
  DeliveryReceipt,
  RetractChannelMessageCommand,
  RuntimeLogFields,
  RuntimeLogger,
  SendChannelMessageCommand,
} from "@huanlink/core";
import { describe, expect, test, vi } from "vitest";

import {
  createConfiguredServerRuntime,
  type ConfiguredServerRuntime,
} from "../src/configured-server-runtime.js";
import type { ChannelAccessPolicyWatchFactory } from "../src/channel-access-policy-reloader.js";
import type {
  HuanLinkServerStaticConfig,
  ServerChannelRuntimeConfig,
} from "../src/local-user-config.js";

class RecordingLogger implements RuntimeLogger {
  readonly entries: Array<{
    level: string;
    message: string;
    fields?: RuntimeLogFields;
  }> = [];

  debug(message: string, fields?: RuntimeLogFields): void {
    this.entries.push({ level: "debug", message, fields });
  }

  info(message: string, fields?: RuntimeLogFields): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields?: RuntimeLogFields): void {
    this.entries.push({ level: "error", message, fields });
  }

  child(_bindings: RuntimeLogFields): RuntimeLogger {
    return this;
  }
}

class FakeChannelAdapter implements ChannelAdapter {
  readonly descriptor: ChannelDescriptor;
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);

  constructor(
    channelId: string,
    private readonly events: string[],
  ) {
    this.descriptor = {
      channelId,
      platform: "onebot11",
      capabilities: {
        conversationKinds: ["group", "direct"],
        threads: false,
        inboundContentFormats: ["onebot11.cq"],
        outboundPartTypes: ["text"],
        reply: true,
        edit: false,
        retract: true,
        reaction: false,
        typing: false,
        streaming: false,
      },
    };
    this.start.mockImplementation(async () => {
      this.events.push("channel:start");
    });
  }

  onMessage(_listener: ChannelMessageListener): () => void {
    return () => undefined;
  }

  async send(_command: SendChannelMessageCommand): Promise<DeliveryReceipt> {
    return { channelId: this.descriptor.channelId, messageId: "1" };
  }

  async retract(_command: RetractChannelMessageCommand): Promise<void> {}
}

function transport(events: string[]): AgentCallTransport {
  return {
    discoverCapability: vi.fn(async (skillId: string) => {
      events.push("a2a:preflight");
      return { id: skillId, name: "Codex" } satisfies AgentCallCapability;
    }),
    submitTask: async (
      _request: AgentCallTransportSubmitRequest,
    ): Promise<AgentCallTransportSubmitResult> => ({
      outcome: "not-dispatched",
      error: new Error("not used"),
    }),
    continueTask: async (
      _request: AgentCallTransportContinueRequest,
    ): Promise<AgentCallTaskSnapshot> => {
      throw new Error("not used");
    },
    watchTask: async function* (
      _taskId: string,
      _options: { signal: AbortSignal },
    ): AsyncIterable<AgentCallTaskSnapshot> {},
    cancelTask: async (): Promise<AgentCallTaskSnapshot> => {
      throw new Error("not used");
    },
  };
}

const staticConfig: HuanLinkServerStaticConfig = {
  mainAgent: {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com/beta",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  channels: [
    {
      channelId: "qq-main",
      type: "onebot11-forward-websocket",
      url: "ws://127.0.0.1:3001/",
      inboundPolicy: {
        groups: { mode: "allowlist", ids: ["10001"] },
        directs: { mode: "denylist", ids: [] },
      },
      enableUnsafePrivilegedOperations: false,
      accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
    },
  ],
  agents: [
    {
      agentId: "codex-local",
      displayName: "Codex Local",
      transport: "a2a",
      origin: "http://127.0.0.1:4000",
      skillId: "codex-code-task",
      enabled: true,
    },
  ],
  orchestration: {
    defaultAgentId: "codex-local",
    a2aTaskPolicy: { maxActiveTasksPerSession: 2 },
    asyncToolTaskPolicy: { maxActiveTasksPerSession: 3 },
  },
  sources: {
    mainAgent: "server/main-agent.json",
    orchestration: "server/orchestration.json",
    channels: ["server/channels/onebot11.json"],
    agents: ["server/agents/codex-local.json"],
  },
};

function channelConfig(
  input: { enableUnsafePrivilegedOperations?: boolean } = {},
): ServerChannelRuntimeConfig {
  return {
    mainAgent: { ...staticConfig.mainAgent },
    channels: staticConfig.channels.map((channel) => ({
      ...channel,
      enableUnsafePrivilegedOperations:
        input.enableUnsafePrivilegedOperations ??
        channel.enableUnsafePrivilegedOperations,
      accessToken: "onebot-token",
      accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
    })),
    agents: staticConfig.agents.map((agent) => ({ ...agent })),
    orchestration: {
      defaultAgentId: staticConfig.orchestration.defaultAgentId,
      a2aTaskPolicy: { ...staticConfig.orchestration.a2aTaskPolicy },
      asyncToolTaskPolicy: {
        ...staticConfig.orchestration.asyncToolTaskPolicy,
      },
    },
    sources: {
      mainAgent: staticConfig.sources.mainAgent,
      orchestration: staticConfig.sources.orchestration,
      channels: [...staticConfig.sources.channels],
      agents: [...staticConfig.sources.agents],
    },
  };
}

async function createRuntime(input: {
  events: string[];
  logger?: RuntimeLogger;
  enableUnsafePrivilegedOperations?: boolean;
}): Promise<ConfiguredServerRuntime> {
  const runtimeStaticConfig: HuanLinkServerStaticConfig = {
    ...staticConfig,
    channels: staticConfig.channels.map((channel) => ({
      ...channel,
      enableUnsafePrivilegedOperations:
        input.enableUnsafePrivilegedOperations ??
        channel.enableUnsafePrivilegedOperations,
    })),
  };
  const config = channelConfig({
    enableUnsafePrivilegedOperations: input.enableUnsafePrivilegedOperations,
  });
  return await createConfiguredServerRuntime({
    staticConfig: runtimeStaticConfig,
    channelConfig: config,
    configRoot: "C:\\repo\\.huanlink\\config",
    loadChannelConfig: async () => config,
    env: { DEEPSEEK_API_KEY: "runtime-model-key" },
    logger: input.logger,
    createAgentCallTransport: () => transport(input.events),
    createChannelAdapter: (channel) =>
      new FakeChannelAdapter(channel.channelId, input.events),
    watchFactory: noopWatchFactory,
  });
}

describe("configured Server Runtime", () => {
  test("creates one config-derived quota owner and one Task Service", async () => {
    const runtime = await createRuntime({ events: [] });

    expect(runtime.taskService.taskQuotaService).toBe(runtime.quotaService);
    expect(runtime.quotaService.acquire("session-1", "a2a").status).toBe(
      "acquired",
    );
    expect(runtime.quotaService.acquire("session-1", "a2a").status).toBe(
      "acquired",
    );
    expect(runtime.quotaService.acquire("session-1", "a2a").status).toBe(
      "limit-reached",
    );
    expect(runtime.quotaService.acquire("session-1", "async-tool").status).toBe(
      "acquired",
    );
    expect(runtime.quotaService.acquire("session-1", "async-tool").status).toBe(
      "acquired",
    );
    expect(runtime.quotaService.acquire("session-1", "async-tool").status).toBe(
      "acquired",
    );
    expect(runtime.quotaService.acquire("session-1", "async-tool").status).toBe(
      "limit-reached",
    );

    await runtime.close();
  });

  test("completes A2A Agent Card preflight before starting Channels", async () => {
    const events: string[] = [];
    const runtime = await createRuntime({ events });

    await runtime.start();

    expect(events).toEqual(["a2a:preflight", "channel:start"]);
    await runtime.close();
  });

  test("does not freeze lifecycle state while delegating the assembled Runtime", async () => {
    const runtime = await createRuntime({ events: [] });

    expect(runtime.state).toBe("ready");
    await runtime.start();
    expect(runtime.state).toBe("running");
    await runtime.close();
    expect(runtime.state).toBe("closed");
  });

  test("rejects mismatched non-secret configuration snapshots before building dependencies", async () => {
    const initial = channelConfig();
    const config: ServerChannelRuntimeConfig = {
      ...initial,
      channels: initial.channels.map((channel) => ({
        ...channel,
        inboundPolicy: {
          ...channel.inboundPolicy,
          groups: { ...channel.inboundPolicy.groups, ids: ["99999"] },
        },
      })),
    };

    await expect(
      createConfiguredServerRuntime({
        staticConfig,
        channelConfig: config,
        configRoot: "C:\\repo\\.huanlink\\config",
        loadChannelConfig: async () => config,
        env: { DEEPSEEK_API_KEY: "runtime-model-key" },
        watchFactory: noopWatchFactory,
      }),
    ).rejects.toThrow(/matching static and Channel configuration snapshots/);
  });

  test("logs the explicit unsafe-operation warning only when a Channel enables it", async () => {
    const logger = new RecordingLogger();
    const runtime = await createRuntime({
      events: [],
      logger,
      enableUnsafePrivilegedOperations: true,
    });

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "onebot.privileged.enabled_without_protection",
        fields: expect.objectContaining({ approvalProtection: false }),
      }),
    );

    await runtime.close();
  });
});

const noopWatchFactory: ChannelAccessPolicyWatchFactory = () => ({
  close: () => undefined,
  on: () => undefined,
});
