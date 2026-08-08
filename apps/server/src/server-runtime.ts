import { watch } from "node:fs";

import {
  NoopRuntimeLogger,
  type ChannelAdapterV1,
  type RuntimeLogger
} from "@huanlink/core";
import { createForwardWebSocketOneBot11ChannelAdapterV1 } from "@huanlink/integration-onebot11";

import {
  createChannelAccessPolicyReloader,
  type ChannelAccessPolicyReloader,
  type ChannelAccessPolicyWatchFactory
} from "./channel-access-policy-reloader.js";
import {
  createChannelRuntime,
  type ChannelRuntime,
  type ChannelRuntimeMessage
} from "./channel-runtime.js";
import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import type { ServerChannelRuntimeConfig } from "./local-user-config.js";

type ServerChannelConfig = ServerChannelRuntimeConfig["channels"][number];

export type ServerChannelAdapterFactory = (
  config: ServerChannelConfig,
  logger: RuntimeLogger
) => ChannelAdapterV1;

export type CreateServerRuntimeOptions = {
  readonly config: ServerChannelRuntimeConfig;
  readonly configRoot: string;
  readonly loadConfig: () => Promise<ServerChannelRuntimeConfig>;
  readonly onChannelMessage: (
    input: ChannelRuntimeMessage
  ) => Promise<void> | void;
  readonly createChannelAdapter?: ServerChannelAdapterFactory;
  readonly watchFactory?: ChannelAccessPolicyWatchFactory;
  readonly logger?: RuntimeLogger;
};

/**
 * 正式 Server Channel 组合根。
 *
 * 本层只装配 V1 Adapter、Channel Runtime、名单热重载和统一事件出口；
 * 不保存 Session，不选择 Agent，也不判断一条消息是否应触发 Agent。
 */
export interface ServerRuntime {
  readonly channels: ChannelRuntime;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createServerRuntime(
  options: CreateServerRuntimeOptions
): ServerRuntime {
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger()
  );
  const createAdapter =
    options.createChannelAdapter ?? createConfiguredChannelAdapter;
  const channels = createChannelRuntime({
    channels: options.config.channels.map((config) => ({
      adapter: createAdapter(
        config,
        logger.child({
          source: "channel.adapter",
          channelId: config.channelId
        })
      ),
      inboundPolicy: config.inboundPolicy
    })),
    onMessage: options.onChannelMessage,
    onBackgroundError: (error, context) => {
      logger.error("channel.server.background_failed", {
        ...context,
        errorType: error.name
      });
    },
    logger: logger.child({ source: "channel.runtime" })
  });
  const policyReloader = createChannelAccessPolicyReloader({
    configRoot: options.configRoot,
    initialConfig: options.config,
    loadConfig: options.loadConfig,
    applyPolicies: (policies) => channels.replaceAccessPolicies(policies),
    watchFactory: options.watchFactory ?? nodeWatchFactory,
    logger: logger.child({ source: "channel.access_policy" })
  });
  let closeOperation: Promise<void> | undefined;

  return {
    channels,
    start: () => channels.start(),
    close() {
      closeOperation ??= closeServerRuntime(policyReloader, channels);
      return closeOperation;
    }
  };
}

function createConfiguredChannelAdapter(
  config: ServerChannelConfig,
  logger: RuntimeLogger
): ChannelAdapterV1 {
  switch (config.type) {
    case "onebot11-forward-websocket":
      return createForwardWebSocketOneBot11ChannelAdapterV1({
        channelId: config.channelId,
        url: config.url,
        ...(config.accessToken === undefined
          ? {}
          : { accessToken: config.accessToken }),
        onError: (error) => {
          logger.error("channel.adapter.background_failed", {
            errorType: error.name
          });
        },
        logger
      });
  }
}

const nodeWatchFactory: ChannelAccessPolicyWatchFactory = (
  path,
  options,
  listener
) => watch(path, options, listener);

async function closeServerRuntime(
  reloader: ChannelAccessPolicyReloader,
  channels: ChannelRuntime
): Promise<void> {
  const failures: Error[] = [];
  try {
    await reloader.close();
  } catch (error) {
    failures.push(normalizeError(error));
  }
  try {
    await channels.close();
  } catch (error) {
    failures.push(normalizeError(error));
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "ServerRuntime close failed");
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
