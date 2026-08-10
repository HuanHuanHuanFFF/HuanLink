import { describe, expect, test, vi } from "vitest";

import {
  ChannelOperationError,
  InMemoryConversationSessionStore,
  type ChannelAdapter,
  type InboundChannelMessage,
} from "@huanlink/core";
import type { OpenAiAgentsRunContext } from "@huanlink/integration-openai-agents";
import { Agent, RunContext, tool } from "@openai/agents";
import { z } from "zod";

import { createChannelReplyTool } from "../src/channel-reply-tool.js";
import { createChannelRuntime } from "../src/channel-runtime.js";
import { createPhase3MainAgentRuntime } from "../src/main-agent-runtime.js";

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
    receivedAt: "2026-08-03T12:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
    ...overrides,
  };
}

function runContext(sessionId: string): RunContext<OpenAiAgentsRunContext> {
  return new RunContext({
    runId: "run-reply",
    sessionId,
    trigger: "user",
  });
}

function toolCall(callId: string, argumentsJson: string) {
  return {
    type: "function_call" as const,
    callId,
    name: "reply",
    arguments: argumentsJson,
  };
}

function fakeAdapter(messageId = "message-2"): ChannelAdapter & {
  send: ReturnType<typeof vi.fn<ChannelAdapter["send"]>>;
} {
  const send = vi.fn<ChannelAdapter["send"]>(async () => ({
    channelId: "qq-main",
    messageId,
  }));
  return {
    descriptor: {
      channelId: "qq-main",
      platform: "test",
      capabilities: {
        conversationKinds: ["group"],
        threads: false,
        inboundContentFormats: ["test.text"],
        outboundPartTypes: [
          "text",
          "mention",
          "attachmentLink",
          "attachmentLocalPath",
        ],
        reply: true,
        edit: false,
        retract: false,
        reaction: false,
        typing: false,
        streaming: false,
      },
    },
    start: async () => undefined,
    close: async () => undefined,
    onMessage: () => () => undefined,
    send,
    retract: async () => undefined,
  };
}

