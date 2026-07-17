import {
  TaskNotCancelableError,
  UnsupportedOperationError
} from "@a2a-js/sdk/client";
import { type RuntimeLogFields } from "@huanlink/core";

export class A2aProtocolError extends Error {}

type ErrorCategory = "abort" | "network" | "protocol" | "unknown";

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const ABORT_ERROR_CODES = new Set(["ABORT_ERR", "ERR_CANCELED"]);
const RETRYABLE_FETCH_TYPE_ERROR_MESSAGES = new Set([
  "fetch failed",
  "terminated"
]);

export function errorLogFields(
  error: unknown,
  categoryOverride?: ErrorCategory
): RuntimeLogFields {
  const errorCode = safeErrorCode(error);
  return {
    errorType: safeErrorType(error),
    errorMessageLength: safeOwnStringLength(error, "message"),
    errorCategory:
      categoryOverride ?? classifyErrorCategory(error, errorCode),
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

function classifyErrorCategory(
  error: unknown,
  errorCode: string | undefined
): ErrorCategory {
  if (errorCode !== undefined && ABORT_ERROR_CODES.has(errorCode)) {
    return "abort";
  }
  if (errorCode !== undefined && NETWORK_ERROR_CODES.has(errorCode)) {
    return "network";
  }
  try {
    return error instanceof A2aProtocolError ? "protocol" : "unknown";
  } catch {
    return "unknown";
  }
}

function safeErrorType(error: unknown): "Error" | "ThrownValue" {
  try {
    return error instanceof Error ? "Error" : "ThrownValue";
  } catch {
    return "ThrownValue";
  }
}

function safeErrorCode(error: unknown): string | undefined {
  const code = safeOwnDataValue(error, "code");
  return typeof code === "string" &&
    (NETWORK_ERROR_CODES.has(code) || ABORT_ERROR_CODES.has(code))
    ? code
    : undefined;
}

function safeOwnStringLength(value: unknown, key: string): number {
  const candidate = safeOwnDataValue(value, key);
  return typeof candidate === "string" ? candidate.length : 0;
}

function safeOwnDataValue(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function isUnsupportedOperation(error: unknown): boolean {
  return hasCause(
    error,
    (candidate) => candidate instanceof UnsupportedOperationError
  );
}

export function isTaskNotCancelable(error: unknown): boolean {
  return hasCause(
    error,
    (candidate) => candidate instanceof TaskNotCancelableError
  );
}

export function isRetryableObservationError(error: unknown): boolean {
  return hasCause(error, (candidate) => {
    const code = safeOwnDataValue(candidate, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    const message = safeOwnDataValue(candidate, "message");
    return (
      candidate instanceof TypeError &&
      typeof message === "string" &&
      RETRYABLE_FETCH_TYPE_ERROR_MESSAGES.has(message)
    );
  });
}

function hasCause(
  error: unknown,
  predicate: (candidate: unknown) => boolean
): boolean {
  let candidate = error;
  const seen = new Set<unknown>();
  while (candidate !== undefined && candidate !== null && !seen.has(candidate)) {
    if (predicate(candidate)) {
      return true;
    }
    seen.add(candidate);
    candidate =
      typeof candidate === "object" && "cause" in candidate
        ? candidate.cause
        : undefined;
  }
  return false;
}
