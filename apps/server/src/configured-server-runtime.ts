import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AsyncToolTaskService,
  InMemoryConversationSessionStore,
  NoopRuntimeLogger,
  SessionTaskQuotaService,
  type AgentCallTransport,
  type ChannelAdapter,
  type RuntimeLogger,
} from "@huanlink/core";
import {
  A2aAgentCallTransport,
  type A2aAgentCallTransportOptions,
} from "@huanlink/integration-a2a-client";
import {
  OneBot11ChannelAdapter,
  createForwardWebSocketOneBot11ChannelAdapter,
  type OneBot11Operations,
} from "@huanlink/integration-onebot11";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import {
  assembleHuanLinkServerRuntime,
  type HuanLinkServerRuntime,
} from "./huanlink-server-runtime.js";
import {
  resolveServerMainAgentRuntimeConfig,
  type HuanLinkServerStaticConfig,
  type ServerChannelRuntimeConfig,
} from "./local-user-config.js";
import { createDeepSeekMainAgentModelBinding } from "./main-agent-model.js";
import { createOneBot11OperationTools } from "./onebot-operation-tools.js";
import { createPhase3HuanLinkRuntime } from "./phase3-runtime.js";
import {
  createServerRuntime,
  type ServerChannelAdapterFactory,
  type ServerRuntime,
} from "./server-runtime.js";
import type { ChannelAccessPolicyWatchFactory } from "./channel-access-policy-reloader.js";

type Awaitable<T> = T | Promise<T>;

export type ConfiguredServerRuntime = HuanLinkServerRuntime & {
  readonly quotaService: SessionTaskQuotaService;
  readonly taskService: AsyncToolTaskService;
};

export type CreateConfiguredServerRuntimeOptions = {
  readonly staticConfig: HuanLinkServerStaticConfig;
  readonly channelConfig: ServerChannelRuntimeConfig;
  readonly configRoot: string;
  readonly loadChannelConfig: () => Promise<ServerChannelRuntimeConfig>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: RuntimeLogger;
  readonly createAgentCallTransport?: (input: {
    readonly origin: string;
    readonly logger: RuntimeLogger;
  }) => AgentCallTransport;
  readonly createChannelAdapter?: ServerChannelAdapterFactory;
  readonly watchFactory?: ChannelAccessPolicyWatchFactory;
  readonly createStore?: () => Awaitable<InMemoryConversationSessionStore>;
};

/**
 * Builds the full in-process Server graph without taking ownership of process
 * startup. `main.ts` and the SQLite Store stay outside this B04-C seam.
 */
