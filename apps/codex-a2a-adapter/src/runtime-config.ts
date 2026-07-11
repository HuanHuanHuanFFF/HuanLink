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
