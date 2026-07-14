import { describe, expect, test, vi } from "vitest";

import type { AgentCallReader, AgentCallRecord } from "@huanlink/core";
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
  GET_TASK_STATUS_TOOL_NAME,
  OpenAiAgentsRuntime,
  createTaskStatusTool,
  type OpenAiAgentsRunContext
} from "../src/index.js";
import { MutatingRuntimeLogger } from "./support/mutating-runtime-logger.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

const record: AgentCallRecord = {
  agentCallId: "huanlink-task-01",
  taskId: "a2a-task-01",
  contextId: "session-current",
  runId: "run-submission",
  sessionId: "session-current",
  skillId: "codex-code-task",
  capabilityName: "Codex code task",
  input: "make one focused change",
  executionMode: "async",
  state: "working",
  artifacts: [{ id: "artifact-01", text: "partial result" }],
  statusMessage: "Codex is working",
  createdAt: "2026-07-13T01:02:03.000Z",
  updatedAt: "2026-07-13T01:03:04.000Z"
};

function assistantMessage(text: string): ModelResponse["output"][number] {
  return {
    id: "msg-task-status-tool",
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

class TaskStatusCallingThenReplyModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly taskId: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "task-status-tool-call",
            name: GET_TASK_STATUS_TOOL_NAME,
            arguments: JSON.stringify({ taskId: this.taskId })
          }
        ]
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("Task status received.")]
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

type ReaderScenario = {
  byAgentCallId?: AgentCallRecord;
  byTaskId?: AgentCallRecord;
};

async function queryStatus(
  taskId: string,
  sessionId: string,
  scenario: ReaderScenario
) {
  const logger = new RecordingRuntimeLogger();
  const invoke = vi.fn();
  const submit = vi.fn();
  const getByAgentCallId = vi.fn<AgentCallReader["getByAgentCallId"]>(
    () => scenario.byAgentCallId
  );
  const getByTaskId = vi.fn<AgentCallReader["getByTaskId"]>(
    () => scenario.byTaskId
  );
  const reader = {
    getByAgentCallId,
    getByTaskId,
    invoke,
    submit
  };
  const model = new TaskStatusCallingThenReplyModel(taskId);
  const agent = new Agent<OpenAiAgentsRunContext>({
    name: "HuanLink MainAgent",
    instructions: "Read existing task status without creating work.",
    model: "mock-task-status-model",
    tools: [createTaskStatusTool({ reader, logger })]
  });
  const runtime = new OpenAiAgentsRuntime({
    agent,
    runner: new Runner({
      modelProvider: new SingleModelProvider(model),
      tracingDisabled: true
    })
  });

  await runtime.run({
    runId: "run-status-query",
    sessionId,
    input: `report task ${taskId}`
  });

  const continuationInput = model.requests[1]?.input;
  if (continuationInput === undefined || typeof continuationInput === "string") {
    throw new Error("Expected a task-status tool continuation request");
  }
  const resultItem = continuationInput.find(
    (item) => item.type === "function_call_result"
  );
  if (
    resultItem === undefined ||
    resultItem.name !== GET_TASK_STATUS_TOOL_NAME
  ) {
    throw new Error("Expected a task-status function result");
  }
  const output = resultItem.output;
  const text =
    typeof output === "string"
      ? output
      : !Array.isArray(output) && output.type === "text"
        ? output.text
        : undefined;
  if (text === undefined) {
    throw new Error("Expected text output from get_task_status");
  }

  return {
    result: JSON.parse(text) as unknown,
    getByAgentCallId,
    getByTaskId,
    invoke,
    submit,
    logger
  };
}

