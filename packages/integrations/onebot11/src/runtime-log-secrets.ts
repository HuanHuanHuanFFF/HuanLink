import {
  createRedactingRuntimeLogger,
  NoopRuntimeLogger,
  redactRuntimeLogString,
  type RuntimeLogger,
} from "@huanlink/core";

export function createRedactingOneBot11RuntimeLogger(
  logger: RuntimeLogger | undefined,
  rawUrl: string,
  accessToken: string | undefined,
): RuntimeLogger {
  return createRedactingRuntimeLogger(logger ?? new NoopRuntimeLogger(), {
    redactValues: collectOneBot11LogSecrets(rawUrl, accessToken),
  });
}

export function redactOneBot11LogString(
  value: string,
  rawUrl: string,
  accessToken: string | undefined,
): string {
  return redactRuntimeLogString(
    value,
    collectOneBot11LogSecrets(rawUrl, accessToken),
  );
}

function collectOneBot11LogSecrets(
  rawUrl: string,
  accessToken: string | undefined,
): string[] {
  const normalizedToken = nonEmptyString(accessToken);
  const secrets = normalizedToken === undefined ? [] : [normalizedToken];
  try {
    const url = new URL(rawUrl);
    const sensitiveParts = [
      url.username,
      url.password,
      url.search,
      ...url.searchParams.values(),
    ].filter((value) => value.length > 0);
    if (sensitiveParts.length > 0) {
      secrets.push(rawUrl);
    }
    for (const part of sensitiveParts) {
      secrets.push(part);
      try {
        const decoded = decodeURIComponent(part);
        if (decoded.length > 0) {
          secrets.push(decoded);
        }
      } catch {
        // The encoded URL component was already covered above.
      }
    }
  } catch {
    // URL validity is enforced by the WebSocket constructor.
  }
  return [...new Set(secrets)].sort((left, right) => right.length - left.length);
}

function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  return normalized.length === 0 ? undefined : normalized;
}
