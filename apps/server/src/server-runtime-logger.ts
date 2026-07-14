import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createJsonlFileRuntimeLogger,
  type FlushableRuntimeLogger
} from "@huanlink/core";

import type { Phase4QqRuntimeConfig } from "./runtime-config.js";

export type CreatePhase4ServerRuntimeLoggerOptions = {
  config: Phase4QqRuntimeConfig;
  moduleUrl: string;
};

export function resolvePhase4ServerLogPath(moduleUrl: string): string {
  const repositoryRoot = fileURLToPath(new URL("../../../", moduleUrl));
  return join(repositoryRoot, ".huanlink", "logs", "server.jsonl");
}

export function createPhase4ServerRuntimeLogger(
  options: CreatePhase4ServerRuntimeLoggerOptions
): FlushableRuntimeLogger {
  return createJsonlFileRuntimeLogger(
    resolvePhase4ServerLogPath(options.moduleUrl),
    {
      level: options.config.logging.level,
      base: { service: "huanlink-server" },
      redactValues: [
        options.config.mainAgentModel.apiKey,
        ...(options.config.oneBot11.accessToken === undefined
          ? []
          : [options.config.oneBot11.accessToken]),
        ...urlSecrets(options.config.oneBot11.url),
        ...urlSecrets(options.config.mainAgentModel.baseURL)
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
