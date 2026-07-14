import type {
  RuntimeLogFields,
  RuntimeLogLevel,
  RuntimeLogger
} from "@huanlink/core";

export type RecordedRuntimeLog = {
  fields: RuntimeLogFields;
  level: RuntimeLogLevel;
  message: string;
};

export class RecordingRuntimeLogger implements RuntimeLogger {
  constructor(
    readonly entries: RecordedRuntimeLog[] = [],
    private readonly bindings: RuntimeLogFields = {}
  ) {}

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
    return new RecordingRuntimeLogger(this.entries, {
      ...this.bindings,
      ...bindings
    });
  }

  private record(
    level: RuntimeLogLevel,
    message: string,
    fields: RuntimeLogFields = {}
  ): void {
    this.entries.push({
      level,
      message,
      fields: { ...this.bindings, ...fields }
    });
  }
}
