export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const available = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (available.length === 0) {
    return undefined;
  }
  if (available.length === 1) {
    return available[0];
  }
  return AbortSignal.any(available);
}
