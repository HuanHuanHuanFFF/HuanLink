import { describe, expect, test, vi } from "vitest";

import type { AgentCallContinuator, AgentCallInvoker } from "@huanlink/core";
import { CONTINUE_TASK_TOOL_NAME } from "@huanlink/integration-openai-agents";

import {
  createDeepSeekMainAgentModelBinding,
  createPhase3MainAgentRuntime
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
        body: parseJsonBody(init?.body)
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
      state: "submitted"
    }));
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => {
        throw new Error("Unexpected task continuation in this test");
      }
    );
    const modelBinding = createDeepSeekMainAgentModelBinding({
      config: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/beta",
        apiKey: "test-api-key"
      },
      fetch: fakeFetch
    });
    const runtime = createPhase3MainAgentRuntime({
      invoker: { invoke },
      taskReader: {
        getByAgentCallId: () => undefined,
        getByTaskId: () => undefined
      },
      taskContinuator: { continueTask },
      modelBinding
    });

    const result = await runtime.run({
      runId: "run-deepseek-bridge",
      sessionId: "session-deepseek-bridge",
      trigger: "user",
      input: "Ask Codex to add one focused validation."
    });

    expect(result.output).toBe("Codex task accepted through DeepSeek.");
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-deepseek-bridge",
      sessionId: "session-deepseek-bridge",
      contextId: "session-deepseek-bridge",
      skillId: "codex-code-task",
      input: "add one focused validation",
      executionMode: "async"
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://api.deepseek.com/beta/chat/completions"
    );
    expect(requests[0]?.body).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "submit_codex_agent_call",
            strict: true
          }
        },
        {
          type: "function",
          function: {
            name: "get_task_status",
            strict: true
          }
        },
        {
          type: "function",
          function: {
            name: CONTINUE_TASK_TOOL_NAME,
            strict: true
          }
        }
      ]
    });
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function parseJsonBody(
  body: RequestInit["body"]
): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Expected DeepSeek request body to be JSON text");
  }
  return JSON.parse(body) as Record<string, unknown>;
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
                  executionMode: "async"
                })
              }
            }
          ]
        },
        finish_reason: "tool_calls"
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    }
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
          content: "Codex task accepted through DeepSeek."
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27
    }
  };
}
