export type Phase4ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ProcessSignalSource {
  once(signal: Phase4ShutdownSignal, listener: () => void): void;
  off(signal: Phase4ShutdownSignal, listener: () => void): void;
}

export interface StartableRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export type StartRuntimeWithSignalShutdownOptions = {
  runtime: StartableRuntime;
  signals?: ProcessSignalSource;
  onSignal?: (signal: Phase4ShutdownSignal) => void;
  onShutdownError?: (error: Error) => void;
};

export async function startRuntimeWithSignalShutdown(
  options: StartRuntimeWithSignalShutdownOptions
): Promise<"started" | "stopped"> {
  const signals = options.signals ?? process;
  let shutdownOperation: Promise<void> | undefined;

  const removeSignalListeners = () => {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  };
  const beginShutdown = (signal: Phase4ShutdownSignal): void => {
    if (shutdownOperation !== undefined) {
      return;
    }
    removeSignalListeners();
    notifySignal(options.onSignal, signal);
    shutdownOperation = Promise.resolve()
      .then(() => options.runtime.close())
      .catch((error) => notifyShutdownError(options.onShutdownError, error));
  };
  const onSigint = () => beginShutdown("SIGINT");
  const onSigterm = () => beginShutdown("SIGTERM");

  signals.once("SIGINT", onSigint);
  signals.once("SIGTERM", onSigterm);

  try {
    await options.runtime.start();
  } catch (error) {
    removeSignalListeners();
    if (shutdownOperation !== undefined) {
      await shutdownOperation;
      return "stopped";
    }
    await options.runtime
      .close()
      .catch((closeError) =>
        notifyShutdownError(options.onShutdownError, closeError)
      );
    throw error;
  }

  if (shutdownOperation !== undefined) {
    await shutdownOperation;
    return "stopped";
  }
  return "started";
}

function notifySignal(
  listener: StartRuntimeWithSignalShutdownOptions["onSignal"],
  signal: Phase4ShutdownSignal
): void {
  try {
    listener?.(signal);
  } catch {
    // Process lifecycle observers must not prevent shutdown.
  }
}

function notifyShutdownError(
  listener: StartRuntimeWithSignalShutdownOptions["onShutdownError"],
  error: unknown
): void {
  try {
    listener?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Process lifecycle observers must not create another rejection.
  }
}
