import { describe, expect, test, vi } from "vitest";

import type { ConversationSessionStore } from "@huanlink/core";

import {
  assembleHuanLinkServerRuntime,
  createHuanLinkServerRuntime,
  HuanLinkServerRuntimeLifecycleError,
  HuanLinkServerRuntimeStateError,
} from "../src/index.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFakes(
  input: {
    readonly preflights?: readonly (() => Promise<void> | void)[];
    readonly channelStart?: () => Promise<void> | void;
    readonly channelClose?: () => Promise<void> | void;
    readonly phase3Close?: () => Promise<void> | void;
    readonly storeClose?: () => Promise<void> | void;
  } = {},
) {
  const events: string[] = [];
  const channels = {
    start: vi.fn(async () => {
      events.push("channel:start");
      await input.channelStart?.();
    }),
    close: vi.fn(async () => {
      events.push("channel:close");
      await input.channelClose?.();
    }),
  };
  const phase3 = {
    runMainAgent: vi.fn(),
    close: vi.fn(async () => {
      events.push("phase3:close");
      await input.phase3Close?.();
    }),
  };
  const storeOwner = {
    close: vi.fn(async () => {
      events.push("store:close");
      await input.storeClose?.();
    }),
  };
  const sessionStore: ConversationSessionStore = {
    appendChannelMessage: () => "appended",
    recordOutboundDelivery: () => undefined,
    appendAgentToolCall: () => undefined,
    appendAgentToolResult: () => undefined,
    getSession: () => undefined,
    getSessionMetadata: () => undefined,
  };
  const runtime = createHuanLinkServerRuntime({
    channels,
    sessionStore,
    phase3,
    storeOwner,
    preflights: input.preflights,
  });

  return { runtime, channels, phase3, storeOwner, events };
}

