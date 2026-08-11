import { describe, expect, test, vi } from "vitest";

import type {
  AsyncToolTaskStatusQueryResult,
  AsyncToolTaskStatusReader,
} from "@huanlink/core";
import { Agent, RunContext, ToolTimeoutError } from "@openai/agents";

import {
  GET_TASK_STATUS_TOOL_NAME,
  createTaskStatusTool,
  type OpenAiAgentsRunContext,
} from "../src/index.js";
import { MutatingRuntimeLogger } from "./support/mutating-runtime-logger.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

const foundAgentCallStatus: AsyncToolTaskStatusQueryResult = {
  status: "found",
  taskId: "huanlink-task-status",
  kind: "agent-call",
  toolName: "submit_codex_agent_call",
  state: "input-required",
  payload: {
    artifacts: [{ id: "artifact-status", text: "current result" }],
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
  },
  statusMessage: "Codex needs a scope",
  createdAt: "2026-08-12T01:00:00.000Z",
  updatedAt: "2026-08-12T01:01:00.000Z",
};

function runContext(
  trigger: OpenAiAgentsRunContext["trigger"] = "user",
  sessionId = "session-status-public",
) {
  return new RunContext<OpenAiAgentsRunContext>({
    runId: "run-status-public",
    sessionId,
    trigger,
  });
}

describe("createTaskStatusTool", () => {
  test("queries a HuanLink task only within the current session", async () => {
    const getStatus = vi.fn<AsyncToolTaskStatusReader["getStatus"]>(
      () => foundAgentCallStatus,
    );
    const logger = new RecordingRuntimeLogger();
    const tool = createTaskStatusTool({ reader: { getStatus }, logger });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({ taskId: "huanlink-task-status" }),
    );

    expect(getStatus).toHaveBeenCalledWith(
      "session-status-public",
      "huanlink-task-status",
    );
    expect(JSON.parse(String(output))).toEqual(foundAgentCallStatus);
    expect(JSON.stringify(output)).not.toContain("a2aTaskId");
    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "main_agent.tool.started",
        fields: {
          runId: "run-status-public",
          sessionId: "session-status-public",
          toolName: GET_TASK_STATUS_TOOL_NAME,
          taskId: "huanlink-task-status",
        },
      },
      {
        level: "info",
        message: "main_agent.tool.completed",
        fields: {
          runId: "run-status-public",
          sessionId: "session-status-public",
          toolName: GET_TASK_STATUS_TOOL_NAME,
          taskId: "huanlink-task-status",
          resolutionStatus: "found",
          kind: "agent-call",
          state: "input-required",
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("current result");
    expect(JSON.stringify(logger.entries)).not.toContain(
      "Which scope should Codex use?",
    );
  });

  test("returns the generic status projection for a non-AgentCall task", async () => {
    const fakeStatus: AsyncToolTaskStatusQueryResult = {
      status: "found",
      taskId: "huanlink-task-fake",
      kind: "fake-delay",
      toolName: "fake_delayed_tool",
      state: "working",
      payload: { progress: 40 },
      createdAt: "2026-08-12T02:00:00.000Z",
      updatedAt: "2026-08-12T02:01:00.000Z",
    };
    const tool = createTaskStatusTool({
      reader: { getStatus: () => fakeStatus },
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({ taskId: "huanlink-task-fake" }),
    );

    expect(JSON.parse(String(output))).toEqual(fakeStatus);
  });

  test("returns the fixed not-found result from the same-session reader", async () => {
    const getStatus = vi.fn<AsyncToolTaskStatusReader["getStatus"]>(
      (_sessionId, taskId) => ({ status: "not-found", taskId }),
    );
    const tool = createTaskStatusTool({ reader: { getStatus } });

    const output = await tool.invoke(
      runContext("user", "session-one"),
      JSON.stringify({ taskId: "huanlink-task-other-session" }),
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "not-found",
      taskId: "huanlink-task-other-session",
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith(
      "session-one",
      "huanlink-task-other-session",
    );
  });

  test("does not expose a status result to a mutating logger", async () => {
    const status = structuredClone(foundAgentCallStatus);
    const logger = new MutatingRuntimeLogger(({ fields }) => {
      fields.payload = { artifacts: [{ id: "logger-mutated" }] };
      fields.statusMessage = "logger-mutated";
    });
    const tool = createTaskStatusTool({
      reader: { getStatus: () => status },
      logger,
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({ taskId: "huanlink-task-status" }),
    );

    expect(JSON.parse(String(output))).toEqual(foundAgentCallStatus);
    expect(status).toEqual(foundAgentCallStatus);
  });

  test.each([
    {
      name: "child binding",
      createLogger: () => new ThrowingRuntimeLogger({ throwOnChild: true }),
    },
    {
      name: "started logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ message }) => message === "main_agent.tool.started",
        }),
    },
    {
      name: "completed logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ message }) => message === "main_agent.tool.completed",
        }),
    },
  ])("preserves a found result when $name fails", async ({ createLogger }) => {
    const tool = createTaskStatusTool({
      reader: { getStatus: () => foundAgentCallStatus },
      logger: createLogger(),
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({ taskId: "huanlink-task-status" }),
    );

    expect(JSON.parse(String(output))).toEqual(foundAgentCallStatus);
  });

  test("logs lookup failure metadata without changing the business error", async () => {
    const failure = new Error("status lookup failed");
    const logger = new RecordingRuntimeLogger();
    const tool = createTaskStatusTool({
      reader: {
        getStatus: () => {
          throw failure;
        },
      },
      logger,
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({ taskId: "huanlink-task-status" }),
    );

    expect(String(output)).toContain("status lookup failed");
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "main_agent.tool.failed",
      fields: {
        runId: "run-status-public",
        sessionId: "session-status-public",
        toolName: GET_TASK_STATUS_TOOL_NAME,
        taskId: "huanlink-task-status",
        errorType: "Error",
      },
    });
  });

  test("preserves the original lookup error when failed logging throws", async () => {
    const businessFailure = new Error("Original task status reader failure");
    const getStatus = vi.fn<AsyncToolTaskStatusReader["getStatus"]>(() => {
      throw businessFailure;
    });
    const tool = createTaskStatusTool({
      reader: { getStatus },
      logger: new ThrowingRuntimeLogger({
        throwWhen: ({ level }) => level === "error",
      }),
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: GET_TASK_STATUS_TOOL_NAME,
        timeoutMs: 1,
      }),
    );

    await expect(
      tool.invoke(
        runContext(),
        JSON.stringify({ taskId: "huanlink-task-status" }),
        { signal: timeoutController.signal },
      ),
    ).rejects.toBe(businessFailure);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  test("is enabled only for user and input-required runs", async () => {
    const tool = createTaskStatusTool({
      reader: {
        getStatus: (_sessionId, taskId) => ({ status: "not-found", taskId }),
      },
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Tool availability",
      instructions: "Test tool availability.",
      model: "unused-model",
    });
    const isEnabled = (trigger: OpenAiAgentsRunContext["trigger"]) =>
      tool.isEnabled(runContext(trigger), agent);

    await expect(isEnabled("user")).resolves.toBe(true);
    await expect(isEnabled("agent_call_input_required")).resolves.toBe(true);
    await expect(isEnabled("agent_call_terminal")).resolves.toBe(false);
  });
});
