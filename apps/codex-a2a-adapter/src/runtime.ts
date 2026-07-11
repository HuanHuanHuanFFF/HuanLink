import {
  CodexAppServerClient,
  spawnCodexAppServerTransport
} from "./codex-app-server-client.js";
import { CodexTaskExecutor } from "./codex-task-executor.js";
import { startAdapterServer } from "./server.js";
import { validateDemoWorkspace } from "./workspace-guard.js";

export interface StartCodexAdapterRuntimeOptions {
  codexExecutable: string;
  codexModel: string;
  expectedBranch: string;
  expectedCodexVersion: string;
  host: string;
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
  const validated = await validateDemoWorkspace(
    options.workspace,
    options.expectedBranch
  );
  const transport = spawnCodexAppServerTransport({
    executable: options.codexExecutable,
    cwd: validated.workspace
  });
  const client = await CodexAppServerClient.connect({
    transport,
    expectedVersion: options.expectedCodexVersion
  });
  const executor = new CodexTaskExecutor({
    client,
    model: options.codexModel,
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
  } catch (error) {
    await executor.close();
    await client.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin: server.origin,
    close() {
      closePromise ??= closeRuntime(server.close(), executor, client);
      return closePromise;
    }
  };
}

async function closeRuntime(
  serverClosing: Promise<void>,
  executor: CodexTaskExecutor,
  client: CodexAppServerClient
): Promise<void> {
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
    throw new AggregateError(errors, "Failed to stop Codex A2A runtime");
  }
}
