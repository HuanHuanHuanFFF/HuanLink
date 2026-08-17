import { describe, expect, test, vi } from "vitest";

import type {
  AgentCallInvocationResult,
  AgentCallInvoker,
  TaskExecutionMode,
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
  type StreamEvent,
} from "@openai/agents";

import {
  OpenAiAgentsRuntime,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
  createCodexAgentCallTool,
  type OpenAiAgentsRunContext,
} from "../src/index.js";
import { MutatingRuntimeLogger } from "./support/mutating-runtime-logger.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

const delegatedTask = "add one focused validation and test it";

function toolCallDetails(
  callId: string,
  argumentsJson: string,
  signal?: AbortSignal,
) {
  return {
    toolCall: {
      type: "function_call" as const,
      callId,
      name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      arguments: argumentsJson,
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

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
        providerData: { annotations: [] },
      },
    ],
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
                : { executionMode: this.executionMode }),
            }),
          },
        ],
      };
    }

    return {
      usage: new Usage(),
      output: [
        assistantMessage("MainAgent continued after the AgentCall result."),
      ],
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
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
      taskId: "huanlink-task-tool-async",
      state: "submitted",
    },
  },
  {
    name: "passes an explicit blocking result back into the current Runner turn",
    requestedMode: "blocking",
    expectedMode: "blocking",
    invocationResult: {
      status: "result",
      executionMode: "blocking",
      state: "completed",
      artifacts: [{ id: "artifact-blocking", text: "blocking-mode result" }],
      agentCallId: "must-not-leak",
      taskId: "must-not-leak",
      a2aTaskId: "must-not-leak",
    } as unknown as AgentCallInvocationResult,
  },
  {
    name: "returns a stable interruption when blocking needs more input",
    requestedMode: "blocking",
    expectedMode: "blocking",
    invocationResult: {
      status: "blocking-interrupted",
      executionMode: "blocking",
      state: "input-required",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope should Codex use?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      agentCallId: "must-not-leak",
      taskId: "must-not-leak",
      a2aTaskId: "must-not-leak",
    } as unknown as AgentCallInvocationResult,
  },
];

