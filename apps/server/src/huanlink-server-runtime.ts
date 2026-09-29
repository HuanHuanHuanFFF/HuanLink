import {
  ConversationSessionStoreToolHistoryRecorder,
  projectConversationSessionContext,
  type AsyncToolTaskService,
  type ConversationSessionStore,
  type SessionId,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";

import type { ChannelRuntimeMessage } from "./channel-runtime.js";
import {
  createSessionIngressCoordinator,
  type SessionIngressMainAgentRunner,
} from "./session-ingress-coordinator.js";

/** Channel-only Runtime contract required by the Server composition root. */
export interface HuanLinkServerChannelRuntime {
  start(): Promise<void> | void;
  close(): Promise<void> | void;
}

/** Phase 3 fresh-turn and lifecycle contract required by the composition root. */
export interface HuanLinkServerPhase3Runtime extends SessionIngressMainAgentRunner {
  close(): Promise<void> | void;
}

/** Owns the Store resource lifetime without extending the business Store contract. */
export interface HuanLinkServerStoreCloseOwner {
  close(): Promise<void> | void;
}

type Awaitable<T> = T | Promise<T>;

export type HuanLinkServerRuntimePreflight = () => Promise<void> | void;

export type HuanLinkServerRuntimeState =
  | "ready"
  | "starting"
  | "running"
  | "closing"
  | "closed"
  | "failed";

export type HuanLinkServerRuntimeOperation = "construct" | "start" | "close";

export type CreateHuanLinkServerRuntimeOptions = {
  readonly channels: HuanLinkServerChannelRuntime;
  readonly sessionStore: ConversationSessionStore;
  readonly phase3: HuanLinkServerPhase3Runtime;
  readonly storeOwner: HuanLinkServerStoreCloseOwner;
  readonly preflights?: readonly HuanLinkServerRuntimePreflight[];
};

export type HuanLinkServerStoreResource = {
  readonly sessionStore: ConversationSessionStore;
  readonly storeOwner: HuanLinkServerStoreCloseOwner;
};

export type AssembleHuanLinkServerRuntimeOptions = {
  readonly taskService: AsyncToolTaskService;
  readonly createStore: () => Awaitable<HuanLinkServerStoreResource>;
  readonly createPhase3: (input: {
    readonly sessionStore: ConversationSessionStore;
    readonly taskService: AsyncToolTaskService;
    readonly getLatestContext: (sessionId: SessionId) => string;
    readonly historyRecorder: SessionToolHistoryRecorder;
  }) => Awaitable<HuanLinkServerPhase3Runtime>;
  readonly createChannels: (input: {
    readonly onChannelMessage: (
      input: ChannelRuntimeMessage,
    ) => Promise<void> | void;
  }) => Awaitable<HuanLinkServerChannelRuntime>;
  readonly preflights?: readonly HuanLinkServerRuntimePreflight[];
};

export interface HuanLinkServerRuntime {
  readonly state: HuanLinkServerRuntimeState;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** A caller requested an operation which is not valid for the current state. */
export class HuanLinkServerRuntimeStateError extends Error {
  readonly name = "HuanLinkServerRuntimeStateError";

  constructor(
    readonly operation: HuanLinkServerRuntimeOperation,
    readonly state: HuanLinkServerRuntimeState,
    readonly allowedStates: readonly HuanLinkServerRuntimeState[],
  ) {
    super(
      `Cannot ${operation} HuanLinkServerRuntime while state is ${state}; ` +
        `allowed states: ${allowedStates.join(", ")}`,
    );
  }
}

/**
 * Exposes a startup failure together with every best-effort cleanup failure.
 * `errors` contains the primary startup error first, followed by cleanup errors.
 */
export class HuanLinkServerRuntimeLifecycleError extends AggregateError {
  readonly name = "HuanLinkServerRuntimeLifecycleError";

  constructor(
    readonly operation: HuanLinkServerRuntimeOperation,
    readonly primaryError: Error | undefined,
    readonly cleanupErrors: readonly Error[],
  ) {
    super(
      primaryError === undefined
        ? cleanupErrors
        : [primaryError, ...cleanupErrors],
      formatLifecycleErrorMessage(operation, primaryError, cleanupErrors),
    );
  }
}

/**
 * Acquires Server Runtime dependencies in ownership order.
 *
 * If a later factory fails, every resource already acquired here is closed in
 * reverse order before the construction error is returned to the caller.
 */
export async function assembleHuanLinkServerRuntime(
  options: AssembleHuanLinkServerRuntimeOptions,
): Promise<HuanLinkServerRuntime> {
  const acquired: HuanLinkServerCloseable[] = [];
  try {
    const { sessionStore, storeOwner } = await options.createStore();
    acquired.push(storeOwner);

    const phase3 = await options.createPhase3({
      sessionStore,
      taskService: options.taskService,
      historyRecorder: new ConversationSessionStoreToolHistoryRecorder(
        sessionStore,
      ),
      getLatestContext: (sessionId) => {
        const window = sessionStore.getSessionContextWindow(sessionId);
        if (window === undefined) {
          throw new Error(`Conversation Session ${sessionId} does not exist`);
        }
        return projectConversationSessionContext(window);
      },
    });
    acquired.push(phase3);

    const sessionIngress = createSessionIngressCoordinator({
      sessionStore,
      runner: phase3,
    });
    const channels = await options.createChannels({
      onChannelMessage: sessionIngress.handle,
    });
    acquired.push(channels);

    return createHuanLinkServerRuntime({
      channels,
      sessionStore,
      phase3,
      storeOwner,
      preflights: options.preflights,
    });
  } catch (error) {
    const primaryError = normalizeError(error);
    const cleanupErrors = await closeBestEffort(acquired.toReversed());
    if (cleanupErrors.length > 0) {
      throw new HuanLinkServerRuntimeLifecycleError(
        "construct",
        primaryError,
        cleanupErrors,
      );
    }
    throw primaryError;
  }
}

/**
 * Server process lifecycle composition root.
 *
 * The Channel Runtime remains responsible only for Channel I/O. Assembly wires
 * its sole ingress handler through SessionIngressCoordinator; this object owns
 * only dependency lifecycle order.
 */
export function createHuanLinkServerRuntime(
  options: CreateHuanLinkServerRuntimeOptions,
): HuanLinkServerRuntime {
  let state: HuanLinkServerRuntimeState = "ready";
  let startOperation: Promise<void> | undefined;
  let closeOperation: Promise<void> | undefined;
  let cleanupOperation: Promise<Error[]> | undefined;

  const performCleanupDependencies = (): Promise<Error[]> =>
    closeBestEffort([options.channels, options.phase3, options.storeOwner]);
  const cleanupDependencies = (): Promise<Error[]> => {
    cleanupOperation ??= performCleanupDependencies();
    return cleanupOperation;
  };

  const assertStartupContinues = (): void => {
    if (state !== "starting") {
      throw new HuanLinkServerRuntimeStateError("start", state, ["starting"]);
    }
  };

  const performStart = async (): Promise<void> => {
    try {
      for (const preflight of options.preflights ?? []) {
        await preflight();
        assertStartupContinues();
      }
      await options.channels.start();
      assertStartupContinues();
      state = "running";
    } catch (error) {
      const closeWasRequested = state === "closing";
      const primaryError = normalizeError(error);
      const cleanupErrors = await cleanupDependencies();
      state = closeWasRequested ? "closed" : "failed";
      if (cleanupErrors.length > 0) {
        throw new HuanLinkServerRuntimeLifecycleError(
          "start",
          primaryError,
          cleanupErrors,
        );
      }
      throw primaryError;
    }
  };

  const start = (): Promise<void> => {
    if (state !== "ready") {
      return Promise.reject(
        new HuanLinkServerRuntimeStateError("start", state, ["ready"]),
      );
    }
    state = "starting";
    startOperation = performStart();
    return startOperation;
  };

  const close = (): Promise<void> => {
    if (closeOperation !== undefined) {
      return closeOperation;
    }
    if (state === "closed" || state === "failed") {
      return Promise.resolve();
    }
    if (state === "starting") {
      state = "closing";
      const activeStart = startOperation!;
      closeOperation = activeStart
        .catch(() => undefined)
        .then(async () => {
          const cleanupErrors = await cleanupDependencies();
          state = "closed";
          if (cleanupErrors.length > 0) {
            throw new HuanLinkServerRuntimeLifecycleError(
              "close",
              undefined,
              cleanupErrors,
            );
          }
        });
      return closeOperation;
    }
    state = "closing";
    closeOperation = cleanupDependencies().then((cleanupErrors) => {
      state = "closed";
      if (cleanupErrors.length > 0) {
        throw new HuanLinkServerRuntimeLifecycleError(
          "close",
          undefined,
          cleanupErrors,
        );
      }
    });
    return closeOperation;
  };

  return {
    get state() {
      return state;
    },
    start,
    close,
  };
}

function formatLifecycleErrorMessage(
  operation: HuanLinkServerRuntimeOperation,
  primaryError: Error | undefined,
  cleanupErrors: readonly Error[],
): string {
  const primary = primaryError === undefined ? "" : `: ${primaryError.message}`;
  return (
    `HuanLinkServerRuntime ${operation} failed${primary}; ` +
    `${cleanupErrors.length} cleanup failure(s)`
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

type HuanLinkServerCloseable = {
  close(): Promise<void> | void;
};

async function closeBestEffort(
  dependencies: readonly HuanLinkServerCloseable[],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const dependency of dependencies) {
    try {
      await dependency.close();
    } catch (error) {
      failures.push(normalizeError(error));
    }
  }
  return failures;
}
