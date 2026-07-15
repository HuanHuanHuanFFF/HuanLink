import {
  CodexAppServerClient,
  spawnCodexAppServerTransport
} from "./codex-app-server-client.js";
import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger
} from "@huanlink/core";
import { CodexTaskExecutor } from "./codex-task-executor.js";
import { startAdapterServer } from "./server.js";
import { validateDemoWorkspace } from "./workspace-guard.js";

export interface StartCodexAdapterRuntimeOptions {
  codexExecutable: string;
  codexModel: string;
  expectedBranch: string;
  expectedCodexVersion: string;
  host: string;
  logger?: RuntimeLogger;
  port: number;
  workspace: string;
}

export interface RunningCodexAdapterRuntime {
  origin: string;
  close(): Promise<void>;
}

export async function startCodexAdapterRuntime(
  options: StartCodexAdapterRuntimeOptions
): Promise<RunningCodexAdapterRuntime> {
  const logger = options.logger ?? new NoopRuntimeLogger();
  writeLog(logger, "info", "adapter.runtime.starting", {
    host: options.host,
    port: options.port,
    model: options.codexModel
  });
  const validated = await validateDemoWorkspace(
    options.workspace,
    options.expectedBranch
  );
  writeLog(logger, "info", "adapter.workspace.validated", {
    branch: validated.branch,
    workspace: validated.workspace
  });
  writeLog(logger, "info", "codex.app_server.starting");
  const transport = spawnCodexAppServerTransport({
    executable: options.codexExecutable,
    cwd: validated.workspace
  });
  const client = await CodexAppServerClient.connect({
    transport,
    expectedVersion: options.expectedCodexVersion
  });
  writeLog(logger, "info", "codex.app_server.connected");
  const executor = new CodexTaskExecutor({
    client,
    model: options.codexModel,
    logger,
    workspace: validated.workspace,
    expectedBranch: options.expectedBranch
  });

  let server;
  try {
    server = await startAdapterServer({
      executor,
      host: options.host,
      port: options.port
    });
    writeLog(logger, "info", "adapter.a2a.started", {
      origin: server.origin
    });
  } catch (error) {
    await executor.close();
    await client.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin: server.origin,
    close() {
      closePromise ??= closeRuntime(server.close(), executor, client, logger);
      return closePromise;
    }
  };
}

async function closeRuntime(
  serverClosing: Promise<void>,
  executor: CodexTaskExecutor,
  client: CodexAppServerClient,
  logger: RuntimeLogger
): Promise<void> {
  writeLog(logger, "info", "adapter.runtime.stopping");
  const errors: unknown[] = [];
  try {
    await executor.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await client.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await serverClosing;
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    writeLog(logger, "error", "adapter.runtime.stop_failed", {
      errorCount: errors.length
    });
    throw new AggregateError(errors, "Failed to stop Codex A2A runtime");
  }
  writeLog(logger, "info", "adapter.runtime.stopped");
}

function writeLog(
  logger: RuntimeLogger,
  level: RuntimeLogLevel,
  message: string,
  fields?: RuntimeLogFields
): void {
  try {
    logger[level](message, fields);
  } catch {
    // Logging must not change runtime startup or shutdown.
  }
}
