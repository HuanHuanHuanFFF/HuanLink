import { describe, expect, test, vi } from "vitest";

import { RunContext } from "@openai/agents";

import {
  type AgentCallContinuator,
  type AgentCallInvoker,
  type AgentCallReader,
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

function context(): RunContext<OpenAiAgentsRunContext> {
  return new RunContext({
    runId: "run-tool-history-integration",
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
      executionMode: "async" as const,
      agentCallId: "agent-call-history",
      taskId: "a2a-task-history",
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

  test("records status and continuation business results without changing them", async () => {
    const history = new RecordingHistory();
    const reader: AgentCallReader = {
      getByAgentCallId: () => undefined,
      getByTaskId: () => undefined,
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

    const continuator = vi.fn<AgentCallContinuator["continueTask"]>();
    const continuationTool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => ({
          agentCallId: "task-not-ready",
          taskId: "a2a-not-ready",
          contextId: "session-tool-history-integration",
          runId: "run-original",
          sessionId: "session-tool-history-integration",
          skillId: "codex-code-task",
          capabilityName: "Codex code task",
          input: "never log this input",
          executionMode: "async",
          state: "working",
          artifacts: [],
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
        getByTaskId: () => undefined,
      },
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
    expect(continuator).not.toHaveBeenCalled();
    expect(history.results.map((entry) => entry.result.toolCallId)).toEqual([
      "sdk-status-history",
      "sdk-continue-history",
    ]);
  });
});