describe("createCodexAgentCallTool", () => {
  test("does not submit an async task without the SDK Tool Call ID", async () => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
      status: "accepted",
      taskId: "must-not-be-created",
      state: "submitted",
    }));
    const tool = createCodexAgentCallTool({ invoker: { invoke } });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-missing-call-id",
      sessionId: "session-tool-missing-call-id",
      trigger: "user",
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ task: delegatedTask, executionMode: "async" }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(String(output)).toContain("SDK Tool Call ID");
  });

  test("returns only the HuanLink task receipt for an async submission", async () => {
    const invoke = vi.fn(async () => ({
      status: "accepted" as const,
      taskId: "huanlink-task-async",
      state: "submitted" as const,
      agentCallId: "must-not-leak",
      a2aTaskId: "must-not-leak",
      executionMode: "async",
    }));
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({
      invoker: { invoke } as AgentCallInvoker,
      logger,
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-public-receipt",
      sessionId: "session-tool-public-receipt",
      trigger: "user",
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ task: delegatedTask, executionMode: "async" }),
      toolCallDetails(
        "tool-call-public-receipt",
        JSON.stringify({ task: delegatedTask, executionMode: "async" }),
      ),
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "accepted",
      taskId: "huanlink-task-async",
      state: "submitted",
    });
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-tool-public-receipt",
      sessionId: "session-tool-public-receipt",
      contextId: "session-tool-public-receipt",
      skillId: "codex-code-task",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      input: delegatedTask,
      executionMode: "async",
      sourceToolCallId: "tool-call-public-receipt",
    });
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-tool-public-receipt",
      sessionId: "session-tool-public-receipt",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      status: "accepted",
      taskId: "huanlink-task-async",
      state: "submitted",
    });
  });

  test("preserves the accepted Task persistence warning in the public async receipt", async () => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(
      async () =>
        ({
          status: "accepted",
          taskId: "huanlink-task-persistence-warning",
          state: "unknown",
          retrySafe: false,
          persistenceWarning: "task-state-not-persisted",
          agentCallId: "must-not-leak",
          a2aTaskId: "must-not-leak",
        }) as unknown as AgentCallInvocationResult,
    );
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-persistence-warning",
      sessionId: "session-tool-persistence-warning",
      trigger: "user",
    });
    const argumentsJson = JSON.stringify({
      task: delegatedTask,
      executionMode: "async",
    });

    const output = await tool.invoke(
      context,
      argumentsJson,
      toolCallDetails("tool-call-persistence-warning", argumentsJson),
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "accepted",
      taskId: "huanlink-task-persistence-warning",
      state: "unknown",
      retrySafe: false,
      persistenceWarning: "task-state-not-persisted",
    });
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-tool-persistence-warning",
      sessionId: "session-tool-persistence-warning",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      status: "accepted",
      taskId: "huanlink-task-persistence-warning",
      state: "unknown",
      retrySafe: false,
      persistenceWarning: "task-state-not-persisted",
    });
  });

  test("returns a queryable HuanLink task when blocking dispatch becomes uncertain", async () => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
      status: "blocking-uncertain",
      executionMode: "blocking",
      taskId: "huanlink-task-blocking-uncertain",
      state: "unknown",
      retrySafe: false,
    }));
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-blocking-uncertain",
      sessionId: "session-tool-blocking-uncertain",
      trigger: "user",
    });
    const argumentsJson = JSON.stringify({
      task: delegatedTask,
      executionMode: "blocking",
    });

    const output = await tool.invoke(
      context,
      argumentsJson,
      toolCallDetails("tool-call-blocking-uncertain", argumentsJson),
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "blocking-uncertain",
      executionMode: "blocking",
      taskId: "huanlink-task-blocking-uncertain",
      state: "unknown",
      retrySafe: false,
    });
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-tool-blocking-uncertain",
      sessionId: "session-tool-blocking-uncertain",
      contextId: "session-tool-blocking-uncertain",
      skillId: "codex-code-task",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      input: delegatedTask,
      executionMode: "blocking",
      sourceToolCallId: "tool-call-blocking-uncertain",
    });
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-tool-blocking-uncertain",
      sessionId: "session-tool-blocking-uncertain",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      status: "blocking-uncertain",
      executionMode: "blocking",
      state: "unknown",
    });
  });

  test("returns a structured task limit error as a normal Tool Result", async () => {
    const limitResult = {
      status: "error" as const,
      error: "task-limit-reached" as const,
      maxActiveTasksPerSession: 2,
    };
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(
      async () => limitResult as unknown as AgentCallInvocationResult,
    );
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-limit",
      sessionId: "session-tool-limit",
      trigger: "user",
    });
    const argumentsJson = JSON.stringify({
      task: delegatedTask,
      executionMode: "async",
    });

    const output = await tool.invoke(
      context,
      argumentsJson,
      toolCallDetails("tool-call-limit", argumentsJson),
    );

    expect(JSON.parse(String(output))).toEqual(limitResult);
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-tool-limit",
      sessionId: "session-tool-limit",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      status: "error",
      error: "task-limit-reached",
      maxActiveTasksPerSession: 2,
    });
  });

  test("returns a pre-accept rejection as a normal Tool Result", async () => {
    const rejectedResult = {
      status: "error" as const,
      error: "task-preaccept-rejected" as const,
    };
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(
      async () => rejectedResult as unknown as AgentCallInvocationResult,
    );
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-preaccept-rejected",
      sessionId: "session-tool-preaccept-rejected",
      trigger: "user",
    });
    const argumentsJson = JSON.stringify({
      task: delegatedTask,
      executionMode: "async",
    });

    const output = await tool.invoke(
      context,
      argumentsJson,
      toolCallDetails("tool-call-preaccept-rejected", argumentsJson),
    );

    expect(JSON.parse(String(output))).toEqual(rejectedResult);
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-tool-preaccept-rejected",
      sessionId: "session-tool-preaccept-rejected",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      status: "error",
      error: "task-preaccept-rejected",
    });
  });

  test.each(scenarios)("$name", async (scenario) => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(
      async () => scenario.invocationResult,
    );
    const model = new ToolCallingThenReplyModel(scenario.requestedMode);
    const logger = new RecordingRuntimeLogger();
    const tool = createCodexAgentCallTool({ invoker: { invoke }, logger });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "HuanLink MainAgent",
      instructions: "Delegate code changes to Codex when appropriate.",
      model: "mock-tool-model",
      tools: [tool],
    });
    const runtime = new OpenAiAgentsRuntime({
      agent,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
    });
    const abortController = new AbortController();

    const result = await runtime.run({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      input: "please ask Codex to make the change",
      signal: abortController.signal,
    });

    expect(result.output).toBe(
      "MainAgent continued after the AgentCall result.",
    );
    expect(invoke).toHaveBeenCalledWith({
      runId: "run-tool-01",
      sessionId: "session-tool-01",
      contextId: "session-tool-01",
      skillId: "codex-code-task",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      input: delegatedTask,
      executionMode: scenario.expectedMode,
      sourceToolCallId: "tool-call-01",
      signal: abortController.signal,
    });
    expect(model.requests).toHaveLength(2);
    const continuationInput = JSON.stringify(model.requests[1]?.input);
    expect(continuationInput).toContain(
      `\\\"status\\\":\\\"${scenario.invocationResult.status}\\\"`,
    );
    expect(continuationInput).not.toContain("agentCallId");
    expect(continuationInput).not.toContain("a2aTaskId");
    if (scenario.invocationResult.status !== "accepted") {
      expect(continuationInput).not.toContain("taskId");
    }
    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "main_agent.tool.started",
        fields: {
          runId: "run-tool-01",
          sessionId: "session-tool-01",
          toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          executionMode: scenario.expectedMode,
          inputLength: delegatedTask.length,
        },
      },
      {
        level: "info",
        message: "main_agent.tool.completed",
        fields:
          scenario.invocationResult.status === "accepted"
            ? {
                runId: "run-tool-01",
                sessionId: "session-tool-01",
                toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
                status: "accepted",
                taskId: scenario.invocationResult.taskId,
                state: scenario.invocationResult.state,
              }
            : scenario.invocationResult.status === "error"
              ? scenario.invocationResult.error === "task-limit-reached"
                ? {
                    runId: "run-tool-01",
                    sessionId: "session-tool-01",
                    toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
                    status: "error",
                    error: "task-limit-reached",
                    maxActiveTasksPerSession:
                      scenario.invocationResult.maxActiveTasksPerSession,
                  }
                : {
                    runId: "run-tool-01",
                    sessionId: "session-tool-01",
                    toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
                    status: "error",
                    error: "task-preaccept-rejected",
                  }
              : {
                  runId: "run-tool-01",
                  sessionId: "session-tool-01",
                  toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
                  status: scenario.invocationResult.status,
                  executionMode: "blocking",
                  state: scenario.invocationResult.state,
                },
      },
    ]);
  });

  test.each([
    {
      name: "child binding",
      createLogger: () => new ThrowingRuntimeLogger({ throwOnChild: true }),
    },
    {
      name: "started info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.started",
        }),
    },
    {
      name: "completed info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.completed",
        }),
    },
  ])(
    "does not change a successful submission when the logger fails during $name",
    async ({ createLogger }) => {
      const invocationResult: AgentCallInvocationResult = {
        status: "accepted",
        taskId: "huanlink-task-log-failure-safe",
        state: "submitted",
      };
      const invoke = vi.fn<AgentCallInvoker["invoke"]>(
        async () => invocationResult,
      );
      const tool = createCodexAgentCallTool({
        invoker: { invoke },
        logger: createLogger(),
      });
      const context = new RunContext<OpenAiAgentsRunContext>({
        runId: "run-tool-logger-failure",
        sessionId: "session-tool-logger-failure",
        trigger: "user",
      });

      const output = await tool.invoke(
        context,
        JSON.stringify({ task: delegatedTask, executionMode: "async" }),
        toolCallDetails(
          "tool-call-logger-failure",
          JSON.stringify({ task: delegatedTask, executionMode: "async" }),
        ),
      );

      expect(output).toBe(JSON.stringify(invocationResult));
      expect(invoke).toHaveBeenCalledTimes(1);
    },
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
        }),
      },
      logger,
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-failure",
      sessionId: "session-tool-failure",
      trigger: "user",
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ task: delegatedTask, executionMode: "async" }),
      toolCallDetails(
        "tool-call-business-failure",
        JSON.stringify({ task: delegatedTask, executionMode: "async" }),
      ),
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
        errorType: "Error",
      },
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
        throwWhen: ({ level }) => level === "error",
      }),
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-tool-original-error",
      sessionId: "session-tool-original-error",
      trigger: "user",
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
        timeoutMs: 1,
      }),
    );

    await expect(
      tool.invoke(
        context,
        JSON.stringify({ task: delegatedTask, executionMode: "async" }),
        toolCallDetails(
          "tool-call-original-error",
          JSON.stringify({ task: delegatedTask, executionMode: "async" }),
          timeoutController.signal,
        ),
      ),
    ).rejects.toBe(businessFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test.each(["background", "wait"] as const)(
    "rejects the legacy %s execution mode before invoking AgentCall",
    async (legacyMode) => {
      const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
        status: "accepted",
        taskId: "legacy-mode-should-not-be-submitted",
        state: "submitted",
      }));
      const model = new ToolCallingThenReplyModel(legacyMode);
      const tool = createCodexAgentCallTool({ invoker: { invoke } });
      const agent = new Agent<OpenAiAgentsRunContext>({
        name: "HuanLink MainAgent",
        instructions: "Delegate code changes to Codex when appropriate.",
        model: "mock-tool-model",
        tools: [tool],
      });
      const runtime = new OpenAiAgentsRuntime({
        agent,
        runner: new Runner({
          modelProvider: new SingleModelProvider(model),
          tracingDisabled: true,
        }),
      });

      await runtime.run({
        runId: `run-tool-legacy-${legacyMode}`,
        sessionId: "session-tool-legacy-mode",
        input: `try the legacy ${legacyMode} execution mode`,
      });

      expect(invoke).not.toHaveBeenCalled();
      expect(model.requests).toHaveLength(2);
      const continuationInput = JSON.stringify(model.requests[1]?.input);
      expect(continuationInput).toContain("InvalidToolInputError");
      expect(continuationInput).toContain("Invalid JSON input for tool");
    },
  );

  test("is enabled for user and terminal re-entry runs", async () => {
    const tool = createCodexAgentCallTool({
      invoker: {
        invoke: vi.fn(async () => ({
          status: "accepted" as const,
          taskId: "unused-huanlink-task",
          state: "submitted" as const,
        })),
      },
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Tool availability",
      instructions: "Test tool availability.",
      model: "unused-model",
    });
    const isEnabled = (trigger: OpenAiAgentsRunContext["trigger"]) =>
      tool.isEnabled(
        new RunContext<OpenAiAgentsRunContext>({
          runId: "run-tool-availability",
          sessionId: "session-tool-availability",
          trigger,
        }),
        agent,
      );

    await expect(isEnabled("user")).resolves.toBe(true);
    await expect(isEnabled("agent_call_input_required")).resolves.toBe(false);
    await expect(isEnabled("agent_call_terminal")).resolves.toBe(true);
  });

  test("forces terminal re-entry submissions to stay asynchronous", async () => {
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
      status: "accepted" as const,
      taskId: "terminal-follow-up-huanlink-task",
      state: "submitted" as const,
    }));
    const tool = createCodexAgentCallTool({ invoker: { invoke } });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-terminal-follow-up",
      sessionId: "session-terminal-follow-up",
      trigger: "agent_call_terminal",
    });

    await tool.invoke(
      context,
      JSON.stringify({
        task: "run the already authorized follow-up",
        executionMode: "blocking",
      }),
      toolCallDetails(
        "tool-call-terminal-follow-up",
        JSON.stringify({
          task: "run the already authorized follow-up",
          executionMode: "blocking",
        }),
      ),
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "async" }),
    );
  });
});
