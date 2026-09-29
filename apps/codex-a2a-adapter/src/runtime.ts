import {
  CodexAppServerClient,
  spawnCodexAppServerTransport,
  type SpawnCodexAppServerOptions,
  type CodexAppServerTransport,
} from "./codex-app-server-client.js";
import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger,
} from "@huanlink/core";
import { CodexTaskExecutor } from "./codex-task-executor.js";
import { startAdapterServer } from "./server.js";
import { validateDemoWorkspace } from "./workspace-guard.js";
import { isAbsolute, resolve, win32, join } from "node:path";
import type { CodexProject } from "./dispatch-policy.js";
import { loadCodexAdapterLocalConfig } from "./runtime-config.js";

export interface StartCodexAdapterRuntimeOptions {
  spawnTransport?: (
    options: SpawnCodexAppServerOptions,
  ) => CodexAppServerTransport;
  codexExecutable: string;
  projects: readonly CodexProject[];
  projectRoot: string;
  heartbeatIntervalMs?: number;
  expectedCodexVersion: string;
  host: string;
  logger?: RuntimeLogger;
  port: number;
}

export interface RunningCodexAdapterRuntime {
  origin: string;
  close(): Promise<void>;
}

export async function startConfiguredCodexAdapterRuntime(options: {
  projectRoot: string;
  logger?: RuntimeLogger;
  spawnTransport?: StartCodexAdapterRuntimeOptions["spawnTransport"];
}): Promise<RunningCodexAdapterRuntime> {
  const config = await loadCodexAdapterLocalConfig({
    configRoot: join(options.projectRoot, ".huanlink", "config"),
  });
  return startCodexAdapterRuntime({
    ...config.runtime,
    projects: config.projects,
    ...options,
  });
}

export async function startCodexAdapterRuntime(
  options: StartCodexAdapterRuntimeOptions,
): Promise<RunningCodexAdapterRuntime> {
  const logger = options.logger ?? new NoopRuntimeLogger();
  writeLog(logger, "info", "adapter.runtime.starting", {
    host: options.host,
    port: options.port,
  });
  const projects = await Promise.all(
    options.projects.map(async (project) => {
      if (win32.isAbsolute(project.workspace) && !isAbsolute(project.workspace))
        throw new Error("Project workspace belongs to a different platform");
      const validated = await validateDemoWorkspace(
        resolve(options.projectRoot, project.workspace),
        project.branch,
      );
      return { ...project, workspace: validated.workspace };
    }),
  );
  writeLog(logger, "info", "codex.app_server.starting");
  const transport = (options.spawnTransport ?? spawnCodexAppServerTransport)({
    executable: options.codexExecutable,
    cwd: options.projectRoot,
  });
  const client = await CodexAppServerClient.connect({
    transport,
    expectedVersion: options.expectedCodexVersion,
  });
  writeLog(logger, "info", "codex.app_server.connected");
  let executor: CodexTaskExecutor | undefined;
  let server;
  try {
    executor = new CodexTaskExecutor({
      client,
      logger,
      projects,
      models: await client.listModels(),
    });
    const activeExecutor = executor;
    server = await startAdapterServer({
      executor: activeExecutor,
      validateMessage: (message) => activeExecutor.validateMessage(message),
      host: options.host,
      port: options.port,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
    writeLog(logger, "info", "adapter.a2a.started", {
      origin: server.origin,
    });
  } catch (error) {
    await executor?.close();
    await client.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const activeExecutor = executor;
  return {
    origin: server.origin,
    close() {
      closePromise ??= closeRuntime(
        server.close(),
        activeExecutor,
        client,
        logger,
      );
      return closePromise;
    },
  };
}

async function closeRuntime(
  serverClosing: Promise<void>,
  executor: CodexTaskExecutor,
  client: CodexAppServerClient,
  logger: RuntimeLogger,
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
      errorCount: errors.length,
    });
    throw new AggregateError(errors, "Failed to stop Codex A2A runtime");
  }
  writeLog(logger, "info", "adapter.runtime.stopped");
}

function writeLog(
  logger: RuntimeLogger,
  level: RuntimeLogLevel,
  message: string,
  fields?: RuntimeLogFields,
): void {
  try {
    logger[level](message, fields);
  } catch {
    // Logging must not change runtime startup or shutdown.
  }
}
