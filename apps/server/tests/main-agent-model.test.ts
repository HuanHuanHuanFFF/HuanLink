import { describe, expect, test, vi } from "vitest";

import {
  InMemoryConversationSessionStore,
  type ChannelAdapter,
} from "@huanlink/core";
import type { AgentCallContinuator, AgentCallInvoker } from "@huanlink/core";
import { CONTINUE_TASK_TOOL_NAME } from "@huanlink/integration-openai-agents";
import type { OneBot11Operations } from "@huanlink/integration-onebot11";

import {
  createDeepSeekMainAgentModelBinding,
  createOneBot11OperationTools,
  createPhase3MainAgentRuntime,
} from "../src/index.js";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

describe("createDeepSeekMainAgentModelBinding", () => {
  test("uses the real Agents Runner and AI SDK bridge for a strict DeepSeek tool call", async () => {
    const requests: CapturedRequest[] = [];
    const responses = [toolCallResponse(), finalTextResponse()];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: requestUrl(input),
        body: parseJsonBody(init?.body),
      });

      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected extra DeepSeek request");
      }

      return Response.json(response);
    };
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
      status: "accepted",
      executionMode: "async",
      agentCallId: "agent-call-deepseek",
      taskId: "a2a-task-deepseek",
      state: "submitted",
    }));
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => {
        throw new Error("Unexpected task continuation in this test");
      },
    );
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage("session-deepseek-bridge", {
      messageId: "message-deepseek-bridge",
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
    });
    const onebotTools = createOneBot11OperationTools({
      sessions,
      resolveOperations: () =>
        ({ standard: {}, privileged: {} }) as unknown as OneBot11Operations,
      isRouteAllowed: () => true,
      sessionIdForRoute: () => "session-deepseek-bridge",
      runOutbound: async (_route, operation) => await operation(),
      runOperation: async (_channelId, operation) => await operation(),
    });
    const fakeAdapter = { send: vi.fn() } as unknown as ChannelAdapter;
    const modelBinding = createDeepSeekMainAgentModelBinding({
      config: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/beta",
        apiKey: "test-api-key",
      },
      fetch: fakeFetch,
    });
    const runtime = createPhase3MainAgentRuntime({
      agentCallInvoker: { invoke },
      taskStatusReader: {
        getStatus: (_sessionId, taskId) => ({ status: "not-found", taskId }),
      },
      agentCallContinuator: { continueTask },
      modelBinding,
      channelReply: {
        sessions,
        resolveAdapter: () => fakeAdapter,
      },
      additionalTools: [onebotTools.standard],
    });

    const result = await runtime.run({
      runId: "run-deepseek-bridge",
      sessionId: "session-deepseek-bridge",
      trigger: "user",
      input: "Ask Codex to add one focused validation.",
    });

    expect(result.output).toBe("Codex task accepted through DeepSeek.");
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-deepseek-bridge",
      sessionId: "session-deepseek-bridge",
      contextId: "session-deepseek-bridge",
      skillId: "codex-code-task",
      input: "add one focused validation",
      executionMode: "async",
      toolName: "submit_codex_agent_call",
      sourceToolCallId: "call-submit-codex",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://api.deepseek.com/beta/chat/completions",
    );
    expect(requests[0]?.body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    const requestTools = requests[0]?.body.tools;
    expect(
      findFunctionTool(requestTools, "submit_codex_agent_call"),
    ).toMatchObject({
      type: "function",
      function: { strict: true },
    });
    expect(findFunctionTool(requestTools, "get_task_status")).toMatchObject({
      type: "function",
      function: { strict: true },
    });
    expect(
      findFunctionTool(requestTools, CONTINUE_TASK_TOOL_NAME),
    ).toMatchObject({
      type: "function",
      function: { strict: true },
    });
    expect(findFunctionTool(requestTools, "reply")).toMatchObject({
      type: "function",
      function: { strict: true },
    });
    expect(findFunctionTool(requestTools, "onebot_standard")).toMatchObject({
      type: "function",
      function: { strict: true },
    });
    expect(containsEmptyObjectSchema(requestTools)).toBe(false);
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function parseJsonBody(body: RequestInit["body"]): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Expected DeepSeek request body to be JSON text");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function findFunctionTool(
  tools: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools.find((candidate): candidate is Record<string, unknown> => {
    if (candidate === null || typeof candidate !== "object") {
      return false;
    }
    const functionDefinition = (candidate as Record<string, unknown>).function;
    return (
      functionDefinition !== null &&
      typeof functionDefinition === "object" &&
      (functionDefinition as Record<string, unknown>).name === name
    );
  });
}

function containsEmptyObjectSchema(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(containsEmptyObjectSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return false;
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (
    record.type === "object" &&
    (properties === undefined ||
      properties === null ||
      typeof properties !== "object" ||
      Object.keys(properties).length === 0)
  ) {
    return true;
  }
  return Object.values(record).some(containsEmptyObjectSchema);
}

function toolCallResponse() {
  return {
    id: "chatcmpl-deepseek-tool-call",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-submit-codex",
              type: "function",
              function: {
                name: "submit_codex_agent_call",
                arguments: JSON.stringify({
                  task: "add one focused validation",
                  executionMode: "async",
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function finalTextResponse() {
  return {
    id: "chatcmpl-deepseek-final-text",
    created: 2,
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Codex task accepted through DeepSeek.",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
    },
  };
}
