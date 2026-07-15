import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";

import { createPinoRuntimeLogger } from "./pino-runtime-logger.js";
import type {
  FlushableRuntimeLogger,
  PinoRuntimeLoggerInput,
  RuntimeLogFields,
  RuntimeLogger
} from "./types.js";

class JsonlFileDestination extends Writable {
  private parentCreated = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly redactValues: readonly string[]
  ) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    void this.append(text).then(
      () => callback(),
      (error: unknown) => {
        reportSinkError(error, this.redactValues);
        callback();
      }
    );
  }

  async flush(): Promise<void> {
    if (this.writableEnded || this.destroyed) {
      await this.closePromise;
      return;
    }

    await new Promise<void>((resolveFlush) => {
      try {
        this.write("", () => resolveFlush());
      } catch (error) {
        reportSinkError(error, this.redactValues);
        resolveFlush();
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closePromise = new Promise<void>((resolveClose) => {
      try {
        this.end(() => resolveClose());
      } catch (error) {
        reportSinkError(error, this.redactValues);
        resolveClose();
      }
    });

    return this.closePromise;
  }

  private async append(text: string): Promise<void> {
    if (!this.parentCreated) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.parentCreated = true;
    }

    if (text.length > 0) {
      await appendFile(this.filePath, text, "utf8");
    }
  }
}

class SharedJsonlLifecycle {
  private closed = false;

  constructor(private readonly destination: JsonlFileDestination) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async flush(): Promise<void> {
    await this.destination.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.destination.close();
  }
}

class JsonlFileRuntimeLogger implements FlushableRuntimeLogger {
  constructor(
    private readonly delegate: RuntimeLogger,
    private readonly lifecycle: SharedJsonlLifecycle,
    private readonly redactValues: readonly string[]
  ) {}

  debug(message: string, fields?: RuntimeLogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: RuntimeLogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: RuntimeLogFields): void {
    this.write("error", message, fields);
  }

  child(bindings: RuntimeLogFields): FlushableRuntimeLogger {
    return new JsonlFileRuntimeLogger(
      this.delegate.child(bindings),
      this.lifecycle,
      this.redactValues
    );
  }

  async flush(): Promise<void> {
    await this.lifecycle.flush();
  }

  async close(): Promise<void> {
    await this.lifecycle.close();
  }

  private write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: RuntimeLogFields
  ): void {
    if (this.lifecycle.isClosed) {
      return;
    }

    try {
      this.delegate[level](message, fields);
    } catch (error) {
      reportSinkError(error, this.redactValues);
    }
  }
}

export function createJsonlFileRuntimeLogger(
  filePath: string,
  options: PinoRuntimeLoggerInput = {}
): FlushableRuntimeLogger {
  const redactValues = normalizeRedactValues(options.redactValues);
  const destination = new JsonlFileDestination(resolve(filePath), redactValues);
  const delegate = createPinoRuntimeLogger(options, destination);
  const lifecycle = new SharedJsonlLifecycle(destination);

  return new JsonlFileRuntimeLogger(delegate, lifecycle, redactValues);
}

function normalizeRedactValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  );
}

function reportSinkError(error: unknown, redactValues: readonly string[]): void {
  let detail = error instanceof Error ? error.message : String(error);

  for (const redactValue of redactValues) {
    detail = detail.split(redactValue).join("[Redacted]");
  }

  try {
    process.stderr.write(`HuanLink runtime log sink error: ${detail}\n`);
  } catch {
    // Sink diagnostics must never fail the business operation.
  }
}
