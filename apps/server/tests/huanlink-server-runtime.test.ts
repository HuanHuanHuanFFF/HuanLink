import { describe, expect, test, vi } from "vitest";

import {
  type ChannelAdapterV1,
  type ChannelMessageListenerV1,
  type DeliveryReceiptV1,
  InMemoryConversationSessionStore,
  type ConversationSessionStore,
  type InboundChannelMessageV1,
  type RetractChannelMessageCommandV1,
  type SendChannelMessageCommandV1,
} from "@huanlink/core";

import {
  assembleHuanLinkServerRuntime,
  type ChannelRuntimeMessage,
  createChannelRuntime,
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

class RuntimeIngressAdapter implements ChannelAdapterV1 {
  readonly descriptor = {
    channelId: "qq-main",
    platform: "test",
    capabilities: {
      conversationKinds: ["group"] as const,
      threads: false,
      inboundContentFormats: ["onebot11.cq"] as const,
      outboundPartTypes: ["text"] as const,
      reply: true,
      edit: false,
      retract: true,
      reaction: false,
      typing: false,
      streaming: false,
    },
  };
  private readonly listeners = new Set<ChannelMessageListenerV1>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(listener: ChannelMessageListenerV1): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(_command: SendChannelMessageCommandV1): Promise<DeliveryReceiptV1> {
    return Promise.resolve({ channelId: "qq-main", messageId: "unused" });
  }

  retract(_command: RetractChannelMessageCommandV1): Promise<void> {
    return Promise.resolve();
  }

  emit(message: InboundChannelMessageV1): void {
    for (const listener of this.listeners) {
      void listener(message);
    }
  }
}

function ingressMention(
  messageId: string,
  conversationId: string,
): InboundChannelMessageV1 {
  return {
    messageId,
    route: {
      channelId: "qq-main",
      conversationKind: "group",
      conversationId,
    },
    sender: { id: "20002", username: "Alice", isSelf: false },
    receivedAt: "2026-08-10T00:00:00.000Z",
    content: messageId,
    contentFormat: "onebot11.cq",
    trigger: { kind: "mention" },
  };
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
  test("wires Channel ingress through the Coordinator before invoking Phase3", async () => {
    const sessionStore = new InMemoryConversationSessionStore();
    const storeOwner = { close: vi.fn() };
    const phase3 = {
      runMainAgent: vi.fn(async () => ({ output: "accepted" })),
      close: vi.fn(),
    };
    const channels = {
      start: vi.fn(),
      close: vi.fn(),
    };
    let onChannelMessage!: (
      input: ChannelRuntimeMessage,
    ) => Promise<void> | void;
    const runtime = await assembleHuanLinkServerRuntime({
      createStore: () => ({ sessionStore, storeOwner }),
      createPhase3: () => phase3,
      createChannels: ({ onChannelMessage: handler }) => {
        onChannelMessage = handler;
        return channels;
      },
    });
    const message: InboundChannelMessageV1 = {
      messageId: "mention-through-coordinator",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      sender: {
        id: "20002",
        username: "Alice",
        isSelf: false,
      },
      receivedAt: "2026-08-10T00:00:00.000Z",
      content: "@HuanLink inspect this",
      contentFormat: "onebot11.cq",
      trigger: { kind: "mention" },
    };
    const signal = new AbortController().signal;

    await runtime.start();
    await onChannelMessage({
      sessionId: "channel:qq-main:group:10001",
      message,
      signal,
    });

    expect(
      sessionStore.getSession("channel:qq-main:group:10001")?.timeline,
    ).toHaveLength(1);
    expect(phase3.runMainAgent).toHaveBeenCalledWith({
      runId: expect.any(String),
      sessionId: "channel:qq-main:group:10001",
      input: "@HuanLink inspect this",
      signal,
    });

    await runtime.close();
  });

  test("preserves Channel ordering and aborts queued ingress through the assembled Coordinator", async () => {
    const sessionStore = new InMemoryConversationSessionStore();
    const adapter = new RuntimeIngressAdapter();
    let activeSignal: AbortSignal | undefined;
    const runMainAgent = vi.fn(
      async (input: {
        readonly input: string;
        readonly signal: AbortSignal;
      }) => {
        if (input.input !== "first") {
          return { output: "other route completed" };
        }
        activeSignal = input.signal;
        await new Promise<void>((_resolve, reject) => {
          if (input.signal.aborted) {
            reject(input.signal.reason);
            return;
          }
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        });
        return { output: "unreachable" };
      },
    );
    const runtime = await assembleHuanLinkServerRuntime({
      createStore: () => ({
        sessionStore,
        storeOwner: { close: vi.fn() },
      }),
      createPhase3: () => ({ runMainAgent, close: vi.fn() }),
      createChannels: ({ onChannelMessage }) =>
        createChannelRuntime({
          channels: [
            {
              adapter,
              inboundPolicy: {
                groups: { mode: "denylist", ids: [] },
                directs: { mode: "denylist", ids: [] },
              },
            },
          ],
          onMessage: onChannelMessage,
        }),
    });
    await runtime.start();

    adapter.emit(ingressMention("first", "10001"));
    await vi.waitFor(() => expect(runMainAgent).toHaveBeenCalledOnce());
    adapter.emit(ingressMention("queued-same-route", "10001"));
    adapter.emit(ingressMention("other-route", "20002"));

    await vi.waitFor(() => expect(runMainAgent).toHaveBeenCalledTimes(2));
    expect(runMainAgent.mock.calls.map(([input]) => input.input)).toEqual([
      "first",
      "other-route",
    ]);

    await runtime.close();

    expect(activeSignal?.aborted).toBe(true);
    expect(runMainAgent).toHaveBeenCalledTimes(2);
    expect(
      sessionStore.getSession("channel:qq-main:group:10001")?.timeline,
    ).toHaveLength(1);
    expect(
      sessionStore.getSession("channel:qq-main:group:20002")?.timeline,
    ).toHaveLength(1);
  });

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
      runMainAgent: vi.fn(async () => ({ output: "unused" })),
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
      createChannels: ({ onChannelMessage }) => {
        expect(onChannelMessage).toEqual(expect.any(Function));
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
