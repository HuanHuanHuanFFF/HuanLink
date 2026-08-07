import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createJsonlFileRuntimeLogger,
  type FlushableRuntimeLogger
} from "@huanlink/core";

import type { ServerChannelRuntimeConfig } from "./local-user-config.js";

export type CreateServerRuntimeLoggerOptions = {
  config: ServerChannelRuntimeConfig;
  moduleUrl: string;
};

export function resolveServerLogPath(moduleUrl: string): string {
  const repositoryRoot = fileURLToPath(new URL("../../../", moduleUrl));
  return join(repositoryRoot, ".huanlink", "logs", "server.jsonl");
}

export function createServerRuntimeLogger(
  options: CreateServerRuntimeLoggerOptions
): FlushableRuntimeLogger {
  return createJsonlFileRuntimeLogger(
    resolveServerLogPath(options.moduleUrl),
    {
      level: "info",
      base: { service: "huanlink-server" },
      redactValues: [
        ...options.config.channels.flatMap((channel) => [
          ...(channel.accessToken === undefined ? [] : [channel.accessToken]),
          ...urlSecrets(channel.url)
        ]),
        ...(options.config.mainAgent === undefined
          ? []
          : urlSecrets(options.config.mainAgent.baseURL)),
        ...options.config.agents.flatMap((agent) => urlSecrets(agent.origin))
      ]
    }
  );
}

function urlSecrets(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    const parts = [
      url.username,
      url.password,
      url.search,
      ...url.searchParams.values()
    ].filter((value) => value.length > 0);
    if (parts.length > 0) {
      parts.push(rawUrl);
    }
    for (const part of [...parts]) {
      try {
        const decoded = decodeURIComponent(part);
        if (decoded.length > 0) {
          parts.push(decoded);
        }
      } catch {
        // The encoded URL component is already included.
      }
    }
    return [...new Set(parts)];
  } catch {
    return [];
  }
}
