import { describe, expect, test, vi } from "vitest";

import {
  type ChannelAdapterV1,
  type ChannelConversationKindV1,
  type ChannelDescriptorV1,
  type ChannelMessageListenerV1,
  type DeliveryReceiptV1,
  type InboundChannelMessageV1,
  type RetractChannelMessageCommandV1,
  type SendChannelMessageCommandV1
} from "@huanlink/core";

import {
  createChannelRuntime,
  type ChannelRuntimeMessage
} from "../src/channel-runtime.js";

class FakeChannelAdapter implements ChannelAdapterV1 {
  readonly descriptor: ChannelDescriptorV1;
  private readonly listeners = new Set<ChannelMessageListenerV1>();

  constructor(
    channelId: string,
    conversationKinds: readonly ChannelConversationKindV1[] = [
      "direct",
      "group"
    ]
  ) {
    this.descriptor = {
      channelId,
      platform: "test",
      capabilities: {
        conversationKinds,
        threads: false,
        inboundContentFormats: ["onebot11.cq"],
        outboundPartTypes: ["text"],
        reply: true,
        edit: false,
        retract: true,
        reaction: false,
        typing: false,
        streaming: false
      }
    };
  }

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
    return Promise.resolve({
      channelId: this.descriptor.channelId,
      messageId: "sent-1"
    });
  }

  retract(_command: RetractChannelMessageCommandV1): Promise<void> {
    return Promise.resolve();
  }

  emit(message: InboundChannelMessageV1): void {
    for (const listener of [...this.listeners]) {
      void listener(message);
    }
  }
}

function inboundMessage(input: {
  messageId: string;
  conversationId: string;
  channelId?: string;
  conversationKind?: "direct" | "group";
  isSelf?: boolean;
  trigger?: "mention" | "command";
}): InboundChannelMessageV1 {
  return {
    messageId: input.messageId,
    route: {
      channelId: input.channelId ?? "qq-main",
      conversationKind: input.conversationKind ?? "group",
      conversationId: input.conversationId
    },
    sender: {
      id: "20002",
      username: "Alice",
      isSelf: input.isSelf ?? false
    },
    receivedAt: "2026-08-07T00:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...(input.trigger === undefined
      ? {}
      : { trigger: { kind: input.trigger } })
  };
}

