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
  ToolTimeoutError,
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
import { MutatingRuntimeLogger } from "./support/mutating-runtime-logger.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

const delegatedTask = "add one focused validation and test it";

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
              task: delegatedTask,
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
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
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
      input: delegatedTask,
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
    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "main_agent.tool.started",
        fields: {
          runId: "run-tool-01",
          sessionId: "session-tool-01",
          toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          executionMode: scenario.expectedMode,
          inputLength: delegatedTask.length
        }
      },
      {
        level: "debug",
        message: "main_agent.tool.started",
        fields: {
          runId: "run-tool-01",
          sessionId: "session-tool-01",
          toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          executionMode: scenario.expectedMode,
          inputLength: delegatedTask.length,
          task: delegatedTask
        }
      },
      {
        level: "info",
        message: "main_agent.tool.completed",
        fields: {
          runId: "run-tool-01",
          sessionId: "session-tool-01",
          toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          status: scenario.invocationResult.status,
          executionMode: scenario.invocationResult.executionMode,
          agentCallId: scenario.invocationResult.agentCallId,
          a2aTaskId: scenario.invocationResult.taskId,
          state: scenario.invocationResult.state
        }
      }
    ]);
  });

  test.each([
    {
      name: "child binding",
      createLogger: () =>
        new ThrowingRuntimeLogger({ throwOnChild: true })
    },
    {
      name: "started info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.started"
        })
    },
    {
      name: "started debug logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "debug" && message === "main_agent.tool.started"
        })
    },
    {
      name: "completed info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.completed"
        })
    }
  ])(
    "does not change a successful submission when the logger fails during $name",
    async ({ createLogger }) => {
      const invocationResult: AgentCallInvocationResult = {
        status: "accepted",
        executionMode: "async",
        agentCallId: "agent-call-log-failure-safe",
        taskId: "a2a-task-log-failure-safe",
        state: "submitted"
      };
      const invoke = vi.fn<AgentCallInvoker["invoke"]>(
        async () => invocationResult
      );
      const tool = createCodexAgentCallTool({
        invoker: { invoke },
        logger: createLogger()
      });
      const context = new RunContext<OpenAiAgentsRunContext>({
        runId: "run-tool-logger-failure",
        sessionId: "session-tool-logger-failure",
        trigger: "user"
      });

      const output = await tool.invoke(
        context,
        JSON.stringify({ task: delegatedTask, executionMode: "async" })
      );

      expect(output).toBe(JSON.stringify(invocationResult));
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  );

  test("logs a failed submission without changing the tool error result", async () => {
    const originalMessage = "AgentCall submission failed";
    const failure = new Error(originalMessage);
    const logger = new MutatingRuntimeLogger(({ fields }) => {
      if (fields.error instanceof Error) {
        fields.error.message = "logger-mutated-error";
      }
    });
    const tool = createCodexAgentCallTool({
      invoker: {
        invoke: vi.fn(async () => {
          throw failure;
        })
      },
      logger
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-failure",
      sessionId: "session-tool-failure",
      trigger: "user"
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ task: delegatedTask, executionMode: "async" })
    );

    expect(String(output)).toContain(originalMessage);
    expect(failure.message).toBe(originalMessage);
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "main_agent.tool.failed",
      fields: {
        runId: "run-tool-failure",
        sessionId: "session-tool-failure",
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
        executionMode: "async",
        inputLength: delegatedTask.length,
        errorType: "Error"
      }
    });
    expect(logger.entries.at(-1)?.fields).not.toHaveProperty("error");
  });

  test("preserves the original submission error when failed logging throws", async () => {
    const businessFailure = new Error("Original AgentCall submission failure");
    const loggerFailure = new Error("Runtime logger error failure");
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => {
      throw businessFailure;
    });
    const tool = createCodexAgentCallTool({
      invoker: { invoke },
      logger: new ThrowingRuntimeLogger({
        failure: loggerFailure,
        throwWhen: ({ level }) => level === "error"
      })
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-original-error",
      sessionId: "session-tool-original-error",
      trigger: "user"
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
        timeoutMs: 1
      })
    );

    await expect(
      tool.invoke(
        context,
        JSON.stringify({ task: delegatedTask, executionMode: "async" }),
        { signal: timeoutController.signal }
      )
    ).rejects.toBe(businessFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
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
