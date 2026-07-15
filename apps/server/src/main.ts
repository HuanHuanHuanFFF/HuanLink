import { ForwardWebSocketOneBot11Channel } from "@huanlink/integration-onebot11";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import { createDeepSeekMainAgentModelBinding } from "./main-agent-model.js";
import { createPhase4QqRuntime } from "./phase4-qq-runtime.js";
import { startRuntimeWithSignalShutdown } from "./phase4-process-lifecycle.js";
import { loadPhase4QqRuntimeConfigFromEnv } from "./runtime-config.js";
import { createPhase4ServerRuntimeLogger } from "./server-runtime-logger.js";

await startPhase4QqServer().catch((error) => {
  console.error(`Failed to start HuanLink Phase 4 QQ server: ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function startPhase4QqServer(): Promise<void> {
  const config = loadPhase4QqRuntimeConfigFromEnv();
  const ownedLogger = createPhase4ServerRuntimeLogger({
    config,
    moduleUrl: import.meta.url
  });
  const logger = createBestEffortRuntimeLogger(ownedLogger);
  let lifecycleOwnsLogger = false;
  try {
    const modelBinding = createDeepSeekMainAgentModelBinding({
      config: config.mainAgentModel
    });
    const channel = new ForwardWebSocketOneBot11Channel({
      url: config.oneBot11.url,
      ...(config.oneBot11.accessToken === undefined
        ? {}
        : { accessToken: config.oneBot11.accessToken }),
      commandPrefix: config.oneBot11.commandPrefix,
      logger: logger.child({ source: "onebot11" })
    });
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: config.oneBot11.groupId,
      codexA2aOrigin: config.codexA2a.origin,
      codexSkillId: config.codexA2a.skillId,
      modelBinding,
      logger: logger.child({ source: "phase4" }),
      onBackgroundError: (error, record) => {
        logger.error("phase4.background.failed", {
          error,
          ...(record === undefined
            ? {}
            : {
                sessionId: record.sessionId,
                agentCallId: record.agentCallId,
                a2aTaskId: record.taskId,
                ...(record.contextId === undefined
                  ? {}
                  : { contextId: record.contextId })
              })
        });
      }
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
      conversationId: config.oneBot11.groupId
    });
  } catch (error) {
    if (!lifecycleOwnsLogger) {
      logger.error("process.start_failed", { error });
      await ownedLogger.close();
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
