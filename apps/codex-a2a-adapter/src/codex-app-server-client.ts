import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface CodexAppServerTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  close(): Promise<void>;
}

export interface CodexAppServerClientOptions {
  expectedVersion: string;
  requestTimeoutMs?: number;
  transport: CodexAppServerTransport;
}

export interface SpawnCodexAppServerOptions {
  args?: string[];
  cwd: string;
  executable: string;
  shutdownTimeoutMs?: number;
}

export interface CodexAppServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface StartCodexThreadOptions {
  cwd: string;
  developerInstructions: string;
  model: string;
}

export interface StartCodexTurnOptions {
  prompt: string;
  threadId: string;
}

export interface InterruptCodexTurnOptions {
  threadId: string;
  turnId: string;
}

export interface CodexRuntimeClient {
  close(): Promise<void>;
  interruptTurn(options: InterruptCodexTurnOptions): Promise<void>;
  onClose(listener: (error: unknown) => void): () => void;
  onNotification(
    listener: (notification: CodexAppServerNotification) => void
  ): () => void;
  startThread(options: StartCodexThreadOptions): Promise<{ threadId: string }>;
  startTurn(options: StartCodexTurnOptions): Promise<{ turnId: string }>;
}

interface InitializeResponse {
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
}

interface RpcError {
  code: number;
  data?: unknown;
  message: string;
}

interface PendingRequest {
  reject(error: unknown): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export function spawnCodexAppServerTransport(
  options: SpawnCodexAppServerOptions
): CodexAppServerTransport {
  const invocation = createSpawnInvocation(
    options.executable,
    options.args ?? ["app-server", "--stdio"]
  );
  const child = spawn(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  child.stderr.resume();

  let closePromise: Promise<void> | undefined;
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    close() {
      closePromise ??= closeChildProcess(
        child.stdin,
        () => terminateChildProcess(child.pid, child.kill.bind(child)),
        exited,
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
      );
      return closePromise;
    }
  };
}

function createSpawnInvocation(
  executable: string,
  args: string[]
): {
  executable: string;
  args: string[];
  windowsVerbatimArguments: boolean;
} {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args, windowsVerbatimArguments: false };
  }

  const command = [executable, ...args].map(quoteCmdArgument).join(" ");
  return {
    executable: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true
  };
}

function quoteCmdArgument(value: string): string {
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error("Unsafe character in Windows Codex launcher argument");
  }
  return `"${value}"`;
}

export class CodexAppServerClient implements CodexRuntimeClient {
  private readonly closeListeners = new Set<(error: unknown) => void>();
  private readonly notificationListeners = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private nextRequestId = 1;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private connectionFailure: unknown;
  private connectionFailed = false;

  private constructor(
    private readonly transport: CodexAppServerTransport,
    requestTimeoutMs: number
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    void this.readMessages();
  }

  static async connect(
    options: CodexAppServerClientOptions
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(
      options.transport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );

    try {
      const initialized = await client.request<InitializeResponse>("initialize", {
        clientInfo: {
          name: "huanlink_codex_a2a_adapter",
          title: "HuanLink Codex A2A Adapter",
          version: "0.2.0"
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      });

      if (!hasVersionToken(initialized.userAgent, options.expectedVersion)) {
        throw new Error(
          `Unexpected Codex app-server version: ${initialized.userAgent}; expected ${options.expectedVersion}`
        );
      }

      await client.notify("initialized");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.rejectPending(new Error("Codex app-server client closed"));
    }
    this.closePromise ??= this.transport.close();
    await this.closePromise;
  }

  onClose(listener: (error: unknown) => void): () => void {
    if (this.connectionFailed) {
      listener(this.connectionFailure);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async startThread(
    options: StartCodexThreadOptions
  ): Promise<{ threadId: string }> {
    const result = await this.request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
        developerInstructions: options.developerInstructions,
        model: options.model
      }
    );
    return { threadId: result.thread.id };
  }

  async startTurn(
    options: StartCodexTurnOptions
  ): Promise<{ turnId: string }> {
    const result = await this.request<{ turn: { id: string } }>("turn/start", {
      threadId: options.threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: []
        }
      ]
    });
    return { turnId: result.turn.id };
  }

  async interruptTurn(options: InterruptCodexTurnOptions): Promise<void> {
    await this.request<Record<string, never>>("turn/interrupt", options);
  }

  private request<Result>(method: string, params: unknown): Promise<Result> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }

    const id = this.nextRequestId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
        timer
      });

      void this.writeMessage({ method, id, params }).catch((error: unknown) => {
        this.failConnection(error);
      });
    });
  }

  private notify(method: string): Promise<void> {
    return this.writeMessage({ method });
  }

  private async readMessages(): Promise<void> {
    try {
      const lines = createInterface({ input: this.transport.stdout });
      for await (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      }

      if (!this.closed) {
        this.failConnection(new Error("Codex app-server stdout closed"));
      }
    } catch (error) {
      if (!this.closed) {
        this.failConnection(error);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (
      typeof message.method === "string" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      void this.writeMessage({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported Codex app-server request: ${message.method}`
        }
      }).catch((error: unknown) => {
        this.failConnection(error);
      });
      return;
    }

    if (typeof message.method === "string" && message.id === undefined) {
      const notification: CodexAppServerNotification = {
        method: message.method,
        params: isRecord(message.params) ? message.params : undefined
      };
      for (const listener of this.notificationListeners) {
        listener(notification);
      }
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (isRpcError(message.error)) {
      pending.reject(
        new Error(
          `Codex app-server RPC error ${message.error.code}: ${message.error.message}`
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  private writeMessage(message: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }

    return new Promise((resolve, reject) => {
      this.transport.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failConnection(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connectionFailed = true;
    this.connectionFailure = error;
    this.rejectPending(error);
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        // Connection cleanup must continue even if a consumer callback fails.
      }
    }
    this.closePromise ??= this.transport.close();
    void this.closePromise.catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function closeChildProcess(
  stdin: Writable,
  terminate: () => void,
  exited: Promise<void>,
  timeoutMs: number
): Promise<void> {
  if (!stdin.destroyed) {
    stdin.end();
  }

  const graceful = await observeExit(exited, timeoutMs);
  if (graceful.kind === "exited") {
    return;
  }

  terminate();
  const forced = await observeExit(exited, timeoutMs);
  if (forced.kind === "timeout") {
    throw new Error("Codex app-server did not exit after forced termination");
  }
  if (graceful.kind === "error") {
    throw graceful.error;
  }
  if (forced.kind === "error") {
    throw forced.error;
  }
}

function terminateChildProcess(
  pid: number | undefined,
  kill: () => boolean
): void {
  if (process.platform !== "win32" || pid === undefined) {
    kill();
    return;
  }

  const taskkill = spawn(
    `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`,
    ["/pid", String(pid), "/t", "/f"],
    { stdio: "ignore", windowsHide: true }
  );
  taskkill.once("error", () => {
    kill();
  });
}

async function observeExit(
  exited: Promise<void>,
  timeoutMs: number
): Promise<
  | { kind: "exited" }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(
        () => ({ kind: "exited" }) as const,
        (error: unknown) => ({ kind: "error", error }) as const
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isRpcError(value: unknown): value is RpcError {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RpcError>;
  return (
    typeof candidate.code === "number" && typeof candidate.message === "string"
  );
}

function hasVersionToken(userAgent: string, expectedVersion: string): boolean {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9.])${escaped}(?:$|[^0-9.])`).test(userAgent);
}
