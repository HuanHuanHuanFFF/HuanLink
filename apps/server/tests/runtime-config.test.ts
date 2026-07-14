import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDefaultRuntimeConfig, resolveRuntimeConfig } from "@huanlink/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import * as server from "../src/index.js";

type LoadRuntimeConfigFromEnv = (input?: {
  envFilePath?: string;
}) => ReturnType<typeof resolveRuntimeConfig>;

const ENV_KEYS = [
  "HUANLINK_EVENT_LOG_BASE_DIR",
  "HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE",
  "HUANLINK_AGENT_DEFAULT_MAX_STEPS",
  "HUANLINK_LOG_LEVEL",
  "HUANLINK_CODEX_A2A_ORIGIN",
  "HUANLINK_CODEX_A2A_SKILL_ID",
  "HUANLINK_ONEBOT_WS_URL",
  "HUANLINK_ONEBOT_ACCESS_TOKEN",
  "HUANLINK_ONEBOT_GROUP_ID",
  "HUANLINK_ONEBOT_COMMAND_PREFIX",
  "HUANLINK_MAIN_AGENT_PROVIDER",
  "HUANLINK_MAIN_AGENT_MODEL",
  "HUANLINK_DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_KEY"
] as const;

let originalCwd: string;
let tempRoot: string;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huanlink-server-runtime-config-"));
  originalEnv = snapshotEnv();
  clearRuntimeConfigEnv();
  process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
});

afterEach(async () => {
  restoreEnv(originalEnv);
  process.chdir(originalCwd);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("loadRuntimeConfigFromEnv", () => {
  test("is exported from the server package", () => {
    expect(typeof server.loadRuntimeConfigFromEnv).toBe("function");
  });

  test("loads supported runtime config keys from a .env file", async () => {
    const loadRuntimeConfigFromEnv = getLoader();
    const envFilePath = path.join(tempRoot, ".env");

    await writeFile(
      envFilePath,
      [
        "HUANLINK_EVENT_LOG_BASE_DIR=.runtime-events",
        "HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE=64",
        "HUANLINK_AGENT_DEFAULT_MAX_STEPS=12",
        "HUANLINK_LOG_LEVEL=debug"
      ].join("\n")
    );

    expect(loadRuntimeConfigFromEnv({ envFilePath })).toEqual(
      resolveRuntimeConfig({
        eventLog: {
          baseDir: ".runtime-events",
          nextSeqCacheSize: 64
        },
        agent: {
          defaultMaxSteps: 12
        },
        logging: {
          level: "debug"
        }
      })
    );
  });

  test("falls back to the current core defaults when .env and process env are absent", () => {
    const loadRuntimeConfigFromEnv = getLoader();
    const defaults = getDefaultRuntimeConfig();

    process.chdir(tempRoot);

    expect(loadRuntimeConfigFromEnv()).toEqual(defaults);
  });

  test("throws at startup when a numeric env value is invalid", () => {
    const loadRuntimeConfigFromEnv = getLoader();

    process.env.HUANLINK_AGENT_DEFAULT_MAX_STEPS = "0";
    process.chdir(tempRoot);

    expect(() => loadRuntimeConfigFromEnv()).toThrow(/HUANLINK_AGENT_DEFAULT_MAX_STEPS/);
  });

  test("throws at startup when HUANLINK_LOG_LEVEL is unsupported", () => {
    const loadRuntimeConfigFromEnv = getLoader();

    process.env.HUANLINK_LOG_LEVEL = "verbose";
    process.chdir(tempRoot);

    expect(() => loadRuntimeConfigFromEnv()).toThrow(/HUANLINK_LOG_LEVEL/);
  });
});

describe("loadCodexA2aRuntimeConfigFromEnv", () => {
  test("loads the standard Agent Card origin and target skill", () => {
    process.env.HUANLINK_CODEX_A2A_ORIGIN = "http://127.0.0.1:4100";
    process.env.HUANLINK_CODEX_A2A_SKILL_ID = "codex-code-task";

    expect(server.loadCodexA2aRuntimeConfigFromEnv()).toEqual({
      origin: "http://127.0.0.1:4100",
      skillId: "codex-code-task"
    });
  });

  test("uses the local Demo Adapter defaults", () => {
    process.chdir(tempRoot);

    expect(server.loadCodexA2aRuntimeConfigFromEnv()).toEqual({
      origin: "http://127.0.0.1:4000",
      skillId: "codex-code-task"
    });
  });

  test("rejects an invalid Adapter origin at startup", () => {
    process.env.HUANLINK_CODEX_A2A_ORIGIN = "not-a-url";

    expect(() => server.loadCodexA2aRuntimeConfigFromEnv()).toThrow(
      /HUANLINK_CODEX_A2A_ORIGIN/
    );
  });
});

describe("loadPhase4QqRuntimeConfigFromEnv", () => {
  test("is exported from the server package", () => {
    expect(typeof server.loadPhase4QqRuntimeConfigFromEnv).toBe("function");
  });

  test("loads real OneBot 11 WebSocket and Codex A2A settings", () => {
    process.env.HUANLINK_ONEBOT_WS_URL = "wss://qq-gateway.example.test/";
    process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = "onebot-secret";
    process.env.HUANLINK_ONEBOT_GROUP_ID = "1234567890";
    process.env.HUANLINK_ONEBOT_COMMAND_PREFIX = "!huanlink";
    process.env.HUANLINK_CODEX_A2A_ORIGIN = "http://127.0.0.1:4100";
    process.env.HUANLINK_CODEX_A2A_SKILL_ID = "codex-code-task";
    process.env.HUANLINK_MAIN_AGENT_PROVIDER = "deepseek";
    process.env.HUANLINK_MAIN_AGENT_MODEL = "deepseek-v4-flash";
    process.env.HUANLINK_DEEPSEEK_BASE_URL = "https://api.deepseek.com/beta";
    process.env.HUANLINK_LOG_LEVEL = "debug";

    expect(server.loadPhase4QqRuntimeConfigFromEnv()).toEqual({
      oneBot11: {
        url: "wss://qq-gateway.example.test/",
        accessToken: "onebot-secret",
        groupId: "1234567890",
        commandPrefix: "!huanlink"
      },
      codexA2a: {
        origin: "http://127.0.0.1:4100",
        skillId: "codex-code-task"
      },
      mainAgentModel: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/beta",
        apiKey: "test-deepseek-key"
      },
      logging: {
        level: "debug"
      }
    });
  });

  test("uses Demo defaults and omits an empty access token", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = "   ";
    process.chdir(tempRoot);

    expect(server.loadPhase4QqRuntimeConfigFromEnv()).toEqual({
      oneBot11: {
        url: "ws://127.0.0.1:3001/",
        groupId: "20002000",
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
        apiKey: "test-deepseek-key"
      },
      logging: {
        level: "info"
      }
    });
  });

  test("rejects startup when the DeepSeek API key is missing", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    delete process.env.DEEPSEEK_API_KEY;

    expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
      /DEEPSEEK_API_KEY/
    );
  });

  test("rejects unsupported MainAgent providers", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.HUANLINK_MAIN_AGENT_PROVIDER = "openai";

    expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
      /HUANLINK_MAIN_AGENT_PROVIDER/
    );
  });

  test("rejects a non-HTTPS DeepSeek base URL", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.HUANLINK_DEEPSEEK_BASE_URL = "http://api.deepseek.com/beta";

    expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
      /HUANLINK_DEEPSEEK_BASE_URL/
    );
  });

  test("reports a malformed DeepSeek base URL as a named validation error", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.HUANLINK_DEEPSEEK_BASE_URL = "not-a-url";

    expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
      /HUANLINK_DEEPSEEK_BASE_URL/
    );
  });

  test("does not include the DeepSeek API key in validation errors", () => {
    const apiKey = "deepseek-secret-that-must-not-leak";
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.DEEPSEEK_API_KEY = apiKey;
    process.env.HUANLINK_MAIN_AGENT_PROVIDER = "unsupported";

    let thrown: unknown;
    try {
      server.loadPhase4QqRuntimeConfigFromEnv();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(apiKey);
  });

  test.each(["http://127.0.0.1:3001/", "not-a-url"])(
    "rejects unsupported OneBot WebSocket URL %s",
    (url) => {
      process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
      process.env.HUANLINK_ONEBOT_WS_URL = url;

      expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
        /HUANLINK_ONEBOT_WS_URL/
      );
    }
  );

  test.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "01",
    "9007199254740992"
  ])(
    "rejects invalid target group ID %s",
    (groupId) => {
      if (groupId === undefined) {
        delete process.env.HUANLINK_ONEBOT_GROUP_ID;
      } else {
        process.env.HUANLINK_ONEBOT_GROUP_ID = groupId;
      }

      expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
        /HUANLINK_ONEBOT_GROUP_ID/
      );
    }
  );

  test("rejects an empty command prefix", () => {
    process.env.HUANLINK_ONEBOT_GROUP_ID = "20002000";
    process.env.HUANLINK_ONEBOT_COMMAND_PREFIX = "   ";

    expect(() => server.loadPhase4QqRuntimeConfigFromEnv()).toThrow(
      /HUANLINK_ONEBOT_COMMAND_PREFIX/
    );
  });
});

