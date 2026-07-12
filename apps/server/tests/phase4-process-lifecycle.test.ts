import { describe, expect, test, vi } from "vitest";

import {
  startRuntimeWithSignalShutdown,
  type ProcessSignalSource
} from "../src/phase4-process-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class ControlledSignals implements ProcessSignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();

  once(signal: NodeJS.Signals, listener: () => void): void {
    const wrapped = () => {
      this.off(signal, listener);
      listener();
    };
    Object.defineProperty(wrapped, "original", { value: listener });
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(signal, listeners);
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.listeners.get(signal);
    if (listeners === undefined) {
      return;
    }
    for (const candidate of listeners) {
      if (
        candidate === listener ||
        (candidate as (() => void) & { original?: () => void }).original ===
          listener
      ) {
        listeners.delete(candidate);
      }
    }
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) {
      listener();
    }
  }
}

describe("Phase 4 process lifecycle", () => {
  test("treats a signal during startup as an orderly stop", async () => {
    const signals = new ControlledSignals();
    const startEntered = deferred();
    const startResult = deferred();
    const close = vi.fn(async () => {
      startResult.reject(new Error("runtime closed while starting"));
    });
    const onSignal = vi.fn();
    const operation = startRuntimeWithSignalShutdown({
      runtime: {
        start: async () => {
          startEntered.resolve();
          await startResult.promise;
        },
        close
      },
      signals,
      onSignal
    });

    await startEntered.promise;
    signals.emit("SIGINT");

    await expect(operation).resolves.toBe("stopped");
    expect(onSignal).toHaveBeenCalledWith("SIGINT");
    expect(close).toHaveBeenCalledOnce();
  });

  test("rethrows a genuine startup failure after cleanup", async () => {
    const signals = new ControlledSignals();
    const close = vi.fn(async () => undefined);

    await expect(
      startRuntimeWithSignalShutdown({
        runtime: {
          start: async () => {
            throw new Error("OneBot handshake failed");
          },
          close
        },
        signals
      })
    ).rejects.toThrow("OneBot handshake failed");
    expect(close).toHaveBeenCalledOnce();
  });

  test("keeps signal shutdown active after a successful start", async () => {
    const signals = new ControlledSignals();
    const close = vi.fn(async () => undefined);
    const onSignal = vi.fn();

    await expect(
      startRuntimeWithSignalShutdown({
        runtime: {
          start: async () => undefined,
          close
        },
        signals,
        onSignal
      })
    ).resolves.toBe("started");

    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onSignal).toHaveBeenCalledWith("SIGTERM");
  });
});
