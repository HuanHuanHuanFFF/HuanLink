import { describe, expect, test, vi } from "vitest";

import type {
  AgentCallInvocationResult,
  AgentCallInvoker,
  TaskExecutionMode
} from "@huanlink/core";
import {
  Agent,
  RunContext,
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

function assistantMessage(text: string): ModelResponse["output"][number] {
  return {
    id: "msg-agent-call-tool",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        providerData: { annotations: [] }
      }
    ]
  };
}

class ToolCallingThenReplyModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly executionMode?: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "tool-call-01",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "add one focused validation and test it",
              ...(this.executionMode === undefined
                ? {}
                : { executionMode: this.executionMode })
            })
          }
        ]
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("MainAgent continued after the AgentCall result.")]
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

type Scenario = {
  name: string;
  requestedMode?: TaskExecutionMode;
  expectedMode: TaskExecutionMode;
  invocationResult: AgentCallInvocationResult;
};

const scenarios: Scenario[] = [
  {
    name: "defaults to async and lets the Runner continue after acceptance",
    expectedMode: "async",
    invocationResult: {
      status: "accepted",
      executionMode: "async",
      agentCallId: "agent-call-tool-async",
      taskId: "a2a-task-tool-async",
      state: "submitted"
    }
  },
  {
    name: "passes an explicit blocking result back into the current Runner turn",
    requestedMode: "blocking",
    expectedMode: "blocking",
    invocationResult: {
      status: "result",
      executionMode: "blocking",
      agentCallId: "agent-call-tool-blocking",
      taskId: "a2a-task-tool-blocking",
      state: "completed",
      artifacts: [
        { id: "artifact-blocking", text: "blocking-mode result" }
      ]
    }
  }
];

describe("createCodexAgentCallTool", () => {
  test.each(scenarios)("$name", async (scenario) => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(
      async () => scenario.invocationResult
    );
    const model = new ToolCallingThenReplyModel(scenario.requestedMode);
    const tool = createCodexAgentCallTool({ invoker: { invoke } });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "HuanLink MainAgent",
      instructions: "Delegate code changes to Codex when appropriate.",
      model: "mock-tool-model",
      tools: [tool]
    });
    const runtime = new OpenAiAgentsRuntime({
      agent,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      })
    });
    const abortController = new AbortController();

    const result = await runtime.run({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      input: "please ask Codex to make the change",
      signal: abortController.signal
    });

    expect(result.output).toBe("MainAgent continued after the AgentCall result.");
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      contextId: "session-tool-01",
      skillId: "codex-code-task",
      input: "add one focused validation and test it",
      executionMode: scenario.expectedMode,
      signal: abortController.signal
    });
    expect(model.requests).toHaveLength(2);
    const continuationInput = JSON.stringify(model.requests[1]?.input);
    expect(continuationInput).toContain(
      `\\\"executionMode\\\":\\\"${scenario.expectedMode}\\\"`
    );
    expect(continuationInput).toContain(
      `\\\"status\\\":\\\"${scenario.invocationResult.status}\\\"`
    );
  });

  test.each(["background", "wait"] as const)(
    "rejects the legacy %s execution mode before invoking AgentCall",
    async (legacyMode) => {
      const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
        status: "accepted",
        executionMode: "async",
        agentCallId: "legacy-mode-should-not-be-invoked",
        taskId: "legacy-mode-should-not-be-submitted",
        state: "submitted"
      }));
      const model = new ToolCallingThenReplyModel(legacyMode);
      const tool = createCodexAgentCallTool({ invoker: { invoke } });
      const agent = new Agent<OpenAiAgentsRunContext>({
        name: "HuanLink MainAgent",
        instructions: "Delegate code changes to Codex when appropriate.",
        model: "mock-tool-model",
        tools: [tool]
      });
      const runtime = new OpenAiAgentsRuntime({
        agent,
        runner: new Runner({
          modelProvider: new SingleModelProvider(model),
          tracingDisabled: true
        })
      });

      await runtime.run({
        runId: `run-tool-legacy-${legacyMode}`,
        sessionId: "session-tool-legacy-mode",
        input: `try the legacy ${legacyMode} execution mode`
      });

      expect(invoke).not.toHaveBeenCalled();
      expect(model.requests).toHaveLength(2);
      const continuationInput = JSON.stringify(model.requests[1]?.input);
      expect(continuationInput).toContain("InvalidToolInputError");
      expect(continuationInput).toContain("Invalid JSON input for tool");
    }
  );

  test("is enabled only for user-triggered runs", async () => {
    const tool = createCodexAgentCallTool({
      invoker: {
        invoke: vi.fn(async () => ({
          status: "accepted" as const,
          executionMode: "async" as const,
          agentCallId: "unused-agent-call",
          taskId: "unused-a2a-task",
          state: "submitted" as const
        }))
      }
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Tool availability",
      instructions: "Test tool availability.",
      model: "unused-model"
    });
    const isEnabled = (trigger: OpenAiAgentsRunContext["trigger"]) =>
      tool.isEnabled(
        new RunContext<OpenAiAgentsRunContext>({
          runId: "run-tool-availability",
          sessionId: "session-tool-availability",
          trigger
        }),
        agent
      );

    await expect(isEnabled("user")).resolves.toBe(true);
    await expect(isEnabled("agent_call_input_required")).resolves.toBe(false);
    await expect(isEnabled("agent_call_terminal")).resolves.toBe(false);
  });
});