describe("ChannelRuntime", () => {
  test("forwards every allowed event including self and duplicate messages", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["10001"] },
            directs: { mode: "allowlist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    adapter.emit(inboundMessage({ messageId: "plain", conversationId: "10001" }));
    adapter.emit(
      inboundMessage({
        messageId: "mention",
        conversationId: "10001",
        trigger: "mention"
      })
    );
    adapter.emit(
      inboundMessage({
        messageId: "command",
        conversationId: "10001",
        trigger: "command"
      })
    );
    adapter.emit(
      inboundMessage({
        messageId: "self",
        conversationId: "10001",
        isSelf: true
      })
    );
    adapter.emit(inboundMessage({ messageId: "plain", conversationId: "10001" }));
    adapter.emit(inboundMessage({ messageId: "blocked", conversationId: "99999" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(5));

    expect(
      onMessage.mock.calls.map((call) => {
        const input = call[0] as ChannelRuntimeMessage;
        return {
          sessionId: input.sessionId,
          messageId: input.message.messageId,
          isSelf: input.message.sender.isSelf,
          trigger: input.message.trigger?.kind
        };
      })
    ).toEqual([
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "plain",
        isSelf: false,
        trigger: undefined
      },
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "mention",
        isSelf: false,
        trigger: "mention"
      },
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "command",
        isSelf: false,
        trigger: "command"
      },
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "self",
        isSelf: true,
        trigger: undefined
      },
      {
        sessionId: "channel:qq-main:group:10001",
        messageId: "plain",
        isSelf: false,
        trigger: undefined
      }
    ]);
    expect("sessions" in runtime).toBe(false);

    await runtime.close();
  });

  test("accepts opaque non-numeric IDs in the generic access policy", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["team-alpha"] },
            directs: { mode: "allowlist", ids: ["-100987"] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    adapter.emit(
      inboundMessage({ messageId: "group", conversationId: "team-alpha" })
    );
    adapter.emit(
      inboundMessage({
        messageId: "direct",
        conversationKind: "direct",
        conversationId: "-100987"
      })
    );

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    await runtime.close();
  });

  test("atomically replaces access policy and keeps the last valid policy after rejection", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["10001"] },
            directs: { mode: "allowlist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    adapter.emit(inboundMessage({ messageId: "before", conversationId: "10001" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());

    runtime.replaceAccessPolicy("qq-main", {
      groups: { mode: "denylist", ids: ["10001"] },
      directs: { mode: "denylist", ids: [] }
    });
    adapter.emit(inboundMessage({ messageId: "now-blocked", conversationId: "10001" }));
    adapter.emit(inboundMessage({ messageId: "now-allowed", conversationId: "other" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));

    expect(() =>
      runtime.replaceAccessPolicy("qq-main", {
        groups: { mode: "allowlist", ids: [" "] },
        directs: { mode: "denylist", ids: [] }
      })
    ).toThrow(/groups.*non-empty/i);
    adapter.emit(inboundMessage({ messageId: "still-allowed", conversationId: "other" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(3));

    expect(
      onMessage.mock.calls.map(
        (call) => (call[0] as ChannelRuntimeMessage).message.messageId
      )
    ).toEqual(["before", "now-allowed", "still-allowed"]);
    await runtime.close();
  });

  test("replaces policies for multiple channels as one atomic update", async () => {
    const first = new FakeChannelAdapter("qq-main");
    const second = new FakeChannelAdapter("qq-secondary");
    const runtime = createChannelRuntime({
      channels: [first, second].map((adapter) => ({
        adapter,
        inboundPolicy: {
          groups: { mode: "allowlist" as const, ids: ["before"] },
          directs: { mode: "denylist" as const, ids: [] }
        }
      }))
    });

    runtime.replaceAccessPolicies(
      new Map([
        [
          "qq-main",
          {
            groups: { mode: "allowlist", ids: ["after-main"] },
            directs: { mode: "denylist", ids: [] }
          }
        ],
        [
          "qq-secondary",
          {
            groups: { mode: "allowlist", ids: ["after-secondary"] },
            directs: { mode: "denylist", ids: [] }
          }
        ]
      ])
    );

    expect(
      runtime.isRouteAllowed({
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "after-main"
      })
    ).toBe(true);
    expect(
      runtime.isRouteAllowed({
        channelId: "qq-secondary",
        conversationKind: "group",
        conversationId: "after-secondary"
      })
    ).toBe(true);

    expect(() =>
      runtime.replaceAccessPolicies(
        new Map([
          [
            "qq-main",
            {
              groups: { mode: "allowlist", ids: ["must-not-apply"] },
              directs: { mode: "denylist", ids: [] }
            }
          ],
          [
            "qq-secondary",
            {
              groups: { mode: "allowlist", ids: [" "] },
              directs: { mode: "denylist", ids: [] }
            }
          ]
        ])
      )
    ).toThrow(/groups.*non-empty/i);

    expect(
      runtime.isRouteAllowed({
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "after-main"
      })
    ).toBe(true);
    expect(
      runtime.isRouteAllowed({
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "must-not-apply"
      })
    ).toBe(false);
  });

  test("isolates the same route and message IDs across stable channel IDs", async () => {
    const first = new FakeChannelAdapter("qq-main");
    const second = new FakeChannelAdapter("qq-secondary");
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter: first,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "allowlist", ids: [] }
          }
        },
        {
          adapter: second,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "allowlist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    const firstMessage = inboundMessage({
      messageId: "same-message",
      conversationId: "10001"
    });
    const secondMessage = inboundMessage({
      messageId: "same-message",
      conversationId: "10001",
      channelId: "qq-secondary"
    });
    first.emit(firstMessage);
    second.emit(secondMessage);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));

    expect(
      onMessage.mock.calls.map(
        (call) => (call[0] as ChannelRuntimeMessage).sessionId
      )
    ).toEqual([
      "channel:qq-main:group:10001",
      "channel:qq-secondary:group:10001"
    ]);
    expect(runtime.resolveAdapter("qq-main")?.descriptor.channelId).toBe(
      "qq-main"
    );
    expect(runtime.resolveAdapter("qq-secondary")?.descriptor.channelId).toBe(
      "qq-secondary"
    );
    await runtime.close();
  });

  test("serializes user and self-event forwarding per route without blocking another route", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onMessage = vi
      .fn<(input: ChannelRuntimeMessage) => Promise<void>>()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue(undefined);
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    adapter.emit(inboundMessage({ messageId: "first", conversationId: "10001" }));
    adapter.emit(
      inboundMessage({
        messageId: "same-route-self",
        conversationId: "10001",
        isSelf: true
      })
    );
    adapter.emit(
      inboundMessage({
        messageId: "other-route",
        conversationKind: "direct",
        conversationId: "20002"
      })
    );

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    expect(
      onMessage.mock.calls.map(
        (call) => (call[0] as ChannelRuntimeMessage).message.messageId
      )
    ).toEqual(["first", "other-route"]);

    releaseFirst();
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(3));
    expect(onMessage.mock.calls[2]?.[0].message).toMatchObject({
      messageId: "same-route-self",
      sender: { isSelf: true }
    });
    await runtime.close();
  });

  test("serializes outbound operations per session without blocking another session", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseFirst!: () => void;
    const firstPending = new Promise<DeliveryReceiptV1>((resolve) => {
      releaseFirst = () =>
        resolve({ channelId: "qq-main", messageId: "sent-first" });
    });
    const send = vi
      .spyOn(adapter, "send")
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({
        channelId: "qq-main",
        messageId: "sent-other-session"
      })
      .mockResolvedValueOnce({
        channelId: "qq-main",
        messageId: "sent-second"
      });
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ]
    });
    await runtime.start();
    const ordered = runtime.resolveAdapter("qq-main")!;
    const firstCommand: SendChannelMessageCommandV1 = {
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001"
      },
      parts: [{ type: "text", text: "first" }]
    };
    const secondCommand: SendChannelMessageCommandV1 = {
      ...firstCommand,
      parts: [{ type: "text", text: "second" }]
    };
    const otherSessionCommand: SendChannelMessageCommandV1 = {
      route: {
        channelId: "qq-main",
        conversationKind: "direct",
        conversationId: "20002"
      },
      parts: [{ type: "text", text: "other" }]
    };

    const first = ordered.send(firstCommand);
    const second = ordered.send(secondCommand);
    const otherSession = ordered.send(otherSessionCommand);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      firstCommand,
      otherSessionCommand
    ]);

    releaseFirst();
    await expect(first).resolves.toEqual({
      channelId: "qq-main",
      messageId: "sent-first"
    });
    await expect(second).resolves.toEqual({
      channelId: "qq-main",
      messageId: "sent-second"
    });
    await expect(otherSession).resolves.toEqual({
      channelId: "qq-main",
      messageId: "sent-other-session"
    });
    expect(send).toHaveBeenCalledTimes(3);
    await runtime.close();
  });

  test("rechecks the latest access policy before dispatching queued outbound work", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseFirst!: () => void;
    const send = vi.spyOn(adapter, "send").mockImplementationOnce(
      () =>
        new Promise<DeliveryReceiptV1>((resolve) => {
          releaseFirst = () =>
            resolve({ channelId: "qq-main", messageId: "sent-first" });
        })
    );
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["10001"] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ]
    });
    await runtime.start();
    const ordered = runtime.resolveAdapter("qq-main")!;
    const command: SendChannelMessageCommandV1 = {
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001"
      },
      parts: [{ type: "text", text: "hello" }]
    };

    const first = ordered.send(command);
    const queued = ordered.send(command);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    runtime.replaceAccessPolicy("qq-main", {
      groups: { mode: "allowlist", ids: [] },
      directs: { mode: "denylist", ids: [] }
    });
    releaseFirst();

    await expect(first).resolves.toMatchObject({ messageId: "sent-first" });
    await expect(queued).rejects.toThrow(
      "Channel target is outside the allowed scope"
    );
    expect(send).toHaveBeenCalledOnce();
    await runtime.close();
  });

  test("rejects outbound work until startup completes while preserving startup events", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseStart!: () => void;
    vi.spyOn(adapter, "start").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        })
    );
    const send = vi.spyOn(adapter, "send");
    const operation = vi.fn(async () => "operation-result");
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ],
      onMessage
    });
    const ordered = runtime.resolveAdapter("qq-main")!;
    const command: SendChannelMessageCommandV1 = {
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001"
      },
      parts: [{ type: "text", text: "hello" }]
    };

    await expect(ordered.send(command)).rejects.toThrow(
      "ChannelRuntime is not started"
    );
    await expect(
      runtime.runOperation("qq-main", operation)
    ).rejects.toThrow("ChannelRuntime is not started");
    const starting = runtime.start();
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledOnce());
    adapter.emit(
      inboundMessage({ messageId: "during-start", conversationId: "10001" })
    );
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await expect(ordered.send(command)).rejects.toThrow(
      "ChannelRuntime is not started"
    );
    expect(send).not.toHaveBeenCalled();

    releaseStart();
    await starting;
    await expect(ordered.send(command)).resolves.toMatchObject({
      messageId: "sent-1"
    });
    await expect(runtime.runOperation("qq-main", operation)).resolves.toBe(
      "operation-result"
    );
    expect(send).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    await runtime.close();
    await expect(runtime.runOperation("qq-main", operation)).rejects.toThrow(
      "ChannelRuntime is closed"
    );
  });

  test("does not continue starting adapters after close begins", async () => {
    const first = new FakeChannelAdapter("qq-main");
    const second = new FakeChannelAdapter("qq-secondary");
    let releaseStart!: () => void;
    vi.spyOn(first, "start").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        })
    );
    const secondStart = vi.spyOn(second, "start");
    const runtime = createChannelRuntime({
      channels: [first, second].map((adapter) => ({
        adapter,
        inboundPolicy: {
          groups: { mode: "denylist" as const, ids: [] },
          directs: { mode: "denylist" as const, ids: [] }
        }
      }))
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
    const closing = runtime.close();
    let closeSettled = false;
    void closing.finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseStart();

    await expect(starting).rejects.toThrow("closed while starting");
    await closing;
    expect(secondStart).not.toHaveBeenCalled();
  });

  test("rejects queued outbound work instead of sending after close", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseFirst!: () => void;
    const send = vi.spyOn(adapter, "send").mockImplementationOnce(
      () =>
        new Promise<DeliveryReceiptV1>((resolve) => {
          releaseFirst = () =>
            resolve({ channelId: "qq-main", messageId: "sent-first" });
        })
    );
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ]
    });
    await runtime.start();
    const ordered = runtime.resolveAdapter("qq-main")!;
    const command: SendChannelMessageCommandV1 = {
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001"
      },
      parts: [{ type: "text", text: "hello" }]
    };

    const first = ordered.send(command);
    const queued = ordered.send(command);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const closing = runtime.close();
    releaseFirst();

    await expect(first).resolves.toMatchObject({ messageId: "sent-first" });
    await expect(queued).rejects.toThrow("ChannelRuntime is closed");
    await closing;
    expect(send).toHaveBeenCalledOnce();
  });

  test("does not dispatch queued inbound work after close begins", async () => {
    const adapter = new FakeChannelAdapter("qq-main");
    let releaseFirst!: () => void;
    const onMessage = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();

    adapter.emit(inboundMessage({ messageId: "first", conversationId: "10001" }));
    adapter.emit(inboundMessage({ messageId: "queued", conversationId: "10001" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());

    const closing = runtime.close();
    releaseFirst();
    await closing;

    expect(onMessage).toHaveBeenCalledOnce();
  });

  test("closes without waiting forever for an inbound handler that ignores abort", async () => {
    let releaseHandler!: () => void;
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const adapter = new FakeChannelAdapter("qq-main");
    const onMessage = vi.fn((_input: ChannelRuntimeMessage) => handlerRelease);
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();
    adapter.emit(inboundMessage({ messageId: "hanging", conversationId: "10001" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());

    const signal = onMessage.mock.calls[0]?.[0].signal;
    const closing = runtime.close();
    const settledPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    releaseHandler();
    await closing;

    expect(settledPromptly).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  test("uses Adapter conversation capabilities in addition to access policy", async () => {
    const adapter = new FakeChannelAdapter("qq-main", ["group"]);
    const onMessage = vi.fn();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "denylist", ids: [] },
            directs: { mode: "denylist", ids: [] }
          }
        }
      ],
      onMessage
    });
    await runtime.start();
    const direct = inboundMessage({
      messageId: "direct-unsupported",
      conversationKind: "direct",
      conversationId: "20002"
    });

    adapter.emit(direct);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onMessage).not.toHaveBeenCalled();
    expect(runtime.isRouteAllowed(direct.route)).toBe(false);
    await expect(
      runtime.resolveAdapter("qq-main")!.send({
        route: direct.route,
        parts: [{ type: "text", text: "unsupported" }]
      })
    ).rejects.toThrow("outside the allowed scope");
    await runtime.close();
  });
});
