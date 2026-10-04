import { describe, expect, test, vi } from "vitest";

import type { AgentCallContinuator } from "@huanlink/core";
import { Agent, RunContext, ToolTimeoutError } from "@openai/agents";

import {
  CONTINUE_TASK_TOOL_NAME,
  createTaskContinuationTool,
  type OpenAiAgentsRunContext,
} from "../src/index.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

function runContext(
  trigger: OpenAiAgentsRunContext["trigger"] = "user",
  signal?: AbortSignal,
) {
  return new RunContext<OpenAiAgentsRunContext>({
    runId: "run-continuation",
    sessionId: "session-current",
    trigger,
    ...(signal === undefined ? {} : { signal }),
  });
}

function continuedResult() {
  return {
    status: "continued" as const,
    taskId: "huanlink-task-public",
    state: "working" as const,
  };
}

describe("createTaskContinuationTool", () => {
  test("continues by HuanLink task ID without exposing an A2A ID", async () => {
    const runController = new AbortController();
    const toolController = new AbortController();
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(async () =>
      continuedResult(),
    );
    const logger = new RecordingRuntimeLogger();
    const tool = createTaskContinuationTool({
      continuator: { continueTask },
      logger,
    });

    const output = await tool.invoke(
      runContext("user", runController.signal),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [{ questionId: "scope", answers: ["Adapter only"] }],
      }),
      { signal: toolController.signal },
    );

    expect(JSON.parse(String(output))).toEqual(continuedResult());
    expect(JSON.stringify(output)).not.toContain("a2aTaskId");
    expect(continueTask).toHaveBeenCalledWith({
      sessionId: "session-current",
      taskId: "huanlink-task-public",
      answers: { scope: ["Adapter only"] },
      signal: expect.any(AbortSignal),
    });
    const request = continueTask.mock.calls[0]?.[0];
    if (typeof request === "string") {
      throw new Error("Expected the HuanLink continuation request object");
    }
    const combinedSignal = request?.signal;
    expect(combinedSignal).not.toBe(runController.signal);
    expect(combinedSignal).not.toBe(toolController.signal);
    toolController.abort();
    expect(combinedSignal?.aborted).toBe(true);
    expect(logger.entries.at(-1)?.fields).toEqual({
      runId: "run-continuation",
      sessionId: "session-current",
      toolName: CONTINUE_TASK_TOOL_NAME,
      taskId: "huanlink-task-public",
      status: "continued",
      state: "working",
    });
  });

  test.each([
    {
      name: "not found",
      result: {
        status: "not-found" as const,
        taskId: "huanlink-task-public",
      },
    },
    {
      name: "unsupported for a non-AgentCall task",
      result: {
        status: "unsupported" as const,
        taskId: "huanlink-task-public",
        operation: "continue" as const,
      },
    },
    {
      name: "invalid state",
      result: {
        status: "invalid-state" as const,
        taskId: "huanlink-task-public",
        state: "working" as const,
      },
    },
    {
      name: "invalid answers",
      result: {
        status: "invalid-answers" as const,
        taskId: "huanlink-task-public",
        error: "Answers do not match the pending questions.",
      },
    },
  ])("returns the Core $name result unchanged", async ({ result }) => {
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => result,
    );
    const tool = createTaskContinuationTool({
      continuator: { continueTask },
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [{ questionId: "scope", answers: ["Adapter only"] }],
      }),
    );

    expect(JSON.parse(String(output))).toEqual(result);
    expect(continueTask).toHaveBeenCalledWith({
      sessionId: "session-current",
      taskId: "huanlink-task-public",
      answers: { scope: ["Adapter only"] },
    });
  });

  test("rejects duplicate question IDs before collapsing the answer record", async () => {
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
    const tool = createTaskContinuationTool({
      continuator: { continueTask },
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [
          { questionId: "scope", answers: ["Adapter"] },
          { questionId: "scope", answers: ["Server"] },
        ],
      }),
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "invalid-answers",
      taskId: "huanlink-task-public",
      error: "Each question ID must appear at most once.",
    });
    expect(continueTask).not.toHaveBeenCalled();
  });

  test("preserves a pending question whose ID is __proto__", async () => {
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(async () =>
      continuedResult(),
    );
    const tool = createTaskContinuationTool({
      continuator: { continueTask },
    });

    await tool.invoke(
      runContext(),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [{ questionId: "__proto__", answers: ["safe"] }],
      }),
    );

    const request = continueTask.mock.calls[0]?.[0];
    if (typeof request === "string" || request === undefined) {
      throw new Error("Expected the HuanLink continuation request object");
    }
    expect(Object.hasOwn(request.answers, "__proto__")).toBe(true);
    expect(request.answers["__proto__"]).toEqual(["safe"]);
    expect(Object.prototype).not.toHaveProperty("safe");
  });

  test("logs question IDs but never answer values", async () => {
    const secretAnswer = "secret-answer-that-must-not-be-logged";
    const logger = new RecordingRuntimeLogger();
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(async () =>
      continuedResult(),
    );
    const tool = createTaskContinuationTool({
      continuator: { continueTask },
      logger,
    });

    await tool.invoke(
      runContext(),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [{ questionId: "credential", answers: [secretAnswer] }],
      }),
    );

    expect(JSON.stringify(logger.entries)).not.toContain(secretAnswer);
    expect(logger.entries[0]?.fields.questionIds).toEqual(["credential"]);
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
  ])("preserves the Core result when $name fails", async ({ createLogger }) => {
    const tool = createTaskContinuationTool({
      continuator: {
        continueTask: vi.fn<AgentCallContinuator["continueTask"]>(async () =>
          continuedResult(),
        ),
      },
      logger: createLogger(),
    });

    const output = await tool.invoke(
      runContext(),
      JSON.stringify({
        taskId: "huanlink-task-public",
        answers: [{ questionId: "scope", answers: ["Adapter only"] }],
      }),
    );

    expect(JSON.parse(String(output))).toEqual(continuedResult());
  });

  test("logs continuation failure without recording answer values", async () => {
    const secretAnswer = "secret-continuation-value";
    const businessFailure = new Error("continuation failed");
    const logger = new ThrowingRuntimeLogger({
      throwWhen: ({ level }) => level === "error",
    });
    const tool = createTaskContinuationTool({
      continuator: {
        continueTask: vi.fn<AgentCallContinuator["continueTask"]>(async () => {
          throw businessFailure;
        }),
      },
      logger,
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: CONTINUE_TASK_TOOL_NAME,
        timeoutMs: 1,
      }),
    );

    await expect(
      tool.invoke(
        runContext(),
        JSON.stringify({
          taskId: "huanlink-task-public",
          answers: [{ questionId: "credential", answers: [secretAnswer] }],
        }),
        { signal: timeoutController.signal },
      ),
    ).rejects.toBe(businessFailure);
    expect(JSON.stringify(logger.attempts)).not.toContain(secretAnswer);
    expect(logger.attempts.at(-1)).toMatchObject({
      level: "error",
      message: "main_agent.tool.failed",
      fields: {
        taskId: "huanlink-task-public",
        questionIds: ["credential"],
        errorType: "Error",
      },
    });
  });

  test("is enabled only for user and input-required runs", async () => {
    const tool = createTaskContinuationTool({
      continuator: {
        continueTask: vi.fn<AgentCallContinuator["continueTask"]>(async () =>
          continuedResult(),
        ),
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
