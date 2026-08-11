import {
  InMemoryConversationSessionStore,
  type ConversationSessionStore,
  type RunId,
} from "@huanlink/core";
import { describe, expect, test, vi } from "vitest";

import type { ChannelRuntimeMessage } from "../src/channel-runtime.js";
import { createSessionIngressCoordinator } from "../src/session-ingress-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function channelMessage(input: {
  readonly messageId: string;
  readonly content?: string;
  readonly conversationId?: string;
  readonly isSelf?: boolean;
  readonly sessionId?: string;
  readonly trigger?: "mention" | "command";
  readonly signal?: AbortSignal;
}): ChannelRuntimeMessage {
  const conversationId = input.conversationId ?? "10001";
  return {
    sessionId: input.sessionId ?? `channel:qq-main:group:${conversationId}`,
    message: {
      messageId: input.messageId,
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId,
      },
      sender: {
        id: input.isSelf === true ? "10000" : "20002",
        username: input.isSelf === true ? "HuanLink" : "Alice",
        isSelf: input.isSelf ?? false,
      },
      receivedAt: "2026-08-09T00:00:00.000Z",
      content: input.content ?? "hello",
      contentFormat: "onebot11.cq",
      ...(input.trigger === undefined
        ? {}
        : { trigger: { kind: input.trigger } }),
    },
    signal: input.signal ?? new AbortController().signal,
  };
}

