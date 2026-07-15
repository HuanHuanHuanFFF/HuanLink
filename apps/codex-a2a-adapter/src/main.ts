import { fileURLToPath } from "node:url";

import { createCodexAdapterRuntimeLogger } from "./adapter-runtime-logger.js";
import { parseHost, parseLogLevel, parsePort } from "./runtime-config.js";
import { startCodexAdapterRuntime } from "./runtime.js";

const logger = createCodexAdapterRuntimeLogger({
  level: parseLogLevel(process.env.HUANLINK_LOG_LEVEL ?? "info"),
  moduleUrl: import.meta.url
});

try {
  logger.info("adapter.process.starting");
  const host = parseHost(process.env.HUANLINK_CODEX_A2A_HOST ?? "127.0.0.1");
  const port = parsePort(process.env.HUANLINK_CODEX_A2A_PORT ?? "4000");
  const workspace =
    process.env.HUANLINK_CODEX_WORKSPACE ??
    fileURLToPath(new URL("../../..", import.meta.url));
  const runtime = await startCodexAdapterRuntime({
    codexExecutable:
      process.env.HUANLINK_CODEX_EXECUTABLE ??
      (process.platform === "win32" ? "codex.cmd" : "codex"),
    codexModel: process.env.HUANLINK_CODEX_MODEL ?? "gpt-5.4-mini",
    expectedBranch: "spike/demo-v0",
    expectedCodexVersion:
      process.env.HUANLINK_CODEX_EXPECTED_VERSION ?? "0.144.1",
    host,
    logger,
    port,
    workspace
  });
  logger.info("adapter.process.started", { origin: runtime.origin });
  console.log(`Codex A2A adapter listening at ${runtime.origin}`);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    if (shutdownPromise) {
      return;
    }
    logger.info("adapter.process.stopping");
    shutdownPromise = runtime.close();
    void shutdownPromise.then(
      async () => {
        logger.info("adapter.process.stopped");
        await logger.close();
        process.exit(0);
      },
      async (error: unknown) => {
        logger.error("adapter.process.stop_failed", { error });
        await logger.close();
        console.error("Failed to stop Codex A2A adapter", error);
        process.exit(1);
      }
    );
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, shutdown);
  }
} catch (error) {
  logger.error("adapter.process.start_failed", { error });
  await logger.close();
  console.error(`Failed to start Codex A2A adapter: ${errorMessage(error)}`);
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