describe("current-session reply Tool", () => {
  test("is exposed only for a session explicitly marked as an external channel", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => undefined,
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Reply availability test",
      instructions: "Test tool availability.",
      model: "mock",
    });

    await expect(
      tool.isEnabled(runContext("session-channel"), agent),
    ).resolves.toBe(true);
    await expect(
      tool.isEnabled(runContext("session-internal"), agent),
    ).resolves.toBe(false);
  });

  test("sends to the trusted current route and waits for the self event before creating a public message", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
      now: () => new Date("2026-08-03T12:01:00.000Z"),
    });
    const input = {
      parts: [
        { type: "text", text: "done " },
        { type: "mention", targetId: "all" },
      ],
      replyToMessageId: "message-from-another-chat",
    };
    const argumentsJson = JSON.stringify(input);

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-reply-1", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "success",
      tool: "reply",
      messageId: "message-2",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledWith({
      route: inboundMessage("unused").route,
      parts: input.parts,
      replyToMessageId: "message-from-another-chat",
    });
    expect(sessions.getSession("session-channel")?.timeline).toEqual([
      expect.objectContaining({
        type: "channel_message",
        messageId: "message-1",
      }),
      {
        type: "agent_tool_call",
        runId: "run-reply",
        toolCallId: "call-reply-1",
        toolName: "reply",
        arguments: input,
      },
      {
        type: "agent_tool_result",
        runId: "run-reply",
        toolCallId: "call-reply-1",
        toolName: "reply",
        output: {
          status: "success",
          tool: "reply",
          messageId: "message-2",
        },
      },
    ]);

    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-2", {
        sender: {
          id: "10000",
          username: "HuanLink",
          isSelf: true,
        },
        content: "done [CQ:at,qq=all]",
      }),
    );

    expect(sessions.getSession("session-channel")?.timeline.at(-1)).toEqual(
      expect.objectContaining({
        type: "channel_message",
        messageId: "message-2",
        outbound: {
          sentAt: "2026-08-03T12:01:00.000Z",
          runId: "run-reply",
          toolCallId: "call-reply-1",
          sourceSessionId: "session-channel",
          origin: "current_session",
        },
      }),
    );
  });

  test("returns the original definite adapter error and never retries inside the Tool", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    adapter.send.mockRejectedValueOnce(
      new ChannelOperationError(
        "temporarily_unavailable",
        "OneBot 11 WebSocket is not connected",
        { cause: new Error("connection closed before dispatch") },
      ),
    );
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "send once" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-error", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "error",
      tool: "reply",
      error:
        "OneBot 11 WebSocket is not connected: connection closed before dispatch",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(sessions.getSession("session-channel")?.timeline.at(-1)).toEqual({
      type: "agent_tool_result",
      runId: "run-reply",
      toolCallId: "call-error",
      toolName: "reply",
      output: {
        status: "error",
        tool: "reply",
        error:
          "OneBot 11 WebSocket is not connected: connection closed before dispatch",
      },
    });
  });

  test("returns error when ChannelRuntime rejects the send before platform dispatch", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    const runtime = createChannelRuntime({
      channels: [
        {
          adapter,
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["10001"] },
            directs: { mode: "denylist", ids: [] },
          },
        },
      ],
    });
    await runtime.start();
    const replyTool = createChannelReplyTool({
      sessions,
      resolveAdapter: (channelId) => runtime.resolveAdapter(channelId),
    });
    await runtime.close();
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "must not be sent" }],
    });

    const output = await replyTool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-runtime-closed", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "error",
      tool: "reply",
      error: "ChannelRuntime is closed",
    });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  test("does not duplicate a safe transport summary already contained in the Adapter error", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    const transportSummary =
      "OneBot 11 action failed: status=failed retcode=1404";
    adapter.send.mockRejectedValueOnce(
      new ChannelOperationError(
        "not_supported",
        `${transportSummary} message=platform message`,
        { cause: new Error(transportSummary) },
      ),
    );
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "send once" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-no-duplicate", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "error",
      tool: "reply",
      error: `${transportSummary} message=platform message`,
    });
  });

  test("returns uncertain for a dispatched action and redacts configured credentials", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    adapter.send.mockRejectedValueOnce(
      new ChannelOperationError(
        "delivery_uncertain",
        "OneBot response timed out for token secret-token",
      ),
    );
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
      redactValues: ["secret-token"],
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "possibly sent" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-uncertain", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "uncertain",
      tool: "reply",
      error: "OneBot response timed out for token [Redacted]",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  test("returns uncertain for an unknown Adapter failure after send was attempted", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    adapter.send.mockRejectedValueOnce(new Error("unexpected socket failure"));
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "send once" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-unknown", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "uncertain",
      tool: "reply",
      error: "unexpected socket failure",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  test("returns uncertain when an Adapter reports success without a usable receipt", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    adapter.send.mockResolvedValueOnce({
      channelId: "qq-main",
      messageId: " ",
    });
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "missing receipt" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-invalid-receipt", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "uncertain",
      tool: "reply",
      error:
        "Channel send returned an invalid delivery receipt; the message may have been sent",
    });
  });

  test("returns success with a warning when the sent message cannot be associated with the Session", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    vi.spyOn(sessions, "recordOutboundDelivery").mockImplementationOnce(() => {
      throw new Error("Session association failed");
    });
    const adapter = fakeAdapter();
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "sent but untracked" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-warning", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "success",
      tool: "reply",
      messageId: "message-2",
      warning: "Session association failed",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  test("keeps confirmed delivery successful when local association time cannot be created", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    const tool = createChannelReplyTool({
      sessions,
      resolveAdapter: () => adapter,
      now: () => {
        throw new Error("Local clock failed");
      },
    });
    const argumentsJson = JSON.stringify({
      parts: [{ type: "text", text: "sent but untracked" }],
    });

    const output = await tool.invoke(
      runContext("session-channel"),
      argumentsJson,
      { toolCall: toolCall("call-clock-warning", argumentsJson) },
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "success",
      tool: "reply",
      messageId: "message-2",
      warning: "Local clock failed",
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  test("registers reply with MainAgent while keeping it hidden from non-Channel sessions", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-channel",
      inboundMessage("message-1"),
    );
    const adapter = fakeAdapter();
    const platformTool = tool<
      typeof platformToolParameters,
      OpenAiAgentsRunContext
    >({
      name: "onebot_standard",
      description: "test platform tool",
      parameters: platformToolParameters,
      execute: () => "ok",
    });
    const observedTools: string[][] = [];
    const runtime = createPhase3MainAgentRuntime({
      invoker: {
        invoke: async () => ({
          status: "accepted",
          executionMode: "async",
          agentCallId: "unused-agent-call",
          taskId: "unused-a2a-task",
          state: "submitted",
        }),
      },
      taskReader: {
        getByAgentCallId: () => undefined,
        getByTaskId: () => undefined,
      },
      taskContinuator: {
        continueTask: async () => {
          throw new Error("Unexpected continuation");
        },
      },
      channelReply: {
        sessions,
        resolveAdapter: () => adapter,
      },
      additionalTools: [platformTool],
      runner: {
        run: async (agent, _input, options) => {
          const context = options?.context;
          if (context === undefined) {
            throw new Error("Expected HuanLink RunContext");
          }
          observedTools.push(
            (await agent.getAllTools(new RunContext(context))).map(
              ({ name }) => name,
            ),
          );
          return { finalOutput: "internal result only" };
        },
      },
    });

    await runtime.run({
      runId: "run-channel-tools",
      sessionId: "session-channel",
      input: "channel message",
    });
    await runtime.run({
      runId: "run-internal-tools",
      sessionId: "session-internal",
      input: "internal task",
    });

    expect(observedTools[0]).toContain("reply");
    expect(observedTools[0]).toContain("onebot_standard");
    expect(observedTools[1]).not.toContain("reply");
    expect(observedTools[1]).toContain("onebot_standard");
    expect(adapter.send).not.toHaveBeenCalled();
  });
});

const platformToolParameters = z.object({});
