import { describe, expect, test, vi } from "vitest";

import {
  InMemoryConversationSessionStore,
  SqliteConversationSessionStore,
  type ChannelAdapter,
  type ChannelConversationRoute,
  type ConversationSessionStore,
  type InboundChannelMessage,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import type { OpenAiAgentsRunContext } from "@huanlink/integration-openai-agents";
import type { OneBot11Operations } from "@huanlink/integration-onebot11";
import { Agent, RunContext } from "@openai/agents";

import {
  createChannelRuntime,
  type ChannelRuntime,
} from "../src/channel-runtime.js";
import {
  ONEBOT11_PRIVILEGED_TOOL_NAME,
  ONEBOT11_STANDARD_TOOL_NAME,
  createOneBot11OperationTools,
} from "../src/onebot-operation-tools.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

const SOURCE_SESSION_ID = "session:qq-main:group:10001";

function inboundMessage(
  messageId: string,
  overrides: Partial<InboundChannelMessage> = {},
): InboundChannelMessage {
  return {
    messageId,
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
    receivedAt: "2026-08-07T12:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...overrides,
  };
}

function context(
  sessionId = SOURCE_SESSION_ID,
): RunContext<OpenAiAgentsRunContext> {
  return new RunContext({
    runId: "run-onebot-tools",
    sessionId,
    trigger: "user",
  });
}

function toolCall(name: string, callId: string, argumentsJson: string) {
  return {
    type: "function_call" as const,
    callId,
    name,
    arguments: argumentsJson,
  };
}

function route(
  conversationKind: "group" | "direct",
  conversationId: string,
): ChannelConversationRoute {
  return { channelId: "qq-main", conversationKind, conversationId };
}

function operationsFixture() {
  const sendGroupMessage = vi.fn(
    async (): Promise<Record<string, unknown>> => ({ message_id: 7001 }),
  );
  const sendPrivateMessage = vi.fn(
    async (): Promise<Record<string, unknown>> => ({ message_id: 7002 }),
  );
  const getMessage = vi.fn(async () => ({
    message_id: 101,
    message: "stored",
  }));
  const getForwardMessage = vi.fn(async () => ({
    messages: [{ content: "forwarded" }],
  }));
  const sendLike = vi.fn(async () => ({ ok: true }));
  const setGroupBan = vi.fn(async () => ({ ok: true }));
  return {
    operations: {
      standard: {
        sendGroupMessage,
        sendPrivateMessage,
        getMessage,
        getForwardMessage,
        sendLike,
      },
      privileged: { setGroupBan },
    } as unknown as OneBot11Operations,
    sendGroupMessage,
    sendPrivateMessage,
    getMessage,
    getForwardMessage,
    sendLike,
    setGroupBan,
  };
}

function createFixture(
  input: {
    sessions?: ConversationSessionStore;
    historyRecorder?: SessionToolHistoryRecorder;
    unsafePrivilegedChannelIds?: readonly string[];
    operationChannelIds?: readonly string[];
    runtime?: Pick<
      ChannelRuntime,
      "isRouteAllowed" | "runOperation" | "runOutbound" | "sessionIdForRoute"
    >;
  } = {},
) {
  const sessions = input.sessions ?? new InMemoryConversationSessionStore();
  sessions.appendChannelMessage(SOURCE_SESSION_ID, inboundMessage("101"));
  const operationFixture = operationsFixture();
  const operationChannelIds = input.operationChannelIds ?? ["qq-main"];
  const outboundSpy = vi.fn();
  const resolveOperations = vi.fn((channelId: string) =>
    operationChannelIds.includes(channelId)
      ? operationFixture.operations
      : undefined,
  );
  const runOperationSpy = vi.fn((_channelId: string) => undefined);
  const runOperation = async <T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    runOperationSpy(channelId);
    return await operation();
  };
  const logger = new RecordingRuntimeLogger();
  const runOutbound = async <T>(
    candidate: ChannelConversationRoute,
    operation: () => Promise<T>,
  ): Promise<T> => {
    outboundSpy(candidate);
    return await operation();
  };
  const tools = createOneBot11OperationTools({
    sessions,
    ...(input.historyRecorder === undefined
      ? {}
      : { historyRecorder: input.historyRecorder }),
    resolveOperations,
    isRouteAllowed:
      input.runtime?.isRouteAllowed ??
      ((candidate) =>
        candidate.channelId === "qq-main" &&
        candidate.conversationKind === "group" &&
        candidate.conversationId !== "99999"),
    sessionIdForRoute:
      input.runtime?.sessionIdForRoute ??
      ((candidate) =>
        `session:${candidate.channelId}:${candidate.conversationKind}:${candidate.conversationId}`),
    runOperation: input.runtime?.runOperation ?? runOperation,
    runOutbound: input.runtime?.runOutbound ?? runOutbound,
    logger,
    ...(input.unsafePrivilegedChannelIds === undefined
      ? {}
      : {
          isUnsafePrivilegedOperationsEnabled: (channelId: string) =>
            input.unsafePrivilegedChannelIds!.includes(channelId),
        }),
  });
  return {
    sessions,
    ...operationFixture,
    outboundSpy,
    resolveOperations,
    runOperationSpy,
    logger,
    tools,
  };
}

