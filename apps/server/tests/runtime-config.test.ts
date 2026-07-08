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
  "HUANLINK_LOG_LEVEL"
] as const;

let originalCwd: string;
let tempRoot: string;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huanlink-server-runtime-config-"));
  originalEnv = snapshotEnv();
  clearRuntimeConfigEnv();
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
    HUANLINK_LOG_LEVEL: process.env.HUANLINK_LOG_LEVEL
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
