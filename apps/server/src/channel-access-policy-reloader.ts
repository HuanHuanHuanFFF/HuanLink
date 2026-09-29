import { NoopRuntimeLogger, type RuntimeLogger } from "@huanlink/core";

import {
  copyChannelInboundAccessPolicy,
  type ChannelInboundAccessPolicy,
} from "./channel-access-policy.js";
import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import type { ServerChannelRuntimeConfig } from "./local-user-config.js";

export type ChannelAccessPolicyWatcher = {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type ChannelAccessPolicyWatchFactory = (
  path: string,
  options: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => ChannelAccessPolicyWatcher;

export type ChannelAccessPolicyReloader = {
  close(): Promise<void>;
};

export type CreateChannelAccessPolicyReloaderOptions = {
  readonly configRoot: string;
  readonly initialConfig: ServerChannelRuntimeConfig;
  readonly loadConfig: () => Promise<ServerChannelRuntimeConfig>;
  readonly applyPolicies: (
    policies: ReadonlyMap<string, ChannelInboundAccessPolicy>,
  ) => void;
  readonly watchFactory: ChannelAccessPolicyWatchFactory;
  readonly logger?: RuntimeLogger;
  readonly debounceMs?: number;
};

/**
 * 监听 Server 配置树，并且只允许群聊/私聊接收名单在进程内更新。
 *
 * 每次变更都重新读取完整配置，与启动快照比较；任何其他字段变化都要求重启，
 * 以免连接地址、凭证或 Adapter 配置在运行中出现半更新状态。
 */
export function createChannelAccessPolicyReloader(
  options: CreateChannelAccessPolicyReloaderOptions,
): ChannelAccessPolicyReloader {
  const initialConfig = snapshotConfig(options.initialConfig);
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger(),
  );
  const debounceMs = options.debounceMs ?? 200;
  let closed = false;
  let changeGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloadInProgress = false;

  const watcher = options.watchFactory(
    options.configRoot,
    { recursive: true },
    onWatchChange,
  );
  watcher.on("error", onWatcherError);

  return { close };

  function onWatchChange(
    _eventType: string,
    _filename: string | Buffer | null,
  ): void {
    if (closed) {
      return;
    }
    changeGeneration += 1;
    if (reloadInProgress) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      startReload();
    }, debounceMs);
  }

  function onWatcherError(_error: Error): void {
    if (!closed) {
      logger.warn("channel.access_policy.watcher_failed", {
        reason: "watcher_error",
      });
    }
  }

  function startReload(): void {
    if (closed || reloadInProgress) {
      return;
    }
    const generation = changeGeneration;
    reloadInProgress = true;
    void reload(generation).finally(() => {
      reloadInProgress = false;
      if (!closed && changeGeneration !== generation) {
        scheduleReload();
      }
    });
  }

  function scheduleReload(): void {
    if (timer !== undefined || closed || reloadInProgress) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      startReload();
    }, debounceMs);
  }

  async function reload(generation: number): Promise<void> {
    let loadedConfig: ServerChannelRuntimeConfig;
    try {
      loadedConfig = await options.loadConfig();
    } catch {
      if (!closed && changeGeneration === generation) {
        logger.warn("channel.access_policy.reload_failed", {
          reason: "invalid_configuration",
        });
      }
      return;
    }

    if (closed || changeGeneration !== generation) {
      return;
    }

    if (!matchesNonReloadableConfiguration(initialConfig, loadedConfig)) {
      logger.warn("channel.access_policy.reload_rejected", {
        reason: "restart_required",
      });
      return;
    }

    let policies: ReadonlyMap<string, ChannelInboundAccessPolicy>;
    try {
      policies = policiesFromConfig(loadedConfig);
    } catch {
      logger.warn("channel.access_policy.reload_failed", {
        reason: "invalid_configuration",
      });
      return;
    }

    if (closed || changeGeneration !== generation) {
      return;
    }

    try {
      options.applyPolicies(policies);
    } catch {
      if (!closed) {
        logger.warn("channel.access_policy.reload_failed", {
          reason: "application_failed",
        });
      }
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    try {
      watcher.close();
    } catch {
      logger.warn("channel.access_policy.watcher_close_failed", {
        reason: "watcher_close_failed",
      });
    }
  }
}

function snapshotConfig(
  config: ServerChannelRuntimeConfig,
): ServerChannelRuntimeConfig {
  return {
    ...(config.mainAgent === undefined
      ? {}
      : { mainAgent: { ...config.mainAgent } }),
    channels: config.channels.map((channel) => ({
      ...channel,
      inboundPolicy: copyChannelInboundAccessPolicy(channel.inboundPolicy),
    })),
    agents: config.agents.map((agent) => ({ ...agent })),
    ...(config.orchestration === undefined
      ? {}
      : {
          orchestration: {
            defaultAgentId: config.orchestration.defaultAgentId,
            a2aTaskPolicy: {
              maxActiveTasksPerSession:
                config.orchestration.a2aTaskPolicy.maxActiveTasksPerSession,
            },
            asyncToolTaskPolicy: {
              maxActiveTasksPerSession:
                config.orchestration.asyncToolTaskPolicy
                  .maxActiveTasksPerSession,
            },
          },
        }),
    sources: {
      ...(config.sources.mainAgent === undefined
        ? {}
        : { mainAgent: config.sources.mainAgent }),
      ...(config.sources.orchestration === undefined
        ? {}
        : { orchestration: config.sources.orchestration }),
      channels: [...config.sources.channels],
      agents: [...config.sources.agents],
    },
  };
}

function policiesFromConfig(
  config: ServerChannelRuntimeConfig,
): ReadonlyMap<string, ChannelInboundAccessPolicy> {
  const policies = new Map<string, ChannelInboundAccessPolicy>();
  for (const channel of config.channels) {
    if (policies.has(channel.channelId)) {
      throw new TypeError(
        "Channel configuration contains duplicate channel IDs",
      );
    }
    policies.set(
      channel.channelId,
      copyChannelInboundAccessPolicy(channel.inboundPolicy),
    );
  }
  return policies;
}

function matchesNonReloadableConfiguration(
  initialConfig: ServerChannelRuntimeConfig,
  candidateConfig: ServerChannelRuntimeConfig,
): boolean {
  return valuesEqual(
    withoutInboundPolicies(initialConfig),
    withoutInboundPolicies(candidateConfig),
  );
}

function withoutInboundPolicies(config: ServerChannelRuntimeConfig): unknown {
  return {
    mainAgent: config.mainAgent,
    channels: config.channels.map(
      ({ inboundPolicy: _inboundPolicy, ...channel }) => channel,
    ),
    agents: config.agents,
    orchestration: config.orchestration,
    sources: config.sources,
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
