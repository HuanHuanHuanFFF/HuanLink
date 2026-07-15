import type {
  RuntimeLogFields,
  RuntimeLogLevel,
  RuntimeLogger
} from "@huanlink/core";

export type RuntimeLogAttempt = {
  level: RuntimeLogLevel;
  message: string;
  fields: RuntimeLogFields;
};

export type ThrowingRuntimeLoggerOptions = {
  failure?: Error;
  throwOnChild?: boolean;
  throwWhen?: (attempt: RuntimeLogAttempt) => boolean;
};

export class ThrowingRuntimeLogger implements RuntimeLogger {
  readonly attempts: RuntimeLogAttempt[];

  constructor(
    private readonly options: ThrowingRuntimeLoggerOptions,
    attempts: RuntimeLogAttempt[] = [],
    private readonly bindings: RuntimeLogFields = {}
  ) {
    this.attempts = attempts;
  }

  debug(message: string, fields?: RuntimeLogFields): void {
    this.record("debug", message, fields);
  }

  info(message: string, fields?: RuntimeLogFields): void {
    this.record("info", message, fields);
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    this.record("warn", message, fields);
  }

  error(message: string, fields?: RuntimeLogFields): void {
    this.record("error", message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    if (this.options.throwOnChild) {
      throw this.failure();
    }
    return new ThrowingRuntimeLogger(
      this.options,
      this.attempts,
      { ...this.bindings, ...bindings }
    );
  }

  private record(
    level: RuntimeLogLevel,
    message: string,
    fields: RuntimeLogFields = {}
  ): void {
    const attempt = {
      level,
      message,
      fields: { ...this.bindings, ...fields }
    };
    this.attempts.push(attempt);
    if (this.options.throwWhen?.(attempt)) {
      throw this.failure();
    }
  }

  private failure(): Error {
    return this.options.failure ?? new Error("Runtime logger failed");
  }
}