function createTestChannelRuntime(input: {
  groups: { mode: "allowlist" | "denylist"; ids: string[] };
  directs: { mode: "allowlist" | "denylist"; ids: string[] };
}): ChannelRuntime {
  const adapter: ChannelAdapter = {
    descriptor: {
      channelId: "qq-main",
      platform: "onebot11",
      capabilities: {
        conversationKinds: ["group", "direct"],
        threads: false,
        inboundContentFormats: ["onebot11.cq"],
        outboundPartTypes: [
          "text",
          "mention",
          "attachmentLink",
          "attachmentLocalPath",
        ],
        reply: true,
        edit: false,
        retract: true,
        reaction: false,
        typing: false,
        streaming: false,
      },
    },
    start: async () => undefined,
    close: async () => undefined,
    onMessage: () => () => undefined,
    send: async () => ({ channelId: "qq-main", messageId: "unused" }),
    retract: async () => undefined,
  };
  return createChannelRuntime({
    channels: [{ adapter, inboundPolicy: input }],
  });
}

describe("OneBot 11 operation Tools", () => {
  test("accepts a SQLite Conversation Store through the public Store contract", async () => {
    const sessions = new SqliteConversationSessionStore(":memory:");
    try {
      const { tools } = createFixture({ sessions });
      const input = {
        channelId: "qq-main",
        request: {
          operation: "sendGroupMessage" as const,
          params: {
            groupId: "20002",
            parts: [{ type: "text" as const, text: "persisted message" }],
          },
        },
      };
      const argumentsJson = JSON.stringify(input);

      const output = await tools.standard.invoke(context(), argumentsJson, {
        toolCall: toolCall(
          ONEBOT11_STANDARD_TOOL_NAME,
          "call-sqlite-onebot",
          argumentsJson,
        ),
      });

      expect(JSON.parse(String(output))).toEqual({ message_id: 7001 });
      expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline).toContainEqual({
        type: "agent_tool_result",
        runId: "run-onebot-tools",
        toolCallId: "call-sqlite-onebot",
        toolName: ONEBOT11_STANDARD_TOOL_NAME,
        output: { message_id: 7001 },
      });
    } finally {
      sessions.close();
    }
  });

  test("exposes the standard Tool only to external Channel sessions and keeps privileged operations disabled by default", async () => {
    const { tools } = createFixture();
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "OneBot Tool availability test",
      instructions: "Test tool availability.",
      model: "mock",
    });

    expect(tools.standard.name).toBe(ONEBOT11_STANDARD_TOOL_NAME);
    expect(tools.privileged).toBeUndefined();
    await expect(tools.standard.isEnabled(context(), agent)).resolves.toBe(
      true,
    );
    await expect(
      tools.standard.isEnabled(context("internal-session"), agent),
    ).resolves.toBe(false);
  });

  test("exposes explicitly enabled privileged operations without claiming approval protection", async () => {
    const { logger, sessions, tools } = createFixture({
      unsafePrivilegedChannelIds: ["qq-main"],
    });
    const disabledSessionId = "session:qq-secondary:group:10001";
    sessions.appendChannelMessage(
      disabledSessionId,
      inboundMessage("102", {
        route: {
          channelId: "qq-secondary",
          conversationKind: "group",
          conversationId: "10001",
        },
      }),
    );
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "OneBot privileged Tool availability test",
      instructions: "Test privileged tool availability.",
      model: "mock",
    });

    expect(tools.privileged?.name).toBe(ONEBOT11_PRIVILEGED_TOOL_NAME);
    await expect(
      tools.privileged?.isEnabled(context("internal-session"), agent),
    ).resolves.toBe(false);
    await expect(
      tools.privileged?.isEnabled(context(disabledSessionId), agent),
    ).resolves.toBe(false);
    await expect(tools.privileged?.isEnabled(context(), agent)).resolves.toBe(
      true,
    );
    await expect(
      tools.privileged?.needsApproval(
        context(),
        {
          channelId: "qq-main",
          request: {
            operation: "setGroupBan",
            params: {
              groupId: "10001",
              userId: "20002",
              durationSeconds: 60,
            },
          },
        },
        "call-approval-check",
      ),
    ).resolves.toBe(false);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "onebot.privileged.enabled_without_protection",
      fields: { approvalProtection: false },
    });
  });

  test("runs an allowed standard send in the target route queue, returns raw data, and waits for self-message association", async () => {
    const { sessions, sendGroupMessage, outboundSpy, tools } = createFixture();
    const input = {
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "20002",
          parts: [{ type: "text", text: "completed" }],
        },
      },
    };
    const argumentsJson = JSON.stringify(input);

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-standard-send",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({ message_id: 7001 });
    expect(sendGroupMessage).toHaveBeenCalledWith(input.request.params);
    expect(outboundSpy).toHaveBeenCalledWith(route("group", "20002"));
    expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline).toContainEqual({
      type: "agent_tool_call",
      runId: "run-onebot-tools",
      toolCallId: "call-standard-send",
      toolName: ONEBOT11_STANDARD_TOOL_NAME,
      arguments: input,
    });

    sessions.appendChannelMessage(
      "session:qq-main:group:20002",
      inboundMessage("7001", {
        route: route("group", "20002"),
        sender: { id: "10000", username: "HuanLink", isSelf: true },
        content: "completed",
      }),
    );
    expect(
      sessions.getSession("session:qq-main:group:20002")?.timeline.at(-1),
    ).toEqual(
      expect.objectContaining({
        type: "channel_message",
        messageId: "7001",
        outbound: expect.objectContaining({
          sourceSessionId: SOURCE_SESSION_ID,
          origin: "cross_session",
        }),
      }),
    );
  });

  test("does not dispatch OneBot when recording the SDK Tool Call fails", async () => {
    const historyRecorder: SessionToolHistoryRecorder = {
      recordToolCall: () => {
        throw new Error("history call secret");
      },
      recordToolResult: () => undefined,
    };
    const { logger, sendGroupMessage, tools } = createFixture({
      historyRecorder,
    });
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "20002",
          parts: [{ type: "text", text: "OneBot secret content" }],
        },
      },
    });

    await expect(
      tools.standard.invoke(context(), argumentsJson, {
        toolCall: toolCall(
          ONEBOT11_STANDARD_TOOL_NAME,
          "call-onebot-history-write-failure",
          argumentsJson,
        ),
      }),
    ).rejects.toThrow("Tool history Call recording failed");

    expect(sendGroupMessage).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "main_agent.tool.history.write_failed",
      fields: {
        runId: "run-onebot-tools",
        sessionId: SOURCE_SESSION_ID,
        toolCallId: "call-onebot-history-write-failure",
        toolName: ONEBOT11_STANDARD_TOOL_NAME,
        historyStage: "call",
        errorType: "Error",
      },
    });
    expect(JSON.stringify(logger.entries)).not.toContain("secret");
  });

  test("keeps schema-invalid OneBot JSON arguments raw in Tool history", async () => {
    const { sendGroupMessage, sessions, tools } = createFixture();
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: { groupId: "20002", parts: [] },
      },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-onebot-schema-invalid",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toMatchObject({
      status: "error",
      tool: ONEBOT11_STANDARD_TOOL_NAME,
    });
    expect(sendGroupMessage).not.toHaveBeenCalled();
    expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline.at(-2)).toEqual({
      type: "agent_tool_call",
      runId: "run-onebot-tools",
      toolCallId: "call-onebot-schema-invalid",
      toolName: ONEBOT11_STANDARD_TOOL_NAME,
      rawArguments: argumentsJson,
    });
  });

  test("keeps raw OneBot response data when recording its Tool Result fails", async () => {
    let sessionStore: ConversationSessionStore | undefined;
    const historyRecorder: SessionToolHistoryRecorder = {
      recordToolCall: (sessionId, call) =>
        sessionStore!.appendAgentToolCall(sessionId, call),
      recordToolResult: () => {
        throw new Error("history result secret");
      },
    };
    const fixture = createFixture({
      historyRecorder,
    });
    sessionStore = fixture.sessions;
    const { logger, sendGroupMessage, tools } = fixture;
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "20002",
          parts: [{ type: "text", text: "OneBot secret content" }],
        },
      },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-onebot-history-result-failure",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({
      message_id: 7001,
      historyWarning: "Tool result history was not persisted.",
    });
    expect(sendGroupMessage).toHaveBeenCalledOnce();
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "main_agent.tool.history.write_failed",
      fields: {
        runId: "run-onebot-tools",
        sessionId: SOURCE_SESSION_ID,
        toolCallId: "call-onebot-history-result-failure",
        toolName: ONEBOT11_STANDARD_TOOL_NAME,
        historyStage: "result",
        errorType: "Error",
      },
    });
    expect(JSON.stringify(logger.entries)).not.toContain("secret");
  });

  test("rejects a disallowed explicit target before any protocol call", async () => {
    const { sendGroupMessage, outboundSpy, tools } = createFixture();
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "99999",
          parts: [{ type: "text", text: "blocked" }],
        },
      },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-blocked",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({
      status: "error",
      tool: ONEBOT11_STANDARD_TOOL_NAME,
      error: "OneBot target is not allowed",
    });
    expect(sendGroupMessage).not.toHaveBeenCalled();
    expect(outboundSpy).not.toHaveBeenCalled();
  });

  test("uses the Channel Runtime's latest access policy for every standard target", async () => {
    const runtime = createTestChannelRuntime({
      groups: { mode: "allowlist", ids: [] },
      directs: { mode: "denylist", ids: [] },
    });
    const { sendGroupMessage, tools } = createFixture({ runtime });
    await runtime.start();
    const input = {
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: { groupId: "20002", parts: [{ type: "text", text: "latest" }] },
      },
    };
    const argumentsJson = JSON.stringify(input);

    const blocked = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-policy-blocked",
        argumentsJson,
      ),
    });
    expect(JSON.parse(String(blocked))).toMatchObject({
      status: "error",
      error: "OneBot target is not allowed",
    });
    expect(sendGroupMessage).not.toHaveBeenCalled();

    runtime.replaceAccessPolicy("qq-main", {
      groups: { mode: "allowlist", ids: ["20002"] },
      directs: { mode: "denylist", ids: [] },
    });
    const allowed = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-policy-allowed",
        argumentsJson,
      ),
    });
    expect(JSON.parse(String(allowed))).toEqual({ message_id: 7001 });
    expect(sendGroupMessage).toHaveBeenCalledOnce();
    await runtime.close();
  });

  test("serializes likes behind messages for the same direct route", async () => {
    const runtime = createTestChannelRuntime({
      groups: { mode: "denylist", ids: [] },
      directs: { mode: "allowlist", ids: ["20002"] },
    });
    const { sendLike, sendPrivateMessage, tools } = createFixture({ runtime });
    let releaseMessage!: () => void;
    sendPrivateMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMessage = () => resolve({ message_id: 7002 });
        }),
    );
    await runtime.start();

    const messageArguments = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendPrivateMessage",
        params: { userId: "20002", parts: [{ type: "text", text: "first" }] },
      },
    });
    const likeArguments = JSON.stringify({
      channelId: "qq-main",
      request: { operation: "sendLike", params: { userId: "20002" } },
    });
    const message = tools.standard.invoke(context(), messageArguments, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-private-message",
        messageArguments,
      ),
    });
    await vi.waitFor(() => expect(sendPrivateMessage).toHaveBeenCalledOnce());
    const like = tools.standard.invoke(context(), likeArguments, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-like",
        likeArguments,
      ),
    });
    const likeStateBeforeMessage = await Promise.race([
      like.then(() => "settled" as const),
      new Promise<"waiting">((resolve) =>
        setTimeout(() => resolve("waiting"), 25),
      ),
    ]);
    expect(likeStateBeforeMessage).toBe("waiting");
    expect(sendLike).not.toHaveBeenCalled();

    releaseMessage();
    await expect(message).resolves.toBe(JSON.stringify({ message_id: 7002 }));
    await expect(like).resolves.toBe(JSON.stringify({ ok: true }));
    expect(sendLike).toHaveBeenCalledOnce();
    await runtime.close();
  });

  test("passes message and merged-forward lookups directly to OneBot without a Session index", async () => {
    const { getForwardMessage, getMessage, tools } = createFixture();
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: { operation: "getMessage", params: { messageId: "404" } },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-missing-message",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({
      message_id: 101,
      message: "stored",
    });
    expect(getMessage).toHaveBeenCalledWith({ messageId: "404" });

    const forwardArgumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "getForwardMessage",
        params: { messageId: "forward-1" },
      },
    });
    const forwardOutput = await tools.standard.invoke(
      context(),
      forwardArgumentsJson,
      {
        toolCall: toolCall(
          ONEBOT11_STANDARD_TOOL_NAME,
          "call-forward-message",
          forwardArgumentsJson,
        ),
      },
    );

    expect(JSON.parse(String(forwardOutput))).toEqual({
      messages: [{ content: "forwarded" }],
    });
    expect(getForwardMessage).toHaveBeenCalledWith({ messageId: "forward-1" });
  });

  test("returns delivery uncertainty instead of inventing an outbound association", async () => {
    const { sessions, sendGroupMessage, tools } = createFixture();
    sendGroupMessage.mockResolvedValueOnce({ ok: true });
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "20002",
          parts: [{ type: "text", text: "maybe sent" }],
        },
      },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-uncertain",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({
      status: "uncertain",
      tool: ONEBOT11_STANDARD_TOOL_NAME,
      error: "OneBot send response did not contain message_id",
    });
    expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline).not.toContainEqual(
      expect.objectContaining({ messageId: "maybe" }),
    );
  });

  test("keeps confirmed send data unchanged when Session association fails", async () => {
    const { sessions, sendGroupMessage, logger, tools } = createFixture();
    vi.spyOn(sessions, "recordOutboundDelivery").mockImplementationOnce(() => {
      throw new Error("Session association failed");
    });
    const argumentsJson = JSON.stringify({
      channelId: "qq-main",
      request: {
        operation: "sendGroupMessage",
        params: {
          groupId: "20002",
          parts: [{ type: "text", text: "sent but untracked" }],
        },
      },
    });

    const output = await tools.standard.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_STANDARD_TOOL_NAME,
        "call-association-warning",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({ message_id: 7001 });
    expect(sendGroupMessage).toHaveBeenCalledOnce();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "onebot.operation.session_association_failed",
        fields: expect.objectContaining({
          messageId: "7001",
          errorType: "Error",
        }),
      }),
    );
    expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline.at(-1)).toEqual({
      type: "agent_tool_result",
      runId: "run-onebot-tools",
      toolCallId: "call-association-warning",
      toolName: ONEBOT11_STANDARD_TOOL_NAME,
      output: { message_id: 7001 },
    });
  });

  test("gates explicitly enabled privileged operations on Runtime lifecycle without route-list checks", async () => {
    const runtime = createTestChannelRuntime({
      groups: { mode: "allowlist", ids: [] },
      directs: { mode: "allowlist", ids: [] },
    });
    const { setGroupBan, tools } = createFixture({
      unsafePrivilegedChannelIds: ["qq-main"],
      runtime,
    });
    const input = {
      channelId: "qq-main",
      request: {
        operation: "setGroupBan",
        params: { groupId: "99999", userId: "20002", durationSeconds: 60 },
      },
    };
    const argumentsJson = JSON.stringify(input);

    const beforeStart = await tools.privileged!.invoke(
      context(),
      argumentsJson,
      {
        toolCall: toolCall(
          ONEBOT11_PRIVILEGED_TOOL_NAME,
          "call-ban",
          argumentsJson,
        ),
      },
    );
    expect(JSON.parse(String(beforeStart))).toMatchObject({
      status: "error",
      error: "ChannelRuntime is not started",
    });
    expect(setGroupBan).not.toHaveBeenCalled();

    await runtime.start();
    const output = await tools.privileged!.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_PRIVILEGED_TOOL_NAME,
        "call-ban-started",
        argumentsJson,
      ),
    });
    expect(JSON.parse(String(output))).toEqual({ ok: true });
    expect(setGroupBan).toHaveBeenCalledWith(input.request.params);
    await runtime.close();
  });

  test("rejects privileged operations for a target Channel whose unsafe switch is disabled", async () => {
    const {
      sessions,
      setGroupBan,
      resolveOperations,
      runOperationSpy,
      logger,
      tools,
    } = createFixture({
      unsafePrivilegedChannelIds: ["qq-main"],
      operationChannelIds: ["qq-main", "qq-secondary"],
    });
    const input = {
      channelId: "qq-secondary",
      request: {
        operation: "setGroupBan",
        params: { groupId: "99999", userId: "20002", durationSeconds: 60 },
      },
    };
    const argumentsJson = JSON.stringify(input);

    const output = await tools.privileged!.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        ONEBOT11_PRIVILEGED_TOOL_NAME,
        "call-disabled-target",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toEqual({
      status: "error",
      tool: ONEBOT11_PRIVILEGED_TOOL_NAME,
      error:
        "Unsafe privileged OneBot operations are not enabled for qq-secondary",
    });
    expect(resolveOperations).not.toHaveBeenCalled();
    expect(runOperationSpy).not.toHaveBeenCalled();
    expect(setGroupBan).not.toHaveBeenCalled();
    expect(logger.find("onebot.operation.completed")).toMatchObject({
      level: "info",
      fields: {
        channelId: "qq-secondary",
        operation: "setGroupBan",
        status: "error",
      },
    });
    expect(sessions.getSession(SOURCE_SESSION_ID)?.timeline.slice(-2)).toEqual([
      {
        type: "agent_tool_call",
        runId: "run-onebot-tools",
        toolCallId: "call-disabled-target",
        toolName: ONEBOT11_PRIVILEGED_TOOL_NAME,
        arguments: input,
      },
      {
        type: "agent_tool_result",
        runId: "run-onebot-tools",
        toolCallId: "call-disabled-target",
        toolName: ONEBOT11_PRIVILEGED_TOOL_NAME,
        output: {
          status: "error",
          tool: ONEBOT11_PRIVILEGED_TOOL_NAME,
          error:
            "Unsafe privileged OneBot operations are not enabled for qq-secondary",
        },
      },
    ]);
  });
});