function getLoader(): LoadRuntimeConfigFromEnv {
  expect(typeof server.loadRuntimeConfigFromEnv).toBe("function");

  return server.loadRuntimeConfigFromEnv as LoadRuntimeConfigFromEnv;
}

function clearRuntimeConfigEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return {
    HUANLINK_EVENT_LOG_BASE_DIR: process.env.HUANLINK_EVENT_LOG_BASE_DIR,
    HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE:
      process.env.HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE,
    HUANLINK_AGENT_DEFAULT_MAX_STEPS:
      process.env.HUANLINK_AGENT_DEFAULT_MAX_STEPS,
    HUANLINK_LOG_LEVEL: process.env.HUANLINK_LOG_LEVEL,
    HUANLINK_CODEX_A2A_ORIGIN: process.env.HUANLINK_CODEX_A2A_ORIGIN,
    HUANLINK_CODEX_A2A_SKILL_ID: process.env.HUANLINK_CODEX_A2A_SKILL_ID,
    HUANLINK_ONEBOT_WS_URL: process.env.HUANLINK_ONEBOT_WS_URL,
    HUANLINK_ONEBOT_ACCESS_TOKEN:
      process.env.HUANLINK_ONEBOT_ACCESS_TOKEN,
    HUANLINK_ONEBOT_GROUP_ID: process.env.HUANLINK_ONEBOT_GROUP_ID,
    HUANLINK_ONEBOT_COMMAND_PREFIX:
      process.env.HUANLINK_ONEBOT_COMMAND_PREFIX,
    HUANLINK_MAIN_AGENT_PROVIDER:
      process.env.HUANLINK_MAIN_AGENT_PROVIDER,
    HUANLINK_MAIN_AGENT_MODEL: process.env.HUANLINK_MAIN_AGENT_MODEL,
    HUANLINK_DEEPSEEK_BASE_URL: process.env.HUANLINK_DEEPSEEK_BASE_URL,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY
  };
}

function restoreEnv(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>
): void {
  clearRuntimeConfigEnv();

  for (const key of ENV_KEYS) {
    const value = snapshot[key];

    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}
