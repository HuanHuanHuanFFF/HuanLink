import type {
  RuntimeLogFields,
  RuntimeLogLevel,
  RuntimeLogger,
} from "./types.js";

const REDACTED_VALUE = "[redacted]";

export type RedactingRuntimeLoggerOptions = {
  readonly redactValues?: readonly string[];
};

class RedactingRuntimeLogger implements RuntimeLogger {
  constructor(
    private readonly target: RuntimeLogger,
    private readonly redactValues: readonly string[],
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
    try {
      return new RedactingRuntimeLogger(
        this.target.child(sanitizeLogFields(bindings, this.redactValues)),
        this.redactValues,
      );
    } catch {
      // Logging observers must never affect the business operation.
      return this;
    }
  }

  private write(
    level: RuntimeLogLevel,
    message: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      this.target[level](
        redactRuntimeLogString(message, this.redactValues),
        fields === undefined
          ? undefined
          : sanitizeLogFields(fields, this.redactValues),
      );
    } catch {
      // Logging observers must never affect the business operation.
    }
  }
}

export function createRedactingRuntimeLogger(
  target: RuntimeLogger,
  options: RedactingRuntimeLoggerOptions = {},
): RuntimeLogger {
  return new RedactingRuntimeLogger(
    target,
    normalizeRedactValues(options.redactValues),
  );
}

export function redactRuntimeLogString(
  value: string,
  redactValues: readonly string[],
): string {
  let sanitized = value;
  for (const redactValue of normalizeRedactValues(redactValues)) {
    sanitized = sanitized.split(redactValue).join(REDACTED_VALUE);
  }
  return sanitized;
}

function sanitizeLogFields(
  fields: RuntimeLogFields,
  redactValues: readonly string[],
): RuntimeLogFields {
  return sanitizeLogValue(
    fields,
    redactValues,
    new WeakMap<object, unknown>(),
  ) as RuntimeLogFields;
}

function sanitizeLogValue(
  value: unknown,
  redactValues: readonly string[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return redactRuntimeLogString(value, redactValues);
  }
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
    const sanitized = new Error(
      redactRuntimeLogString(value.message, redactValues),
    );
    seen.set(value, sanitized);
    sanitized.name = redactRuntimeLogString(value.name, redactValues);
    sanitized.stack =
      value.stack === undefined
        ? undefined
        : redactRuntimeLogString(value.stack, redactValues);
    if ("cause" in value) {
      (sanitized as Error & { cause?: unknown }).cause = sanitizeLogValue(
        value.cause,
        redactValues,
        seen,
      );
    }
    for (const [key, nested] of Object.entries(value)) {
      (sanitized as unknown as Record<string, unknown>)[
        redactRuntimeLogString(key, redactValues)
      ] = sanitizeLogValue(nested, redactValues, seen);
    }
    return sanitized;
  }
  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const item of value) {
      sanitized.push(sanitizeLogValue(item, redactValues, seen));
    }
    return sanitized;
  }

  const sanitized: Record<string, unknown> = {};
  seen.set(value, sanitized);
  for (const [key, nested] of Object.entries(value)) {
    sanitized[redactRuntimeLogString(key, redactValues)] = sanitizeLogValue(
      nested,
      redactValues,
      seen,
    );
  }
  return sanitized;
}

function normalizeRedactValues(
  values: readonly string[] | undefined,
): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}