describe("createTaskStatusTool", () => {
  test.each([
    {
      name: "canonical HuanLink task ID",
      query: record.agentCallId,
      scenario: { byAgentCallId: record }
    },
    {
      name: "external A2A task ID",
      query: record.taskId,
      scenario: { byTaskId: record }
    }
  ])("returns a current-session record by $name", async ({ query, scenario }) => {
    const observed = await queryStatus(query, "session-current", scenario);

    expect(observed.result).toEqual({
      status: "found",
      task: {
        taskId: "huanlink-task-01",
        a2aTaskId: "a2a-task-01",
        state: "working",
        executionMode: "async",
        createdAt: "2026-07-13T01:02:03.000Z",
        updatedAt: "2026-07-13T01:03:04.000Z",
        statusMessage: "Codex is working",
        artifacts: [{ id: "artifact-01", text: "partial result" }]
      }
    });
    expect(observed.invoke).not.toHaveBeenCalled();
    expect(observed.submit).not.toHaveBeenCalled();
    expect(observed.logger.entries).toContainEqual({
      level: "info",
      message: "main_agent.tool.started",
      fields: {
        runId: "run-status-query",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: query
      }
    });
    expect(observed.logger.entries).toContainEqual({
      level: "info",
      message: "main_agent.tool.completed",
      fields: {
        runId: "run-status-query",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: query,
        resolutionStatus: "found",
        agentCallId: record.agentCallId,
        a2aTaskId: record.taskId,
        state: record.state
      }
    });
    expect(observed.logger.entries).toContainEqual({
      level: "debug",
      message: "main_agent.tool.completed",
      fields: {
        runId: "run-status-query",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: query,
        resolutionStatus: "found",
        agentCallId: record.agentCallId,
        a2aTaskId: record.taskId,
        state: record.state,
        result: observed.result
      }
    });
  });

  test("redacts secret question details from debug logs while returning the full status", async () => {
    const publicQuestion = {
      id: "scope",
      header: "Scope",
      question: "Choose the implementation scope.",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Adapter", description: "Only change the adapter." }
      ]
    };
    const secretQuestion = {
      id: "credential",
      header: "Secret credential header",
      question: "Secret credential question",
      isOther: false,
      isSecret: true,
      options: [
        {
          label: "Secret credential option",
          description: "Secret credential option description"
        }
      ]
    };
    const observed = await queryStatus(record.agentCallId, "session-current", {
      byAgentCallId: {
        ...record,
        questions: [publicQuestion, secretQuestion]
      }
    });

    expect(observed.result).toMatchObject({
      status: "found",
      task: { questions: [publicQuestion, secretQuestion] }
    });
    const debugEntry = observed.logger.entries.find(
      ({ level, message, fields }) =>
        level === "debug" &&
        message === "main_agent.tool.completed" &&
        fields.resolutionStatus === "found"
    );
    const serializedDebug = JSON.stringify(debugEntry);
    for (const secret of [
      secretQuestion.header,
      secretQuestion.question,
      secretQuestion.options[0]!.label,
      secretQuestion.options[0]!.description
    ]) {
      expect(serializedDebug).not.toContain(secret);
    }
    const loggedQuestions = (
      debugEntry?.fields.result as {
        task?: { questions?: Array<Record<string, unknown>> };
      }
    )?.task?.questions;
    expect(loggedQuestions?.[0]).toEqual(publicQuestion);
    expect(loggedQuestions?.[1]).toEqual({
      id: "credential",
      isOther: false,
      isSecret: true
    });
  });

  test("does not let a mutating debug logger alter the returned task status", async () => {
    const question = {
      id: "scope",
      header: "Scope",
      question: "Choose scope.",
      isOther: false,
      isSecret: false,
      options: [{ label: "Adapter", description: "Adapter only." }]
    };
    const logger = new MutatingRuntimeLogger(({ level, message, fields }) => {
      if (level !== "debug" || message !== "main_agent.tool.completed") {
        return;
      }
      const loggedResult = fields.result as {
        task?: {
          state?: string;
          artifacts?: Array<{ text?: string }>;
          questions?: Array<{ question?: string }>;
        };
      };
      if (loggedResult.task === undefined) {
        return;
      }
      loggedResult.task.state = "logger-mutated-state";
      if (loggedResult.task.artifacts?.[0] !== undefined) {
        loggedResult.task.artifacts[0].text = "logger-mutated-artifact";
      }
      if (loggedResult.task.questions?.[0] !== undefined) {
        loggedResult.task.questions[0].question = "logger-mutated-question";
      }
    });
    const tool = createTaskStatusTool({
      reader: {
        getByAgentCallId: () => ({ ...record, questions: [question] }),
        getByTaskId: () => undefined
      },
      logger
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-status-mutation",
      sessionId: "session-current",
      trigger: "user"
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ taskId: record.agentCallId })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "found",
      task: {
        state: "working",
        artifacts: [{ text: "partial result" }],
        questions: [question]
      }
    });
    expect(JSON.stringify(logger.entries)).toContain("logger-mutated-question");
  });

  test("returns the current-session A2A candidate when another session owns the colliding canonical ID", async () => {
    const query = "shared-task-id";
    const currentSessionRecord: AgentCallRecord = {
      ...record,
      agentCallId: "huanlink-current",
      taskId: query
    };
    const otherSessionRecord: AgentCallRecord = {
      ...record,
      agentCallId: query,
      taskId: "a2a-other",
      sessionId: "session-other"
    };

    const observed = await queryStatus(query, "session-current", {
      byAgentCallId: otherSessionRecord,
      byTaskId: currentSessionRecord
    });

    expect(observed.result).toMatchObject({
      status: "found",
      task: {
        taskId: "huanlink-current",
        a2aTaskId: query
      }
    });
  });

  test("returns ambiguous when both ID namespaces resolve to different records in the current session", async () => {
    const query = "ambiguous-task-id";
    const canonicalCandidate: AgentCallRecord = {
      ...record,
      agentCallId: query,
      taskId: "a2a-canonical-candidate"
    };
    const externalCandidate: AgentCallRecord = {
      ...record,
      agentCallId: "huanlink-external-candidate",
      taskId: query
    };

    const observed = await queryStatus(query, "session-current", {
      byAgentCallId: canonicalCandidate,
      byTaskId: externalCandidate
    });

    expect(observed.result).toEqual({ status: "ambiguous", taskId: query });
    expect(observed.invoke).not.toHaveBeenCalled();
    expect(observed.submit).not.toHaveBeenCalled();
    expect(observed.logger.entries).toContainEqual({
      level: "info",
      message: "main_agent.tool.completed",
      fields: {
        runId: "run-status-query",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: query,
        resolutionStatus: "ambiguous"
      }
    });
  });

  test("deduplicates the same current-session record returned by both ID namespaces", async () => {
    const observed = await queryStatus(record.agentCallId, "session-current", {
      byAgentCallId: record,
      byTaskId: { ...record }
    });

    expect(observed.result).toMatchObject({
      status: "found",
      task: {
        taskId: record.agentCallId,
        a2aTaskId: record.taskId
      }
    });
  });

  test("returns a terminal notification error under the public notificationError field", async () => {
    const observed = await queryStatus(record.agentCallId, "session-current", {
      byAgentCallId: {
        ...record,
        terminalNotificationError: "Failed to deliver the terminal update"
      }
    });

    expect(observed.result).toMatchObject({
      status: "found",
      task: {
        notificationError: "Failed to deliver the terminal update"
      }
    });
  });

  test("returns structured questions for an input-required task", async () => {
    const observed = await queryStatus(record.agentCallId, "session-current", {
      byAgentCallId: {
        ...record,
        state: "input-required",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which files may be changed?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Adapter only",
                description: "Limit changes to the adapter."
              }
            ]
          }
        ]
      }
    });

    expect(observed.result).toMatchObject({
      status: "found",
      task: {
        state: "input-required",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which files may be changed?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Adapter only",
                description: "Limit changes to the adapter."
              }
            ]
          }
        ]
      }
    });
  });

  test.each([
    {
      name: "an unknown ID",
      query: "unknown-task",
      scenario: {}
    },
    {
      name: "a canonical ID owned by another session",
      query: record.agentCallId,
      scenario: {
        byAgentCallId: { ...record, sessionId: "session-other" }
      }
    },
    {
      name: "an external ID owned by another session",
      query: record.taskId,
      scenario: {
        byTaskId: { ...record, sessionId: "session-other" }
      }
    }
  ])("returns the same not-found shape for $name", async ({ query, scenario }) => {
    const observed = await queryStatus(query, "session-current", scenario);

    expect(observed.result).toEqual({ status: "not-found", taskId: query });
    expect(observed.invoke).not.toHaveBeenCalled();
    expect(observed.submit).not.toHaveBeenCalled();
    expect(observed.logger.entries).toContainEqual({
      level: "info",
      message: "main_agent.tool.completed",
      fields: {
        runId: "run-status-query",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: query,
        resolutionStatus: "not-found"
      }
    });
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
      name: "completed info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.completed"
        })
    },
    {
      name: "completed debug logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "debug" && message === "main_agent.tool.completed"
        })
    }
  ])(
    "does not change a found result when the logger fails during $name",
    async ({ createLogger }) => {
      const getByAgentCallId = vi.fn<AgentCallReader["getByAgentCallId"]>(
        () => record
      );
      const getByTaskId = vi.fn<AgentCallReader["getByTaskId"]>(
        () => undefined
      );
      const tool = createTaskStatusTool({
        reader: { getByAgentCallId, getByTaskId },
        logger: createLogger()
      });
      const context = new RunContext<OpenAiAgentsRunContext>({
        runId: "run-status-logger-failure",
        sessionId: "session-current",
        trigger: "user"
      });

      const output = await tool.invoke(
        context,
        JSON.stringify({ taskId: record.agentCallId })
      );

      expect(JSON.parse(String(output))).toMatchObject({
        status: "found",
        task: {
          taskId: record.agentCallId,
          a2aTaskId: record.taskId,
          state: record.state
        }
      });
      expect(getByAgentCallId).toHaveBeenCalledTimes(1);
      expect(getByTaskId).toHaveBeenCalledTimes(1);
    }
  );

  test("logs a failed status lookup without changing the tool error result", async () => {
    const originalMessage = "Task reader failed";
    const failure = new Error(originalMessage);
    const logger = new MutatingRuntimeLogger(({ fields }) => {
      if (fields.error instanceof Error) {
        fields.error.message = "logger-mutated-error";
      }
    });
    const tool = createTaskStatusTool({
      reader: {
        getByAgentCallId: () => {
          throw failure;
        },
        getByTaskId: () => undefined
      },
      logger
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-status-failure",
      sessionId: "session-current",
      trigger: "user"
    });

    const output = await tool.invoke(
      context,
      JSON.stringify({ taskId: "task-reader-failure" })
    );

    expect(String(output)).toContain(originalMessage);
    expect(failure.message).toBe(originalMessage);
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "main_agent.tool.failed",
      fields: {
        runId: "run-status-failure",
        sessionId: "session-current",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: "task-reader-failure",
        errorType: "Error"
      }
    });
    expect(logger.entries.at(-1)?.fields).not.toHaveProperty("error");
  });

  test("preserves the original lookup error when failed logging throws", async () => {
    const businessFailure = new Error("Original task reader failure");
    const loggerFailure = new Error("Runtime logger error failure");
    const getByAgentCallId = vi.fn<AgentCallReader["getByAgentCallId"]>(() => {
      throw businessFailure;
    });
    const getByTaskId = vi.fn<AgentCallReader["getByTaskId"]>(() => undefined);
    const tool = createTaskStatusTool({
      reader: { getByAgentCallId, getByTaskId },
      logger: new ThrowingRuntimeLogger({
        failure: loggerFailure,
        throwWhen: ({ level }) => level === "error"
      })
    });
    const context = new RunContext<OpenAiAgentsRunContext>({
      runId: "run-status-original-error",
      sessionId: "session-current",
      trigger: "user"
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: GET_TASK_STATUS_TOOL_NAME,
        timeoutMs: 1
      })
    );

    await expect(
      tool.invoke(
        context,
        JSON.stringify({ taskId: "task-reader-failure" }),
        { signal: timeoutController.signal }
      )
    ).rejects.toBe(businessFailure);
    expect(getByAgentCallId).toHaveBeenCalledTimes(1);
    expect(getByTaskId).not.toHaveBeenCalled();
  });

  test("is enabled for user and input-required runs but disabled for terminal runs", async () => {
    const tool = createTaskStatusTool({
      reader: {
        getByAgentCallId: () => undefined,
        getByTaskId: () => undefined
      }
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Status availability",
      instructions: "Test tool availability.",
      model: "unused-model"
    });
    const context = (trigger: OpenAiAgentsRunContext["trigger"]) =>
      new RunContext<OpenAiAgentsRunContext>({
        runId: "run-status-availability",
        sessionId: "session-current",
        trigger
      });

    await expect(tool.isEnabled(context("user"), agent)).resolves.toBe(true);
    await expect(
      tool.isEnabled(context("agent_call_input_required"), agent)
    ).resolves.toBe(true);
    await expect(
      tool.isEnabled(context("agent_call_terminal"), agent)
    ).resolves.toBe(false);
  });
});
