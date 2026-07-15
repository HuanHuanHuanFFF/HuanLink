// Pino 适配层负责把 core 的最小日志接口映射到结构化 stdout 日志。
import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";

import {resolveRuntimeConfig} from "../runtime/runtime-config.js";
import type {
  PinoRuntimeLoggerInput,
  PinoRuntimeLoggerOptions,
  RuntimeLogFields,
  RuntimeLogger
} from "./types.js";

const REDACTED_VALUE = "[Redacted]";
const INFO_STRING_MAX_LENGTH = 512;

const SECRET_KEY_NAMES = new Set([
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "clientsecret"
]);

const DEFAULT_REDACT_PATHS = [
  "authorization",
  "headers.authorization",
  "apiKey",
  "token",
  "password",
  "*.authorization",
  "*.apiKey",
  "*.token",
  "*.password"
] as const;

class PinoRuntimeLogger implements RuntimeLogger {
  constructor(
    private readonly logger: PinoLogger,
    private readonly bindings: RuntimeLogFields,
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

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new PinoRuntimeLogger(
      this.logger,
      {...this.bindings, ...bindings},
      this.redactValues
    );
  }

  private write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: RuntimeLogFields
  ): void {
    if (!this.logger.isLevelEnabled(level)) {
      return;
    }

    try {
      const truncate = level !== "debug";
      const sanitizedMessage = sanitizeString(
        message,
        this.redactValues,
        truncate
      );
      const combinedFields =
        fields === undefined
          ? this.bindings
          : {...this.bindings, ...fields};
      const sanitizedFields = sanitizeFields(
        combinedFields,
        this.redactValues,
        truncate
      );

      writeLog(this.logger, level, sanitizedMessage, sanitizedFields);
    } catch (error) {
      reportRuntimeLogError(error, this.redactValues);
    }
  }
}

// createPinoRuntimeLogger 创建默认输出到 stdout 的 Pino runtime logger。
export function createPinoRuntimeLogger(
  options: PinoRuntimeLoggerInput = {},
  destination?: NodeJS.WritableStream
): RuntimeLogger {
  const pinoOptions = toPinoOptions(options);
  const bindings = options.base ?? {};

  const logger =
    destination === undefined ? pino(pinoOptions) : pino(pinoOptions, destination);

  return new PinoRuntimeLogger(
    logger,
    bindings,
    normalizeRedactValues(options.redactValues)
  );
}

// 把 core 的公开配置收敛成 Pino 实际使用的配置对象。
function toPinoOptions(options: PinoRuntimeLoggerInput): LoggerOptions {
  const pinoOptions: LoggerOptions = {};
  const loggingConfig = resolveRuntimeConfig(options.runtimeConfig).logging;

  pinoOptions.level = options.level ?? loggingConfig.level;

  if (options.base !== undefined) {
    pinoOptions.base = null;
  }

  pinoOptions.redact = mergeRedactPaths(options.redact);

  return pinoOptions;
}

function sanitizeFields(
  fields: RuntimeLogFields,
  redactValues: readonly string[],
  truncate: boolean
): RuntimeLogFields {
  return sanitizeValue(
    fields,
    redactValues,
    truncate,
    new WeakSet()
  ) as RuntimeLogFields;
}

function sanitizeValue(
  value: unknown,
  redactValues: readonly string[],
  truncate: boolean,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, redactValues, truncate);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    seen.add(value);
    const result: Record<string, unknown> = {
      type: sanitizeString(value.name, redactValues, truncate),
      message: sanitizeString(value.message, redactValues, truncate),
      stack:
        value.stack === undefined
          ? undefined
          : sanitizeString(value.stack, redactValues, truncate)
    };

    for (const [key, nestedValue] of Object.entries(value)) {
      const sanitizedKey = sanitizeString(key, redactValues, truncate);
      result[sanitizedKey] = isSecretKey(key)
        ? REDACTED_VALUE
        : sanitizeValue(nestedValue, redactValues, truncate, seen);
    }
    seen.delete(value);
    return result;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) =>
      sanitizeValue(item, redactValues, truncate, seen)
    );
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const sanitizedKey = sanitizeString(key, redactValues, truncate);
    result[sanitizedKey] = isSecretKey(key)
      ? REDACTED_VALUE
      : sanitizeValue(nestedValue, redactValues, truncate, seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeString(
  value: string,
  redactValues: readonly string[],
  truncate: boolean
): string {
  let sanitized = value;
  for (const redactValue of redactValues) {
    sanitized = sanitized.split(redactValue).join(REDACTED_VALUE);
  }

  if (!truncate || sanitized.length <= INFO_STRING_MAX_LENGTH) {
    return sanitized;
  }

  const omittedCharacters = sanitized.length - INFO_STRING_MAX_LENGTH;
  return `${sanitized.slice(0, INFO_STRING_MAX_LENGTH)}…[truncated ${omittedCharacters} chars]`;
}

function normalizeRedactValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  );
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
}

function reportRuntimeLogError(
  error: unknown,
  redactValues: readonly string[]
): void {
  const detail = sanitizeString(formatError(error), redactValues, false);

  try {
    process.stderr.write(`HuanLink runtime log error: ${detail}\n`);
  } catch {
    // Logging must never fail the business operation.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 在默认敏感字段之外，追加调用方声明的脱敏路径。
function mergeRedactPaths(customPaths: readonly string[] | undefined): string[] {
  return [...new Set([...DEFAULT_REDACT_PATHS, ...(customPaths ?? [])])];
}

// 统一把 message 和结构化字段映射到对应的 Pino level 方法。
function writeLog(
  logger: PinoLogger,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: RuntimeLogFields
): void {
  if (fields === undefined) {
    logger[level](message);
  } else {
    logger[level](fields, message);
  }
}
