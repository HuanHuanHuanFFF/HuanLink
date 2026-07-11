const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseHost(value: string): string {
  if (value.trim().length === 0 || !LOOPBACK_HOSTS.has(value)) {
    throw invalidHost(value);
  }

  return value;
}

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw invalidPort(value);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
    throw invalidPort(value);
  }
  return parsed;
}

function invalidPort(value: string): Error {
  return new Error(`Invalid HUANLINK_CODEX_A2A_PORT: ${value}`);
}

function invalidHost(value: string): Error {
  return new Error(`Invalid HUANLINK_CODEX_A2A_HOST: ${value}`);
}
