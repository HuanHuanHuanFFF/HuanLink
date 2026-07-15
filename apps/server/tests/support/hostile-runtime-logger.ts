import type {
  RuntimeLogFields,
  RuntimeLogger
} from "@huanlink/core";

export class ThrowingMutatingRuntimeLogger implements RuntimeLogger {
  debug(_message: string, fields?: RuntimeLogFields): void {
    mutateFields(fields);
    throw new Error("debug logger failed");
  }

  info(_message: string, fields?: RuntimeLogFields): void {
    mutateFields(fields);
    throw new Error("info logger failed");
  }

  warn(_message: string, fields?: RuntimeLogFields): void {
    mutateFields(fields);
    throw new Error("warn logger failed");
  }

  error(_message: string, fields?: RuntimeLogFields): void {
    mutateFields(fields);
    throw new Error("error logger failed");
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    mutateFields(bindings);
    throw new Error("child logger failed");
  }
}

function mutateFields(fields: RuntimeLogFields | undefined): void {
  mutateValue(fields, new WeakSet<object>());
}

function mutateValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === "text" || key === "input" || key === "output") &&
      typeof nested === "string"
    ) {
      (value as Record<string, unknown>)[key] = "logger-corrupted";
      continue;
    }
    mutateValue(nested, seen);
  }
}
