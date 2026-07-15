import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createJsonlFileRuntimeLogger,
  type FlushableRuntimeLogger,
  type RuntimeLogLevel
} from "@huanlink/core";

export type CreateCodexAdapterRuntimeLoggerOptions = {
  level: RuntimeLogLevel;
  moduleUrl: string;
};

export function resolveCodexAdapterLogPath(moduleUrl: string): string {
  const repositoryRoot = fileURLToPath(new URL("../../../", moduleUrl));
  return join(
    repositoryRoot,
    ".huanlink",
    "logs",
    "codex-a2a-adapter.jsonl"
  );
}

export function createCodexAdapterRuntimeLogger(
  options: CreateCodexAdapterRuntimeLoggerOptions
): FlushableRuntimeLogger {
  return createJsonlFileRuntimeLogger(resolveCodexAdapterLogPath(options.moduleUrl), {
    level: options.level,
    base: { service: "codex-a2a-adapter" }
  });
}
