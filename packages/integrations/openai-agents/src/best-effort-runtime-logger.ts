import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger
} from "@huanlink/core";

export function bestEffortRuntimeLogger(
  logger: RuntimeLogger | undefined
): RuntimeLogger {
  return new BestEffortRuntimeLogger(logger ?? new NoopRuntimeLogger());
}

export function safeRuntimeErrorType(error: unknown): string {
  try {
    return error instanceof Error ? "Error" : typeof error;
  } catch {
    return "unknown";
  }
}

class BestEffortRuntimeLogger implements RuntimeLogger {
  constructor(private readonly delegate: RuntimeLogger) {}

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

  child(bindings: RuntimeLogFields): RuntimeLogger {
    try {
      return new BestEffortRuntimeLogger(this.delegate.child(bindings));
    } catch {
      return new NoopRuntimeLogger();
    }
  }

  private write(
    level: RuntimeLogLevel,
    message: string,
    fields?: RuntimeLogFields
  ): void {
    try {
      this.delegate[level](message, fields);
    } catch {
      // Runtime logging must never change tool execution semantics.
    }
  }
}
