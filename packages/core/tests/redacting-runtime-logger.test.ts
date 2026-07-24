import { describe, expect, test } from "vitest";

import {
  createRedactingRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogger,
} from "../src/index.js";

type RecordedLog = {
  readonly message: string;
  readonly fields: RuntimeLogFields;
};

class RecordingRuntimeLogger implements RuntimeLogger {
  readonly entries: RecordedLog[];

  constructor(
    entries: RecordedLog[] = [],
    private readonly bindings: RuntimeLogFields = {},
  ) {
    this.entries = entries;
  }

  debug(message: string, fields: RuntimeLogFields = {}): void {
    this.record(message, fields);
  }

  info(message: string, fields: RuntimeLogFields = {}): void {
    this.record(message, fields);
  }

  warn(message: string, fields: RuntimeLogFields = {}): void {
    this.record(message, fields);
  }

  error(message: string, fields: RuntimeLogFields = {}): void {
    this.record(message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new RecordingRuntimeLogger(this.entries, {
      ...this.bindings,
      ...bindings,
    });
  }

  private record(message: string, fields: RuntimeLogFields): void {
    this.entries.push({
      message,
      fields: { ...this.bindings, ...fields },
    });
  }
}

class ThrowingRuntimeLogger implements RuntimeLogger {
  debug(): void {
    throw new Error("debug logger failed");
  }

  info(): void {
    throw new Error("info logger failed");
  }

  warn(): void {
    throw new Error("warn logger failed");
  }

  error(): void {
    throw new Error("error logger failed");
  }

  child(): RuntimeLogger {
    throw new Error("child logger failed");
  }
}

describe("createRedactingRuntimeLogger", () => {
  test("redacts declared values before delegating to any RuntimeLogger", () => {
    const target = new RecordingRuntimeLogger();
    const logger = createRedactingRuntimeLogger(target, {
      redactValues: ["access-token-secret"],
    });
    const error = new Error("failed with access-token-secret");

    logger.info("using access-token-secret", {
      nested: {
        value: "Bearer access-token-secret",
      },
      error,
    });

    expect(target.entries).toHaveLength(1);
    expect(target.entries[0]!.message).toBe("using [redacted]");
    expect(target.entries[0]!.fields).toMatchObject({
      nested: {
        value: "Bearer [redacted]",
      },
    });
    expect(target.entries[0]!.fields.error).toBeInstanceOf(Error);
    expect((target.entries[0]!.fields.error as Error).message).toBe(
      "failed with [redacted]",
    );
    expect(error.message).toBe("failed with access-token-secret");
  });

  test("does not let target write or child failures affect business code", () => {
    const logger = createRedactingRuntimeLogger(new ThrowingRuntimeLogger());

    expect(() => logger.info("business continues")).not.toThrow();
    expect(() => logger.child({ module: "channel" })).not.toThrow();
  });
});
