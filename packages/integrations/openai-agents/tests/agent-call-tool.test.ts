import { describe, expect, test, vi } from "vitest";

import type { AgentCallSubmitter } from "@huanlink/core";
import {
  Agent,
  Runner,
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent
} from "@openai/agents";

import {
  OpenAiAgentsRuntime,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
  createCodexAgentCallTool,
  type OpenAiAgentsRunContext
} from "../src/index.js";

class ToolCallingModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage(),
      output: [
        {
          type: "function_call",
          callId: "tool-call-01",
          name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          arguments: JSON.stringify({
            task: "add one focused validation and test it"
          })
        }
      ]
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class SingleModelProvider implements ModelProvider {
  constructor(private readonly model: Model) {}

  getModel(): Model {
    return this.model;
  }
}

describe("createCodexAgentCallTool", () => {
  test("lets a real Runner accept an async Codex AgentCall without waiting for completion", async () => {
    const submit = vi.fn<AgentCallSubmitter["submit"]>(async () => ({
      status: "accepted",
      agentCallId: "agent-call-tool-01",
      taskId: "a2a-task-tool-01",
      state: "submitted"
    }));
    const model = new ToolCallingModel();
    const tool = createCodexAgentCallTool({ submitter: { submit } });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "HuanLink MainAgent",
      instructions: "Delegate code changes to Codex when appropriate.",
      model: "mock-tool-model",
      tools: [tool],
      toolUseBehavior: {
        stopAtToolNames: [SUBMIT_CODEX_AGENT_CALL_TOOL_NAME]
      }
    });
    const runtime = new OpenAiAgentsRuntime({
      agent,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      })
    });

    const result = await runtime.run({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      input: "please ask Codex to make the change"
    });

    expect(JSON.parse(result.output)).toEqual({
      status: "accepted",
      agentCallId: "agent-call-tool-01",
      taskId: "a2a-task-tool-01",
      state: "submitted"
    });
    expect(submit).toHaveBeenCalledWith({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      contextId: "session-tool-01",
      skillId: "codex-code-task",
      input: "add one focused validation and test it"
    });
    expect(model.requests).toHaveLength(1);
  });
});