describe("SessionIngressCoordinator", () => {
  test("awaits an appended mention without capturing a pre-queue input", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const run = deferred<{ output: string }>();
    const runMainAgent = vi.fn(() => run.promise);
    const createRunId = vi.fn<() => RunId>(() => "run-mention");
    const controller = new AbortController();
    const message = channelMessage({
      messageId: "mention-1",
      content: "@HuanLink help me",
      trigger: "mention",
      signal: controller.signal,
    });
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
      createRunId,
    });

    const handling = coordinator.handle(message);
    await vi.waitFor(() => expect(runMainAgent).toHaveBeenCalledOnce());

    expect(sessions.getSession(message.sessionId)?.timeline).toHaveLength(1);
    expect(runMainAgent).toHaveBeenCalledWith({
      runId: "run-mention",
      sessionId: message.sessionId,
      signal: controller.signal,
    });
    expect(createRunId).toHaveBeenCalledOnce();

    const pending = vi.fn();
    void handling.then(pending);
    await Promise.resolve();
    expect(pending).not.toHaveBeenCalled();

    run.resolve({ output: "done" });
    await expect(handling).resolves.toBeUndefined();
  });

  test("keeps plain and self facts without starting MainAgent", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runMainAgent = vi.fn(async () => ({ output: "unexpected" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
    });
    const plain = channelMessage({ messageId: "plain-1" });
    const selfCommand = channelMessage({
      messageId: "self-command-1",
      isSelf: true,
      trigger: "command",
    });

    await coordinator.handle(plain);
    await coordinator.handle(selfCommand);

    expect(runMainAgent).not.toHaveBeenCalled();
    expect(sessions.getSession(plain.sessionId)?.timeline).toEqual([
      expect.objectContaining({ messageId: "plain-1" }),
      expect.objectContaining({ messageId: "self-command-1" }),
    ]);
  });

  test("starts MainAgent for an appended non-self command", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runMainAgent = vi.fn(async () => ({ output: "done" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
      createRunId: () => "run-command",
    });
    const command = channelMessage({
      messageId: "command-1",
      content: "/huanlink status",
      trigger: "command",
    });

    await coordinator.handle(command);

    expect(runMainAgent).toHaveBeenCalledWith({
      runId: "run-command",
      sessionId: command.sessionId,
      signal: command.signal,
    });
  });

  test("does not start another turn for a duplicate mention", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runMainAgent = vi.fn(async () => ({ output: "done" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
      createRunId: () => "run-once",
    });
    const mention = channelMessage({
      messageId: "mention-duplicate",
      trigger: "mention",
    });

    await coordinator.handle(mention);
    await coordinator.handle(mention);

    expect(runMainAgent).toHaveBeenCalledOnce();
    expect(sessions.getSession(mention.sessionId)?.timeline).toHaveLength(1);
  });

  test("does not start MainAgent for an associated Store result", async () => {
    const appendChannelMessage = vi.fn((): "associated" => "associated");
    const sessionStore: ConversationSessionStore = {
      appendChannelMessage,
      recordOutboundDelivery: () => undefined,
      appendAgentToolCall: () => undefined,
      appendAgentToolResult: () => undefined,
      getAgentToolCall: () => undefined,
      getSession: () => undefined,
      getSessionMetadata: () => undefined,
      getSessionContextWindow: () => undefined,
    };
    const runMainAgent = vi.fn(async () => ({ output: "unexpected" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore,
      runner: { runMainAgent },
    });
    const associated = channelMessage({
      messageId: "self-associated",
      trigger: "mention",
    });

    await coordinator.handle(associated);

    expect(appendChannelMessage).toHaveBeenCalledWith(
      associated.sessionId,
      associated.message,
    );
    expect(runMainAgent).not.toHaveBeenCalled();
  });

  test("propagates Store conflict without a second MainAgent turn", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runMainAgent = vi.fn(async () => ({ output: "done" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
    });
    const observed = channelMessage({
      messageId: "conflict-1",
      content: "original",
      trigger: "mention",
    });

    await coordinator.handle(observed);
    await expect(
      coordinator.handle(
        channelMessage({
          messageId: "conflict-1",
          content: "changed",
          trigger: "mention",
        }),
      ),
    ).rejects.toThrow("conflicts with existing observed facts");

    expect(runMainAgent).toHaveBeenCalledOnce();
    expect(sessions.getSession(observed.sessionId)?.timeline).toEqual([
      expect.objectContaining({
        messageId: "conflict-1",
        observed: expect.objectContaining({ content: "original" }),
      }),
    ]);
  });

  test("keeps facts when MainAgent fails without retrying", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runnerError = new Error("MainAgent unavailable");
    const runMainAgent = vi.fn(async () => {
      throw runnerError;
    });
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
    });
    const mention = channelMessage({
      messageId: "runner-failure-1",
      trigger: "mention",
    });

    await expect(coordinator.handle(mention)).rejects.toBe(runnerError);

    expect(runMainAgent).toHaveBeenCalledOnce();
    expect(sessions.getSession(mention.sessionId)?.timeline).toEqual([
      expect.objectContaining({ messageId: "runner-failure-1" }),
    ]);
  });

  test("keeps aborted message facts without starting MainAgent", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const runMainAgent = vi.fn(async () => ({ output: "unexpected" }));
    const createRunId = vi.fn<() => RunId>(() => "run-aborted");
    const controller = new AbortController();
    controller.abort(new Error("ChannelRuntime closed"));
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
      createRunId,
    });
    const mention = channelMessage({
      messageId: "aborted-mention-1",
      trigger: "mention",
      signal: controller.signal,
    });

    await coordinator.handle(mention);

    expect(runMainAgent).not.toHaveBeenCalled();
    expect(createRunId).not.toHaveBeenCalled();
    expect(sessions.getSession(mention.sessionId)?.timeline).toEqual([
      expect.objectContaining({ messageId: "aborted-mention-1" }),
    ]);
  });

  test("does not serialize separate routes behind MainAgent", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const pendingRuns = [
      deferred<{ output: string }>(),
      deferred<{ output: string }>(),
    ];
    let nextRun = 0;
    const runMainAgent = vi.fn(() => pendingRuns[nextRun++]!.promise);
    const coordinator = createSessionIngressCoordinator({
      sessionStore: sessions,
      runner: { runMainAgent },
    });
    const first = channelMessage({
      messageId: "route-one",
      conversationId: "10001",
      trigger: "mention",
    });
    const second = channelMessage({
      messageId: "route-two",
      conversationId: "20002",
      trigger: "command",
    });

    const firstHandling = coordinator.handle(first);
    await vi.waitFor(() => expect(runMainAgent).toHaveBeenCalledOnce());
    const secondHandling = coordinator.handle(second);
    await vi.waitFor(() => expect(runMainAgent).toHaveBeenCalledTimes(2));

    pendingRuns[0].resolve({ output: "first" });
    pendingRuns[1].resolve({ output: "second" });
    await expect(Promise.all([firstHandling, secondHandling])).resolves.toEqual(
      [undefined, undefined],
    );
  });

  test("propagates Store write failure without MainAgent", async () => {
    const storeError = new Error("Store temporarily unavailable");
    const appendChannelMessage = vi.fn(() => {
      throw storeError;
    });
    const sessionStore: ConversationSessionStore = {
      appendChannelMessage,
      recordOutboundDelivery: () => undefined,
      appendAgentToolCall: () => undefined,
      appendAgentToolResult: () => undefined,
      getAgentToolCall: () => undefined,
      getSession: () => undefined,
      getSessionMetadata: () => undefined,
      getSessionContextWindow: () => undefined,
    };
    const runMainAgent = vi.fn(async () => ({ output: "unexpected" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore,
      runner: { runMainAgent },
    });
    const mention = channelMessage({
      messageId: "store-error-1",
      trigger: "mention",
    });

    await expect(coordinator.handle(mention)).rejects.toBe(storeError);

    expect(appendChannelMessage).toHaveBeenCalledOnce();
    expect(runMainAgent).not.toHaveBeenCalled();
  });

  test("does not start MainAgent if Channel aborts during Store append", async () => {
    const sessions = new InMemoryConversationSessionStore();
    const controller = new AbortController();
    const sessionStore: ConversationSessionStore = {
      appendChannelMessage: (sessionId, message) => {
        const result = sessions.appendChannelMessage(sessionId, message);
        controller.abort(new Error("ChannelRuntime closed during append"));
        return result;
      },
      recordOutboundDelivery: sessions.recordOutboundDelivery.bind(sessions),
      appendAgentToolCall: sessions.appendAgentToolCall.bind(sessions),
      appendAgentToolResult: sessions.appendAgentToolResult.bind(sessions),
      getAgentToolCall: sessions.getAgentToolCall.bind(sessions),
      getSession: sessions.getSession.bind(sessions),
      getSessionMetadata: sessions.getSessionMetadata.bind(sessions),
      getSessionContextWindow: sessions.getSessionContextWindow.bind(sessions),
    };
    const runMainAgent = vi.fn(async () => ({ output: "unexpected" }));
    const coordinator = createSessionIngressCoordinator({
      sessionStore,
      runner: { runMainAgent },
    });
    const mention = channelMessage({
      messageId: "abort-during-append-1",
      trigger: "mention",
      signal: controller.signal,
    });

    await coordinator.handle(mention);

    expect(runMainAgent).not.toHaveBeenCalled();
    expect(sessions.getSession(mention.sessionId)?.timeline).toEqual([
      expect.objectContaining({ messageId: "abort-during-append-1" }),
    ]);
  });
});
