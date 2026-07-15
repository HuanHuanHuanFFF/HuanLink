import type {
  RuntimeLogFields,
  RuntimeLogger
} from "@huanlink/core";

export type RecordedRuntimeLog = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: RuntimeLogFields;
};

export class RecordingRuntimeLogger implements RuntimeLogger {
  readonly entries: RecordedRuntimeLog[];

  constructor(
    entries: RecordedRuntimeLog[] = [],
    private readonly bindings: RuntimeLogFields = {}
  ) {
    this.entries = entries;
  }

  debug(message: string, fields: RuntimeLogFields = {}): void {
    this.record("debug", message, fields);
  }

  info(message: string, fields: RuntimeLogFields = {}): void {
    this.record("info", message, fields);
  }

  warn(message: string, fields: RuntimeLogFields = {}): void {
    this.record("warn", message, fields);
  }

  error(message: string, fields: RuntimeLogFields = {}): void {
    this.record("error", message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new RecordingRuntimeLogger(this.entries, {
      ...this.bindings,
      ...bindings
    });
  }

  find(message: string): RecordedRuntimeLog | undefined {
    return this.entries.find((entry) => entry.message === message);
  }

  filter(message: string): RecordedRuntimeLog[] {
    return this.entries.filter((entry) => entry.message === message);
  }

  private record(
    level: RecordedRuntimeLog["level"],
    message: string,
    fields: RuntimeLogFields
  ): void {
    this.entries.push({
      level,
      message,
      fields: { ...this.bindings, ...fields }
    });
  }
}
