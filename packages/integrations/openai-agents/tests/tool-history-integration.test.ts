import { describe, expect, test, vi } from "vitest";

import { RunContext } from "@openai/agents";

import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AgentCallService,
  AsyncToolTaskService,
  type AgentCallContinuator,
  type AgentCallInvoker,
  type AgentCallTransport,
  type AsyncToolTaskStatusReader,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";

import {
  createCodexAgentCallTool,
  createTaskContinuationTool,
  createTaskStatusTool,
  type OpenAiAgentsRunContext,
} from "../src/index.js";

type RecordedCall = {
  sessionId: string;
  call: Parameters<SessionToolHistoryRecorder["recordToolCall"]>[1];
};
type RecordedResult = {
  sessionId: string;
  result: Parameters<SessionToolHistoryRecorder["recordToolResult"]>[1];
};

class RecordingHistory implements SessionToolHistoryRecorder {
  readonly calls: RecordedCall[] = [];
  readonly results: RecordedResult[] = [];

  recordToolCall(
    sessionId: string,
    call: Parameters<SessionToolHistoryRecorder["recordToolCall"]>[1],
  ): void {
    this.calls.push({ sessionId, call });
  }

  recordToolResult(
    sessionId: string,
    result: Parameters<SessionToolHistoryRecorder["recordToolResult"]>[1],
  ): void {
    this.results.push({ sessionId, result });
  }
}

function context(
  runId = "run-tool-history-integration",
): RunContext<OpenAiAgentsRunContext> {
  return new RunContext({
    runId,
    sessionId: "session-tool-history-integration",
    trigger: "user",
  });
}

function toolCall(name: string, callId: string, argumentsJson: string) {
  return {
    type: "function_call" as const,
    callId,
    name,
    arguments: argumentsJson,
  };
}

