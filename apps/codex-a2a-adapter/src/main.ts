import { fileURLToPath } from "node:url";

import { createCodexAdapterRuntimeLogger } from "./adapter-runtime-logger.js";
import { parseLogLevel } from "./runtime-config.js";
import { startConfiguredCodexAdapterRuntime } from "./runtime.js";

const logger = createCodexAdapterRuntimeLogger({
  level: parseLogLevel(process.env.HUANLINK_LOG_LEVEL ?? "info"),
  moduleUrl: import.meta.url,
});

try {
  logger.info("adapter.process.starting");
  const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const runtime = await startConfiguredCodexAdapterRuntime({
    projectRoot,
    logger,
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
      },
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
