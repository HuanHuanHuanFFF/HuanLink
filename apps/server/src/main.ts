import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import { createConfiguredServerRuntime } from "./configured-server-runtime.js";
import {
  loadHuanLinkServerStaticConfig,
  loadServerChannelRuntimeConfig,
} from "./local-user-config.js";
import { startRuntimeWithSignalShutdown } from "./process-lifecycle.js";
import { createServerRuntimeLogger } from "./server-runtime-logger.js";
import { createServerSqlitePersistence } from "./server-sqlite-persistence.js";

await startHuanLinkServer().catch((error) => {
  console.error(`Failed to start HuanLink server: ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function startHuanLinkServer(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const configRoot = join(projectRoot, ".huanlink", "config");
  const staticConfig = await loadHuanLinkServerStaticConfig({ projectRoot });
  const channelConfig = await loadServerChannelRuntimeConfig({ projectRoot });
  const ownedLogger = createServerRuntimeLogger({
    config: channelConfig,
    moduleUrl: import.meta.url,
  });
  const logger = createBestEffortRuntimeLogger(ownedLogger);
  let lifecycleOwnsLogger = false;

  try {
    const runtime = await createConfiguredServerRuntime({
      staticConfig,
      channelConfig,
      configRoot,
      loadChannelConfig: () => loadServerChannelRuntimeConfig({ projectRoot }),
      createPersistence: () => createServerSqlitePersistence({ projectRoot }),
      logger: logger.child({ source: "server.runtime" }),
    });

    lifecycleOwnsLogger = true;
    const state = await startRuntimeWithSignalShutdown({
      runtime,
      logger: logger.child({ source: "process" }),
      closeLogger: () => ownedLogger.close(),
      onShutdownError: () => {
        process.exitCode = 1;
      },
    });
    if (state === "stopped") {
      return;
    }

    logger.info("server.ready", {
      channelCount: channelConfig.channels.length,
    });
  } catch (error) {
    if (!lifecycleOwnsLogger) {
      logger.error("process.start_failed", {
        errorType: error instanceof Error ? error.name : "Error",
      });
      await ownedLogger.close();
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