describe("HuanLinkServerRuntime", () => {
  test("closes acquired construction resources in reverse order when a later factory fails", async () => {
    const events: string[] = [];
    const constructionError = new Error("Channel construction failed");
    const phase3CloseError = new Error("Phase3 construction cleanup failed");
    const sessionStore: ConversationSessionStore = {
      appendChannelMessage: () => "appended",
      recordOutboundDelivery: () => undefined,
      appendAgentToolCall: () => undefined,
      appendAgentToolResult: () => undefined,
      getSession: () => undefined,
      getSessionMetadata: () => undefined,
    };
    const storeOwner = {
      close: vi.fn(() => {
        events.push("store:close");
      }),
    };
    const phase3 = {
      close: vi.fn(() => {
        events.push("phase3:close");
        throw phase3CloseError;
      }),
    };

    const operation = assembleHuanLinkServerRuntime({
      createStore: () => {
        events.push("store:create");
        return { sessionStore, storeOwner };
      },
      createPhase3: ({ sessionStore: receivedStore }) => {
        expect(receivedStore).toBe(sessionStore);
        events.push("phase3:create");
        return phase3;
      },
      createChannels: ({
        sessionStore: receivedStore,
        phase3: receivedPhase3,
      }) => {
        expect(receivedStore).toBe(sessionStore);
        expect(receivedPhase3).toBe(phase3);
        events.push("channel:create");
        throw constructionError;
      },
    });

    await expect(operation).rejects.toMatchObject({
      name: "HuanLinkServerRuntimeLifecycleError",
      operation: "construct",
      primaryError: constructionError,
      cleanupErrors: [phase3CloseError],
      errors: [constructionError, phase3CloseError],
    } satisfies Partial<HuanLinkServerRuntimeLifecycleError>);
    expect(events).toEqual([
      "store:create",
      "phase3:create",
      "channel:create",
      "phase3:close",
      "store:close",
    ]);
    expect(phase3.close).toHaveBeenCalledOnce();
    expect(storeOwner.close).toHaveBeenCalledOnce();
  });

  test("runs every preflight before starting Channels and never runs MainAgent", async () => {
    const events: string[] = [];
    const fakes = createFakes({
      preflights: [
        () => {
          events.push("preflight:configuration");
        },
        async () => {
          events.push("preflight:dependencies");
        },
      ],
    });

    await fakes.runtime.start();

    expect(events).toEqual([
      "preflight:configuration",
      "preflight:dependencies",
    ]);
    expect(fakes.events).toEqual(["channel:start"]);
    expect(fakes.phase3.runMainAgent).not.toHaveBeenCalled();
    expect(fakes.runtime.state).toBe("running");
  });

  test("cleans Channel, Phase3, and the independent Store owner after a preflight failure", async () => {
    const primaryError = new Error("invalid orchestration configuration");
    const channelCloseError = new Error("channel cleanup failed");
    const phase3CloseError = new Error("phase3 cleanup failed");
    const storeCloseError = new Error("store cleanup failed");
    const fakes = createFakes({
      preflights: [() => Promise.reject(primaryError)],
      channelClose: () => Promise.reject(channelCloseError),
      phase3Close: () => Promise.reject(phase3CloseError),
      storeClose: () => Promise.reject(storeCloseError),
    });

    const operation = fakes.runtime.start();

    await expect(operation).rejects.toMatchObject({
      name: "HuanLinkServerRuntimeLifecycleError",
      operation: "start",
      primaryError,
      cleanupErrors: [channelCloseError, phase3CloseError, storeCloseError],
      errors: [
        primaryError,
        channelCloseError,
        phase3CloseError,
        storeCloseError,
      ],
    } satisfies Partial<HuanLinkServerRuntimeLifecycleError>);
    expect(fakes.channels.start).not.toHaveBeenCalled();
    expect(fakes.events).toEqual([
      "channel:close",
      "phase3:close",
      "store:close",
    ]);
    expect(fakes.runtime.state).toBe("failed");
  });

  test("cleans every dependency in reverse order after Channel startup fails", async () => {
    const startError = new Error("channel handshake failed");
    const fakes = createFakes({
      channelStart: () => Promise.reject(startError),
    });

    await expect(fakes.runtime.start()).rejects.toBe(startError);

    expect(fakes.events).toEqual([
      "channel:start",
      "channel:close",
      "phase3:close",
      "store:close",
    ]);
    expect(fakes.runtime.state).toBe("failed");
  });

  test("shares one concurrent close operation and closes resources once in reverse order", async () => {
    const channelCloseEntered = deferred();
    const allowChannelClose = deferred();
    const fakes = createFakes({
      channelClose: async () => {
        channelCloseEntered.resolve();
        await allowChannelClose.promise;
      },
    });
    await fakes.runtime.start();

    const firstClose = fakes.runtime.close();
    await channelCloseEntered.promise;
    const secondClose = fakes.runtime.close();

    expect(secondClose).toBe(firstClose);
    expect(fakes.runtime.state).toBe("closing");
    allowChannelClose.resolve();
    await firstClose;
    await expect(fakes.runtime.close()).resolves.toBeUndefined();

    expect(fakes.events).toEqual([
      "channel:start",
      "channel:close",
      "phase3:close",
      "store:close",
    ]);
    expect(fakes.channels.close).toHaveBeenCalledOnce();
    expect(fakes.phase3.close).toHaveBeenCalledOnce();
    expect(fakes.storeOwner.close).toHaveBeenCalledOnce();
    expect(fakes.runtime.state).toBe("closed");
  });

  test("rejects a duplicate start and lets close cancel startup before Channels start", async () => {
    const preflightEntered = deferred();
    const allowPreflight = deferred();
    const fakes = createFakes({
      preflights: [
        async () => {
          preflightEntered.resolve();
          await allowPreflight.promise;
        },
      ],
    });

    const starting = fakes.runtime.start();
    await preflightEntered.promise;

    await expect(fakes.runtime.start()).rejects.toMatchObject({
      name: "HuanLinkServerRuntimeStateError",
      operation: "start",
      state: "starting",
    } satisfies Partial<HuanLinkServerRuntimeStateError>);
    const closing = fakes.runtime.close();
    expect(fakes.runtime.state).toBe("closing");
    allowPreflight.resolve();
    await expect(starting).rejects.toMatchObject({
      name: "HuanLinkServerRuntimeStateError",
      operation: "start",
      state: "closing",
    } satisfies Partial<HuanLinkServerRuntimeStateError>);
    await expect(closing).resolves.toBeUndefined();

    expect(fakes.channels.start).not.toHaveBeenCalled();
    expect(fakes.events).toEqual([
      "channel:close",
      "phase3:close",
      "store:close",
    ]);
    expect(fakes.runtime.state).toBe("closed");
    await expect(fakes.runtime.start()).rejects.toMatchObject({
      name: "HuanLinkServerRuntimeStateError",
      operation: "start",
      state: "closed",
      allowedStates: ["ready"],
    } satisfies Partial<HuanLinkServerRuntimeStateError>);
  });
});
