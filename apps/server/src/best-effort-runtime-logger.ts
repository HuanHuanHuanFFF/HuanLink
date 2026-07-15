import type {
  RuntimeLogFields,
  RuntimeLogger
} from "@huanlink/core";

class BestEffortRuntimeLogger implements RuntimeLogger {
  constructor(
    private readonly target: RuntimeLogger,
    private readonly bindings: RuntimeLogFields = {}
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

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new BestEffortRuntimeLogger(this.target, {
      ...snapshotFields(this.bindings),
      ...snapshotFields(bindings)
    });
  }

  private write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: RuntimeLogFields
  ): void {
    try {
      this.target[level](
        message,
        snapshotFields({ ...this.bindings, ...(fields ?? {}) })
      );
    } catch {
      // Runtime logging must never change the business operation.
    }
  }
}

export function createBestEffortRuntimeLogger(
  logger: RuntimeLogger
): RuntimeLogger {
  return logger instanceof BestEffortRuntimeLogger
    ? logger
    : new BestEffortRuntimeLogger(logger);
}

function snapshotFields(fields: RuntimeLogFields): RuntimeLogFields {
  try {
    const snapshot = snapshotValue(fields, new WeakMap<object, unknown>());
    return isRecord(snapshot) ? snapshot : {};
  } catch {
    return {};
  }
}

function snapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown>
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const prior = seen.get(value);
  if (prior !== undefined) {
    return prior;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Error) {
    const snapshot = new Error(value.message);
    seen.set(value, snapshot);
    snapshot.name = value.name;
    snapshot.stack = value.stack;
    for (const [key, nested] of Object.entries(value)) {
      (snapshot as unknown as Record<string, unknown>)[key] = snapshotValue(
        nested,
        seen
      );
    }
    return snapshot;
  }

  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    seen.set(value, snapshot);
    for (const item of value) {
      snapshot.push(snapshotValue(item, seen));
    }
    return snapshot;
  }

  const snapshot: Record<string, unknown> = {};
  seen.set(value, snapshot);
  for (const [key, nested] of Object.entries(value)) {
    snapshot[key] = snapshotValue(nested, seen);
  }
  return snapshot;
}

function isRecord(value: unknown): value is RuntimeLogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
