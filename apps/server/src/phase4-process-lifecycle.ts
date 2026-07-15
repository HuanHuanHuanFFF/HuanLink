import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogger
} from "@huanlink/core";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

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
  logger?: RuntimeLogger;
  closeLogger?: () => Promise<void> | void;
};

export async function startRuntimeWithSignalShutdown(
  options: StartRuntimeWithSignalShutdownOptions
): Promise<"started" | "stopped"> {
  const signals = options.signals ?? process;
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger()
  );
  let shutdownOperation: Promise<void> | undefined;

  const removeSignalListeners = () => {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  };
  const performShutdown = async (
    fields: RuntimeLogFields
  ): Promise<void> => {
    logger.info("process.stopping", fields);
    let stopped = false;
    try {
      await options.runtime.close();
      stopped = true;
    } catch (error) {
      logger.error("process.stop_failed", { ...fields, error });
      notifyShutdownError(options.onShutdownError, error);
    } finally {
      if (stopped) {
        logger.info("process.stopped", fields);
      }
      try {
        await options.closeLogger?.();
      } catch (error) {
        logger.error("process.stop_failed", {
          ...fields,
          stage: "logger_close",
          error
        });
        notifyShutdownError(options.onShutdownError, error);
      }
    }
  };
  const beginShutdown = (signal: Phase4ShutdownSignal): void => {
    if (shutdownOperation !== undefined) {
      return;
    }
    removeSignalListeners();
    logger.info("process.signal", { signal });
    notifySignal(options.onSignal, signal);
    shutdownOperation = performShutdown({ signal });
  };
  const onSigint = () => beginShutdown("SIGINT");
  const onSigterm = () => beginShutdown("SIGTERM");

  signals.once("SIGINT", onSigint);
  signals.once("SIGTERM", onSigterm);

  logger.info("process.starting");
  try {
    await options.runtime.start();
  } catch (error) {
    removeSignalListeners();
    if (shutdownOperation !== undefined) {
      await shutdownOperation;
      return "stopped";
    }
    logger.error("process.start_failed", { error });
    shutdownOperation = performShutdown({ reason: "start_failed" });
    await shutdownOperation;
    throw error;
  }

  if (shutdownOperation !== undefined) {
    await shutdownOperation;
    return "stopped";
  }
  logger.info("process.started");
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
