import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import { loadServerChannelRuntimeConfig } from "./local-user-config.js";
import { startRuntimeWithSignalShutdown } from "./process-lifecycle.js";
import { createServerRuntimeLogger } from "./server-runtime-logger.js";
import { createServerRuntime } from "./server-runtime.js";

await startHuanLinkServer().catch((error) => {
  console.error(`Failed to start HuanLink server: ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function startHuanLinkServer(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const configRoot = join(projectRoot, ".huanlink", "config");
  const config = await loadServerChannelRuntimeConfig({ projectRoot });
  const ownedLogger = createServerRuntimeLogger({
    config,
    moduleUrl: import.meta.url
  });
  const logger = createBestEffortRuntimeLogger(ownedLogger);
  let lifecycleOwnsLogger = false;

  try {
    const runtime = createServerRuntime({
      config,
      configRoot,
      loadConfig: () => loadServerChannelRuntimeConfig({ projectRoot }),
      onChannelMessage: ({ sessionId, message }) => {
        logger.info("channel.server.message_forwarded", {
          sessionId,
          channelId: message.route.channelId,
          messageId: message.messageId,
          conversationKind: message.route.conversationKind,
          isSelf: message.sender.isSelf,
          contentBytes: Buffer.byteLength(message.content, "utf8"),
          ...(message.trigger === undefined
            ? {}
            : { trigger: message.trigger.kind })
        });
      },
      logger: logger.child({ source: "server.runtime" })
    });

    logger.warn("channel.server.downstream_not_configured", {
      reason: "message_queue_deferred"
    });
    lifecycleOwnsLogger = true;
    const state = await startRuntimeWithSignalShutdown({
      runtime,
      logger: logger.child({ source: "process" }),
      closeLogger: () => ownedLogger.close(),
      onShutdownError: () => {
        process.exitCode = 1;
      }
    });
    if (state === "stopped") {
      return;
    }

    logger.info("server.ready", {
      channelCount: config.channels.length
    });
  } catch (error) {
    if (!lifecycleOwnsLogger) {
      logger.error("process.start_failed", {
        errorType: error instanceof Error ? error.name : "Error"
      });
      await ownedLogger.close();
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
