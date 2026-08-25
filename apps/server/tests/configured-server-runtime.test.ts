import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import {
  InMemoryAsyncToolTaskStore,
  InMemoryConversationSessionStore,
  type ConversationSessionStore,
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
import { createServerSqlitePersistence } from "../src/server-sqlite-persistence.js";

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

class FailingRecoveryTaskStore extends InMemoryAsyncToolTaskStore {
  constructor(private readonly recoveryError: Error) {
    super();
  }

  override list(): readonly never[] {
    throw this.recoveryError;
  }
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
  test("uses the supplied Conversation and Task Stores without requiring an InMemory class", async () => {
    const backingSessions = new InMemoryConversationSessionStore();
    const sessionStore = {
      appendChannelMessage:
        backingSessions.appendChannelMessage.bind(backingSessions),
      recordOutboundDelivery:
        backingSessions.recordOutboundDelivery.bind(backingSessions),
      appendAgentToolCall:
        backingSessions.appendAgentToolCall.bind(backingSessions),
      appendAgentToolResult:
        backingSessions.appendAgentToolResult.bind(backingSessions),
      getAgentToolCall: backingSessions.getAgentToolCall.bind(backingSessions),
      getSession: backingSessions.getSession.bind(backingSessions),
      getSessionContextWindow:
        backingSessions.getSessionContextWindow.bind(backingSessions),
      getSessionMetadata:
        backingSessions.getSessionMetadata.bind(backingSessions),
    } satisfies ConversationSessionStore;
    const taskStore = new InMemoryAsyncToolTaskStore();
    const storeOwner = { close: vi.fn() };
    const config = channelConfig();
    const runtime = await createConfiguredServerRuntime({
      staticConfig,
      channelConfig: config,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadChannelConfig: async () => config,
      env: { DEEPSEEK_API_KEY: "runtime-model-key" },
      createAgentCallTransport: () => transport([]),
      createChannelAdapter: (channel) =>
        new FakeChannelAdapter(channel.channelId, []),
      watchFactory: noopWatchFactory,
      createPersistence: () => ({ sessionStore, taskStore, storeOwner }),
    });

    const reservation = runtime.taskService.reserve({
      sessionId: "session-1",
      sourceRunId: "run-1",
      sourceToolCallId: "call-1",
      kind: "agent-call",
      toolName: "submit_codex_agent_call",
      payload: { artifacts: [] },
    });

    expect(reservation.status).toBe("reserved");
    expect(taskStore.getBySource("session-1", "run-1", "call-1")).toMatchObject(
      { taskId: expect.any(String) },
    );
    await runtime.close();
    expect(storeOwner.close).toHaveBeenCalledOnce();
  });

  test("closes persistence when Task recovery prevents Runtime construction", async () => {
    const recoveryError = new Error("persisted Task facts are unreadable");
    const storeOwner = { close: vi.fn() };
    const config = channelConfig();

    await expect(
      createConfiguredServerRuntime({
        staticConfig,
        channelConfig: config,
        configRoot: "C:\\repo\\.huanlink\\config",
        loadChannelConfig: async () => config,
        env: { DEEPSEEK_API_KEY: "runtime-model-key" },
        createAgentCallTransport: () => transport([]),
        createChannelAdapter: (channel) =>
          new FakeChannelAdapter(channel.channelId, []),
        watchFactory: noopWatchFactory,
        createPersistence: () => ({
          sessionStore: new InMemoryConversationSessionStore(),
          taskStore: new FailingRecoveryTaskStore(recoveryError),
          storeOwner,
        }),
      }),
    ).rejects.toBe(recoveryError);
    expect(storeOwner.close).toHaveBeenCalledOnce();
  });

  test("closes persistence when A2A preflight prevents Channel startup", async () => {
    const preflightError = new Error("A2A Agent is unavailable");
    const events: string[] = [];
    const storeOwner = {
      close: vi.fn(() => {
        events.push("store:close");
      }),
    };
    const config = channelConfig();
    const runtime = await createConfiguredServerRuntime({
      staticConfig,
      channelConfig: config,
      configRoot: "C:\\repo\\.huanlink\\config",
      loadChannelConfig: async () => config,
      env: { DEEPSEEK_API_KEY: "runtime-model-key" },
      createAgentCallTransport: () => ({
        ...transport(events),
        discoverCapability: vi.fn(async () => {
          events.push("a2a:preflight");
          throw preflightError;
        }),
      }),
      createChannelAdapter: (channel) =>
        new FakeChannelAdapter(channel.channelId, events),
      watchFactory: noopWatchFactory,
      createPersistence: () => ({
        sessionStore: new InMemoryConversationSessionStore(),
        taskStore: new InMemoryAsyncToolTaskStore(),
        storeOwner,
      }),
    });

    await expect(runtime.start()).rejects.toBe(preflightError);
    expect(events).toEqual(["a2a:preflight", "store:close"]);
    expect(storeOwner.close).toHaveBeenCalledOnce();
  });

  test("reopens persisted Tasks without resuming remote or MainAgent work", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "huanlink-configured-db-"));
    let runtime: ConfiguredServerRuntime | undefined;
    try {
      const initial = await createServerSqlitePersistence({ projectRoot });
      initial.sessionStore.appendChannelMessage("session-1", {
        messageId: "message-1",
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "10001",
        },
        sender: { id: "20002", username: "Alice", isSelf: false },
        receivedAt: "2026-08-21T02:00:00.000Z",
        content: "persisted source",
        contentFormat: "onebot11.cq",
      });
      initial.sessionStore.appendAgentToolCall("session-1", {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "submit_codex_agent_call",
        arguments: { task: "do not resume after restart" },
      });
      initial.taskStore.insert({
        taskId: "task-1",
        sessionId: "session-1",
        sourceRunId: "run-1",
        sourceToolCallId: "call-1",
        kind: "agent-call",
        quotaPool: "a2a",
        toolName: "submit_codex_agent_call",
        state: "working",
        payload: { artifacts: [] },
        createdAt: "2026-08-21T02:00:01.000Z",
        updatedAt: "2026-08-21T02:00:02.000Z",
      });
      await initial.storeOwner.close();

      const events: string[] = [];
      const remote = transport(events);
      const submitTask = vi.spyOn(remote, "submitTask");
      const continueTask = vi.spyOn(remote, "continueTask");
      const watchTask = vi.spyOn(remote, "watchTask");
      const cancelTask = vi.spyOn(remote, "cancelTask");
      const adapter = new FakeChannelAdapter("qq-main", events);
      const send = vi.spyOn(adapter, "send");
      const config = channelConfig();
      runtime = await createConfiguredServerRuntime({
        staticConfig,
        channelConfig: config,
        configRoot: join(projectRoot, ".huanlink", "config"),
        loadChannelConfig: async () => config,
        env: { DEEPSEEK_API_KEY: "runtime-model-key" },
        createAgentCallTransport: () => remote,
        createChannelAdapter: () => adapter,
        watchFactory: noopWatchFactory,
        createPersistence: () => createServerSqlitePersistence({ projectRoot }),
      });

      expect(
        runtime.taskService.getStatus("session-1", "task-1"),
      ).toMatchObject({
        status: "found",
        taskId: "task-1",
        state: "unknown",
        statusMessage: "reconciliation-required",
      });
      await runtime.start();

      expect(remote.discoverCapability).toHaveBeenCalledOnce();
      expect(submitTask).not.toHaveBeenCalled();
      expect(continueTask).not.toHaveBeenCalled();
      expect(watchTask).not.toHaveBeenCalled();
      expect(cancelTask).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      await runtime.close();
      runtime = undefined;
      const reopened = await createServerSqlitePersistence({ projectRoot });
      expect(reopened.taskStore.get("session-1", "task-1")).toMatchObject({
        taskId: "task-1",
        state: "unknown",
      });
      await reopened.storeOwner.close();
    } finally {
      await runtime?.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("releases the real SQLite owner when preflight fails", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "huanlink-preflight-db-"));
    let runtime: ConfiguredServerRuntime | undefined;
    try {
      const preflightError = new Error("configured A2A preflight failed");
      const config = channelConfig();
      runtime = await createConfiguredServerRuntime({
        staticConfig,
        channelConfig: config,
        configRoot: join(projectRoot, ".huanlink", "config"),
        loadChannelConfig: async () => config,
        env: { DEEPSEEK_API_KEY: "runtime-model-key" },
        createAgentCallTransport: () => ({
          ...transport([]),
          discoverCapability: async () => {
            throw preflightError;
          },
        }),
        createChannelAdapter: (channel) =>
          new FakeChannelAdapter(channel.channelId, []),
        watchFactory: noopWatchFactory,
        createPersistence: () => createServerSqlitePersistence({ projectRoot }),
      });

      await expect(runtime.start()).rejects.toBe(preflightError);
      const reopened = await createServerSqlitePersistence({ projectRoot });
      reopened.sessionStore.appendChannelMessage("session-after-failure", {
        messageId: "message-after-failure",
        route: {
          channelId: "qq-main",
          conversationKind: "group",
          conversationId: "10001",
        },
        sender: { id: "20002", username: "Alice", isSelf: false },
        receivedAt: "2026-08-21T02:01:00.000Z",
        content: "database reopened",
        contentFormat: "onebot11.cq",
      });
      await reopened.storeOwner.close();
    } finally {
      await runtime?.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

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
