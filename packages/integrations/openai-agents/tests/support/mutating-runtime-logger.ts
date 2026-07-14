import type {
  RuntimeLogFields,
  RuntimeLogLevel,
  RuntimeLogger
} from "@huanlink/core";

export type MutableRuntimeLogEntry = {
  level: RuntimeLogLevel;
  message: string;
  fields: RuntimeLogFields;
};

export class MutatingRuntimeLogger implements RuntimeLogger {
  readonly entries: MutableRuntimeLogEntry[];

  constructor(
    private readonly mutate: (entry: MutableRuntimeLogEntry) => void,
    entries: MutableRuntimeLogEntry[] = [],
    private readonly bindings: RuntimeLogFields = {}
  ) {
    this.entries = entries;
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
    return new MutatingRuntimeLogger(this.mutate, this.entries, {
      ...this.bindings,
      ...bindings
    });
  }

  private record(
    level: RuntimeLogLevel,
    message: string,
    fields: RuntimeLogFields = {}
  ): void {
    const entry = {
      level,
      message,
      fields: { ...this.bindings, ...fields }
    };
    this.entries.push(entry);
    this.mutate(entry);
  }
}
