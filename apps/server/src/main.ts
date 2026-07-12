import { ForwardWebSocketOneBot11Channel } from "@huanlink/integration-onebot11";

import { createPhase4QqRuntime } from "./phase4-qq-runtime.js";
import { startRuntimeWithSignalShutdown } from "./phase4-process-lifecycle.js";
import { loadPhase4QqRuntimeConfigFromEnv } from "./runtime-config.js";

await startPhase4QqServer().catch((error) => {
  console.error(`Failed to start HuanLink Phase 4 QQ server: ${errorMessage(error)}`);
  process.exitCode = 1;
});

async function startPhase4QqServer(): Promise<void> {
  const config = loadPhase4QqRuntimeConfigFromEnv();
  const channel = new ForwardWebSocketOneBot11Channel({
    url: config.oneBot11.url,
    ...(config.oneBot11.accessToken === undefined
      ? {}
      : { accessToken: config.oneBot11.accessToken }),
    commandPrefix: config.oneBot11.commandPrefix,
    onError: (error) => {
      console.error(`OneBot 11 channel error: ${error.message}`);
    }
  });
  const runtime = createPhase4QqRuntime({
    channel,
    targetConversationId: config.oneBot11.groupId,
    codexA2aOrigin: config.codexA2a.origin,
    codexSkillId: config.codexA2a.skillId,
    onBackgroundError: (error, record) => {
      console.error(
        `Phase 4 QQ background failure${
          record === undefined
            ? ""
            : ` for ${record.agentCallId}/${record.taskId}`
        }: ${error.message}`
      );
    }
  });

  const state = await startRuntimeWithSignalShutdown({
    runtime,
    onSignal: (signal) => {
      console.info(`Received ${signal}; closing HuanLink Phase 4 QQ server.`);
    },
    onShutdownError: (error) => {
      console.error(`Failed to close HuanLink Phase 4 QQ server: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  });
  if (state === "stopped") {
    return;
  }

  console.info(
    `HuanLink Phase 4 QQ server is connected for group ${config.oneBot11.groupId}.`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
