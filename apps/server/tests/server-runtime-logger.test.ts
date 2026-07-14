import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { FlushableRuntimeLogger } from "@huanlink/core";
import { afterEach, describe, expect, test } from "vitest";

import * as server from "../src/index.js";
import type { Phase4QqRuntimeConfig } from "../src/runtime-config.js";

type RuntimeLoggerExports = typeof server & {
  createPhase4ServerRuntimeLogger(options: {
    config: Phase4QqRuntimeConfig;
    moduleUrl: string;
  }): FlushableRuntimeLogger;
  resolvePhase4ServerLogPath(moduleUrl: string): string;
};

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirectories.clear();
});

describe("Phase 4 server runtime logger", () => {
  test("is exported from the server package", () => {
    expect(typeof runtimeLogging().createPhase4ServerRuntimeLogger).toBe(
      "function"
    );
    expect(typeof runtimeLogging().resolvePhase4ServerLogPath).toBe("function");
  });

  test("writes the shutdown tail under the repository log path with configured secrets redacted", async () => {
    const directory = await createTempDirectory();
    const moduleUrl = pathToFileURL(
      join(directory, "apps", "server", "dist", "main.js")
    ).href;
    const logPath = join(directory, ".huanlink", "logs", "server.jsonl");
    const deepSeekKey = "deepseek-server-secret";
    const oneBotToken = "onebot-server-secret";
    const logger = runtimeLogging().createPhase4ServerRuntimeLogger({
      moduleUrl,
      config: phase4Config(deepSeekKey, oneBotToken)
    });

    expect(runtimeLogging().resolvePhase4ServerLogPath(moduleUrl)).toBe(logPath);
    logger.info(`shutdown tail ${deepSeekKey}`, {
      providerCredential: deepSeekKey,
      gatewayCredential: oneBotToken
    });
    await logger.close();

    const raw = await readFile(logPath, "utf8");
    expect(raw).toContain("shutdown tail [Redacted]");
    expect(raw).not.toContain(deepSeekKey);
    expect(raw).not.toContain(oneBotToken);
  });

  test("redacts configured URL credentials and query values from error logs", async () => {
    const directory = await createTempDirectory();
    const moduleUrl = pathToFileURL(
      join(directory, "apps", "server", "dist", "main.js")
    ).href;
    const logPath = join(directory, ".huanlink", "logs", "server.jsonl");
    const config = phase4Config("deepseek-key", "onebot-token");
    config.oneBot11.url =
      "ws://onebot-user-secret:onebot-password-secret@127.0.0.1:3001/?session=onebot-query-secret";
    config.mainAgentModel.baseURL =
      "https://deepseek-user-secret:deepseek-password-secret@api.deepseek.com/beta?session=deepseek-query-secret";
    const logger = runtimeLogging().createPhase4ServerRuntimeLogger({
      moduleUrl,
      config
    });

    logger.error("provider connection failed", {
      error: new Error(
        `${config.oneBot11.url} ${config.mainAgentModel.baseURL}`
      )
    });
    await logger.close();

    const raw = await readFile(logPath, "utf8");
    for (const secret of [
      "onebot-user-secret",
      "onebot-password-secret",
      "onebot-query-secret",
      "deepseek-user-secret",
      "deepseek-password-secret",
      "deepseek-query-secret"
    ]) {
      expect(raw).not.toContain(secret);
    }
  });
});

function runtimeLogging(): RuntimeLoggerExports {
  return server as RuntimeLoggerExports;
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "huanlink-server-log-"));
  tempDirectories.add(directory);
  return directory;
}

function phase4Config(
  deepSeekKey: string,
  oneBotToken: string
): Phase4QqRuntimeConfig {
  return {
    oneBot11: {
      url: "ws://127.0.0.1:3001/",
      accessToken: oneBotToken,
      groupId: "20002",
      commandPrefix: "/huanlink"
    },
    codexA2a: {
      origin: "http://127.0.0.1:4000",
      skillId: "codex-code-task"
    },
    mainAgentModel: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com/beta",
      apiKey: deepSeekKey
    },
    logging: {
      level: "info"
    }
  };
}