export async function createConfiguredServerRuntime(
  options: CreateConfiguredServerRuntimeOptions,
): Promise<ConfiguredServerRuntime> {
  assertCompatibleConfiguration(options.staticConfig, options.channelConfig);
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger(),
  );
  const defaultAgent = configuredDefaultAgent(options.staticConfig);
  const quotaService = new SessionTaskQuotaService({
    limits: {
      a2a: options.staticConfig.orchestration.a2aTaskPolicy
        .maxActiveTasksPerSession,
      "async-tool":
        options.staticConfig.orchestration.asyncToolTaskPolicy
          .maxActiveTasksPerSession,
    },
  });
  const taskService = new AsyncToolTaskService({
    quotaService,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const transport = (options.createAgentCallTransport ?? createTransport)({
    origin: defaultAgent.origin,
    logger: logger.child({ source: "a2a.transport" }),
  });
  const operations = new Map<string, OneBot11Operations>();
  let channelRuntime: ServerRuntime | undefined;
  const resolveChannels = (): ServerRuntime => {
    if (channelRuntime === undefined) {
      throw new Error("Configured Server Channel Runtime is not assembled");
    }
    return channelRuntime;
  };
  const createAdapter = options.createChannelAdapter ?? createConfiguredAdapter;

  const runtime = await assembleHuanLinkServerRuntime({
    taskService,
    createStore: () => {
      const sessionStore =
        options.createStore?.() ?? new InMemoryConversationSessionStore();
      return Promise.resolve(sessionStore).then((store) => ({
        sessionStore: store,
        storeOwner: { close: () => undefined },
      }));
    },
    createPhase3: ({ sessionStore, historyRecorder, getLatestContext }) => {
      if (!(sessionStore instanceof InMemoryConversationSessionStore)) {
        throw new Error(
          "B04-C configured Server Runtime currently requires an InMemory Conversation Store",
        );
      }
      const modelBinding = createDeepSeekMainAgentModelBinding({
        config: resolveServerMainAgentRuntimeConfig(
          options.staticConfig,
          options.env,
        ),
      });
      const onebot = createOneBot11OperationTools({
        sessions: sessionStore,
        historyRecorder,
        resolveOperations: (channelId) => operations.get(channelId),
        isRouteAllowed: (route) =>
          resolveChannels().channels.isRouteAllowed(route),
        ...(options.channelConfig.channels.some(
          (channel) => channel.enableUnsafePrivilegedOperations,
        )
          ? {
              isUnsafePrivilegedOperationsEnabled: (channelId: string) =>
                options.channelConfig.channels.some(
                  (channel) =>
                    channel.channelId === channelId &&
                    channel.enableUnsafePrivilegedOperations,
                ),
            }
          : {}),
        sessionIdForRoute: (route) =>
          resolveChannels().channels.sessionIdForRoute(route),
        runOutbound: (route, operation) =>
          resolveChannels().channels.runOutbound(route, operation),
        runOperation: (channelId, operation) =>
          resolveChannels().channels.runOperation(channelId, operation),
        logger: logger.child({ source: "main_agent.tool.onebot" }),
      });
      return createPhase3HuanLinkRuntime({
        codexA2aOrigin: defaultAgent.origin,
        codexSkillId: defaultAgent.skillId,
        agentId: defaultAgent.agentId,
        transport,
        taskService,
        sessionStore,
        historyRecorder,
        getLatestContext,
        modelBinding,
        additionalTools: [
          onebot.standard,
          ...(onebot.privileged === undefined ? [] : [onebot.privileged]),
        ],
        channelReply: {
          sessions: sessionStore,
          historyRecorder,
          resolveAdapter: (channelId) =>
            resolveChannels().channels.resolveAdapter(channelId),
          logger: logger.child({ source: "main_agent.tool.reply" }),
        },
        logger: logger.child({ source: "phase3" }),
      });
    },
    createChannels: ({ onChannelMessage }) => {
      channelRuntime = createServerRuntime({
        config: options.channelConfig,
        configRoot: options.configRoot,
        loadConfig: options.loadChannelConfig,
        onChannelMessage,
        ...(options.watchFactory === undefined
          ? {}
          : { watchFactory: options.watchFactory }),
        createChannelAdapter: (config, adapterLogger) => {
          const adapter = createAdapter(config, adapterLogger);
          if (adapter instanceof OneBot11ChannelAdapter) {
            operations.set(config.channelId, adapter.operations);
          }
          return adapter;
        },
        logger: logger.child({ source: "channel" }),
      });
      return channelRuntime;
    },
    preflights: [
      async () => {
        await transport.discoverCapability(defaultAgent.skillId);
      },
    ],
  });

  return {
    get state() {
      return runtime.state;
    },
    start: () => runtime.start(),
    close: () => runtime.close(),
    quotaService,
    taskService,
  };
}

function createTransport(input: {
  readonly origin: string;
  readonly logger: RuntimeLogger;
}): AgentCallTransport {
  return new A2aAgentCallTransport({
    origin: input.origin,
    logger: input.logger,
  } satisfies A2aAgentCallTransportOptions);
}

function createConfiguredAdapter(
  config: ServerChannelRuntimeConfig["channels"][number],
  logger: RuntimeLogger,
): ChannelAdapter {
  return createForwardWebSocketOneBot11ChannelAdapter({
    channelId: config.channelId,
    url: config.url,
    ...(config.accessToken === undefined
      ? {}
      : { accessToken: config.accessToken }),
    logger,
  });
}

function configuredDefaultAgent(
  config: HuanLinkServerStaticConfig,
): HuanLinkServerStaticConfig["agents"][number] {
  const agent = config.agents.find(
    (candidate) =>
      candidate.agentId === config.orchestration.defaultAgentId &&
      candidate.enabled &&
      candidate.transport === "a2a",
  );
  if (agent === undefined) {
    throw new Error("Configured default A2A Agent is unavailable");
  }
  return agent;
}

function assertCompatibleConfiguration(
  staticConfig: HuanLinkServerStaticConfig,
  channelConfig: ServerChannelRuntimeConfig,
): void {
  const channelSnapshot = {
    mainAgent: channelConfig.mainAgent,
    channels: channelConfig.channels.map(
      ({ accessToken: _accessToken, ...channel }) => channel,
    ),
    agents: channelConfig.agents,
    orchestration: channelConfig.orchestration,
    sources: channelConfig.sources,
  };
  const staticSnapshot = {
    mainAgent: staticConfig.mainAgent,
    channels: staticConfig.channels,
    agents: staticConfig.agents,
    orchestration: staticConfig.orchestration,
    sources: staticConfig.sources,
  };
  if (JSON.stringify(channelSnapshot) !== JSON.stringify(staticSnapshot)) {
    throw new Error(
      "Configured Server Runtime requires matching static and Channel configuration snapshots",
    );
  }
}