describe("MainAgent Tool Session history integration", () => {
  test("records an accepted submission and propagates the SDK Call ID to AgentCall", async () => {
    const history = new RecordingHistory();
    const invoke = vi.fn<AgentCallInvoker["invoke"]>(async () => ({
      status: "accepted" as const,
      taskId: "huanlink-task-history",
      state: "submitted" as const,
    }));
    const tool = createCodexAgentCallTool({
      invoker: { invoke },
      historyRecorder: history,
    });
    const input = { task: "add a narrow regression test" };
    const argumentsJson = JSON.stringify(input);

    const output = await tool.invoke(context(), argumentsJson, {
      toolCall: toolCall(
        "submit_codex_agent_call",
        "sdk-submit-history",
        argumentsJson,
      ),
    });

    expect(JSON.parse(String(output))).toMatchObject({ status: "accepted" });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ sourceToolCallId: "sdk-submit-history" }),
    );
    expect(history.calls).toEqual([
      expect.objectContaining({
        sessionId: "session-tool-history-integration",
        call: expect.objectContaining({
          toolCallId: "sdk-submit-history",
          toolName: "submit_codex_agent_call",
          arguments: input,
        }),
      }),
    ]);
    expect(history.results).toEqual([
      expect.objectContaining({
        sessionId: "session-tool-history-integration",
        result: expect.objectContaining({ toolCallId: "sdk-submit-history" }),
      }),
    ]);
  });

  test("records a structured limit result and does not dispatch a third task", async () => {
    const history = new RecordingHistory();
    const taskIds = ["huanlink-task-limit-1", "huanlink-task-limit-2"];
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => taskIds.shift()!,
    });
    const discoverCapability = vi.fn(async (skillId: string) => ({
      id: skillId,
      name: "Codex code task",
    }));
    let submittedTaskNumber = 0;
    const submitTask = vi.fn(async () => {
      submittedTaskNumber += 1;
      return {
        taskId: `a2a-task-limit-${submittedTaskNumber}`,
        state: "submitted" as const,
        artifacts: [],
      };
    });
    const transport: AgentCallTransport = {
      discoverCapability,
      submitTask,
      async *watchTask(_taskId, { signal }) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      continueTask: async () => {
        throw new Error("Continuation is not expected");
      },
      cancelTask: async (taskId) => ({
        taskId,
        state: "canceled",
        artifacts: [],
      }),
    };
    const service = new AgentCallService({ transport, taskService });
    const tool = createCodexAgentCallTool({
      invoker: service,
      historyRecorder: history,
    });

    try {
      const outputs = [];
      for (const taskNumber of [1, 2, 3]) {
        const argumentsJson = JSON.stringify({
          task: `run delayed task ${taskNumber}`,
        });
        outputs.push(
          JSON.parse(
            String(
              await tool.invoke(
                context(`run-task-limit-${taskNumber}`),
                argumentsJson,
                {
                  toolCall: toolCall(
                    "submit_codex_agent_call",
                    `sdk-task-limit-${taskNumber}`,
                    argumentsJson,
                  ),
                },
              ),
            ),
          ) as unknown,
        );
      }

      expect(outputs[0]).toMatchObject({
        status: "accepted",
        taskId: "huanlink-task-limit-1",
      });
      expect(outputs[1]).toMatchObject({
        status: "accepted",
        taskId: "huanlink-task-limit-2",
      });
      expect(outputs[2]).toEqual({
        status: "error",
        error: "task-limit-reached",
        maxActiveTasksPerSession: 2,
      });
      expect(discoverCapability).toHaveBeenCalledTimes(2);
      expect(submitTask).toHaveBeenCalledTimes(2);
      expect(history.results).toHaveLength(3);
      expect(history.results[2]).toMatchObject({
        sessionId: "session-tool-history-integration",
        result: {
          toolCallId: "sdk-task-limit-3",
          output: {
            status: "error",
            error: "task-limit-reached",
            maxActiveTasksPerSession: 2,
          },
        },
      });
    } finally {
      await service.close();
    }
  });

  test("records a pre-accept rejection as a returned result without task IDs", async () => {
    const history = new RecordingHistory();
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => "huanlink-task-preaccept-rejected",
    });
    const discoverCapability = vi.fn(async () => {
      throw new Error("Capability discovery failed before acceptance");
    });
    const submitTask = vi.fn<AgentCallTransport["submitTask"]>();
    const transport: AgentCallTransport = {
      discoverCapability,
      submitTask,
      async *watchTask() {
        throw new Error("Watching is not expected");
      },
      continueTask: async () => {
        throw new Error("Continuation is not expected");
      },
      cancelTask: async () => {
        throw new Error("Cancellation is not expected");
      },
    };
    const service = new AgentCallService({ transport, taskService });
    const tool = createCodexAgentCallTool({
      invoker: service,
      historyRecorder: history,
    });
    const argumentsJson = JSON.stringify({
      task: "fail before the remote task is accepted",
    });

    try {
      const output = await tool.invoke(
        context("run-preaccept-rejected"),
        argumentsJson,
        {
          toolCall: toolCall(
            "submit_codex_agent_call",
            "sdk-preaccept-rejected",
            argumentsJson,
          ),
        },
      );
      const publicResult = JSON.parse(String(output)) as unknown;

      expect(publicResult).toEqual({
        status: "error",
        error: "task-preaccept-rejected",
      });
      expect(discoverCapability).toHaveBeenCalledTimes(1);
      expect(submitTask).not.toHaveBeenCalled();
      expect(history.results).toEqual([
        {
          sessionId: "session-tool-history-integration",
          result: {
            runId: "run-preaccept-rejected",
            toolCallId: "sdk-preaccept-rejected",
            toolName: "submit_codex_agent_call",
            output: {
              status: "error",
              error: "task-preaccept-rejected",
            },
          },
        },
      ]);
      expect(history.results[0]?.result.output).not.toHaveProperty("outcome");
      expect(history.results[0]?.result.output).not.toHaveProperty("taskId");
      expect(JSON.stringify(history.results[0]?.result.output)).not.toContain(
        "a2a",
      );
    } finally {
      await service.close();
    }
  });

  test("records status and continuation business results without changing them", async () => {
    const history = new RecordingHistory();
    const reader: AsyncToolTaskStatusReader = {
      getStatus: (_sessionId, taskId) => ({ status: "not-found", taskId }),
    };
    const statusTool = createTaskStatusTool({
      reader,
      historyRecorder: history,
    });
    const statusArguments = JSON.stringify({ taskId: "missing-task" });

    const status = await statusTool.invoke(context(), statusArguments, {
      toolCall: toolCall(
        "get_task_status",
        "sdk-status-history",
        statusArguments,
      ),
    });

    expect(JSON.parse(String(status))).toEqual({
      status: "not-found",
      taskId: "missing-task",
    });

    const continuator = vi.fn<AgentCallContinuator["continueTask"]>(
      async (request) => ({
        status: "invalid-state",
        taskId: request.taskId,
        state: "working",
      }),
    );
    const continuationTool = createTaskContinuationTool({
      continuator: { continueTask: continuator },
      historyRecorder: history,
    });
    const continuationArguments = JSON.stringify({
      taskId: "task-not-ready",
      answers: [],
    });

    const continuation = await continuationTool.invoke(
      context(),
      continuationArguments,
      {
        toolCall: toolCall(
          "continue_task",
          "sdk-continue-history",
          continuationArguments,
        ),
      },
    );

    expect(JSON.parse(String(continuation))).toEqual({
      status: "invalid-state",
      taskId: "task-not-ready",
      state: "working",
    });
    expect(continuator).toHaveBeenCalledWith({
      sessionId: "session-tool-history-integration",
      taskId: "task-not-ready",
      answers: {},
    });
    expect(history.results.map((entry) => entry.result.toolCallId)).toEqual([
      "sdk-status-history",
      "sdk-continue-history",
    ]);
  });
});
