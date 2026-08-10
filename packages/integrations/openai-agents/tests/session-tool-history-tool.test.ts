import { describe, expect, test, vi } from "vitest";

import { RunContext, tool } from "@openai/agents";
import type { SessionToolHistoryRecorder } from "@huanlink/core";
import { z } from "zod";

import { withSessionToolHistory } from "../src/session-tool-history-tool.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

type TestContext = {
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
};

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

function context(signal?: AbortSignal): RunContext<TestContext> {
  return new RunContext({
    runId: "run-history-1",
    sessionId: "session-history-1",
    ...(signal === undefined ? {} : { signal }),
  });
}

function toolCall(callId: string, argumentsJson: string) {
  return {
    type: "function_call" as const,
    callId,
    name: "test_history_tool",
    arguments: argumentsJson,
  };
}

describe("withSessionToolHistory", () => {
  test("records the real SDK Call ID before a successful public invoke and records its original result", async () => {
    const history = new RecordingHistory();
    const execute = vi.fn(async () => ({
      status: "accepted",
      taskId: "task-1",
    }));
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute,
      }),
      history,
    );
    const argumentsJson = JSON.stringify({ task: "delegate safely" });

    const output = await wrapped.invoke(context(), argumentsJson, {
      toolCall: toolCall("sdk-call-1", argumentsJson),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(output).toEqual({
      status: "accepted",
      taskId: "task-1",
    });
    expect(history.calls).toEqual([
      {
        sessionId: "session-history-1",
        call: {
          runId: "run-history-1",
          toolCallId: "sdk-call-1",
          toolName: "test_history_tool",
          arguments: { task: "delegate safely" },
        },
      },
    ]);
    expect(history.results).toEqual([
      {
        sessionId: "session-history-1",
        result: {
          runId: "run-history-1",
          toolCallId: "sdk-call-1",
          toolName: "test_history_tool",
          output: { status: "accepted", taskId: "task-1" },
        },
      },
    ]);
  });

  test("records a structured business result without converting it into an exception", async () => {
    const history = new RecordingHistory();
    const execute = vi.fn(async () => ({
      status: "not-found",
      taskId: "missing",
    }));
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute,
      }),
      history,
    );
    const argumentsJson = JSON.stringify({ taskId: "missing" });

    const output = await wrapped.invoke(context(), argumentsJson, {
      toolCall: toolCall("sdk-call-business", argumentsJson),
    });

    expect(output).toEqual({
      status: "not-found",
      taskId: "missing",
    });
    expect(history.results[0]?.result.output).toEqual({
      status: "not-found",
      taskId: "missing",
    });
  });

  test("keeps a JSON-string Tool result structured in Session history", async () => {
    const history = new RecordingHistory();
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () =>
          JSON.stringify({ status: "success", messageId: "message-1" }),
      }),
      history,
    );
    const argumentsJson = JSON.stringify({ message: "send" });

    const output = await wrapped.invoke(context(), argumentsJson, {
      toolCall: toolCall("sdk-call-json-string", argumentsJson),
    });

    expect(output).toBe(
      JSON.stringify({ status: "success", messageId: "message-1" }),
    );
    expect(history.results[0]?.result.output).toEqual({
      status: "success",
      messageId: "message-1",
    });
  });

  test("records a stable thrown result and preserves the original exception", async () => {
    const history = new RecordingHistory();
    const failure = new Error("credential=should-not-be-recorded");
    const original = {
      ...tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => undefined,
      }),
      invoke: vi.fn(async () => {
        throw failure;
      }),
    };
    const wrapped = withSessionToolHistory(original, history);
    const argumentsJson = JSON.stringify({ task: "will throw" });

    await expect(
      wrapped.invoke(context(), argumentsJson, {
        toolCall: toolCall("sdk-call-thrown", argumentsJson),
      }),
    ).rejects.toBe(failure);

    expect(history.results).toEqual([
      {
        sessionId: "session-history-1",
        result: {
          runId: "run-history-1",
          toolCallId: "sdk-call-thrown",
          toolName: "test_history_tool",
          output: { outcome: "thrown", errorType: "Error" },
        },
      },
    ]);
  });

  test("records cancellation without retaining the abort reason and preserves it", async () => {
    const history = new RecordingHistory();
    const controller = new AbortController();
    const cancellation = new Error("secret cancellation reason");
    controller.abort(cancellation);
    const original = {
      ...tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => undefined,
      }),
      invoke: vi.fn(async () => {
        throw cancellation;
      }),
    };
    const wrapped = withSessionToolHistory(original, history);
    const argumentsJson = JSON.stringify({ task: "will cancel" });

    await expect(
      wrapped.invoke(context(controller.signal), argumentsJson, {
        toolCall: toolCall("sdk-call-canceled", argumentsJson),
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(history.results[0]?.result.output).toEqual({
      outcome: "canceled",
      errorType: "Error",
    });
  });

  test("records unparseable input as rawArguments before preserving the Tool validation result", async () => {
    const history = new RecordingHistory();
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => ({ status: "unused" }),
      }),
      history,
    );
    const rawArguments = "not-json";

    await wrapped.invoke(context(), rawArguments, {
      toolCall: toolCall("sdk-call-raw", rawArguments),
    });

    expect(history.calls[0]).toEqual({
      sessionId: "session-history-1",
      call: {
        runId: "run-history-1",
        toolCallId: "sdk-call-raw",
        toolName: "test_history_tool",
        rawArguments,
      },
    });
  });

  test("records schema-invalid JSON as rawArguments before invoking the Tool", async () => {
    const history = new RecordingHistory();
    const rawArguments = JSON.stringify({ task: 42 });
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => ({ status: "unused" }),
      }),
      history,
      undefined,
      (input) => z.object({ task: z.string() }).parse(JSON.parse(input)),
    );

    await wrapped.invoke(context(), rawArguments, {
      toolCall: toolCall("sdk-call-invalid-schema", rawArguments),
    });

    expect(history.calls[0]).toEqual({
      sessionId: "session-history-1",
      call: {
        runId: "run-history-1",
        toolCallId: "sdk-call-invalid-schema",
        toolName: "test_history_tool",
        rawArguments,
      },
    });
  });

  test("rejects a missing SDK Call ID without executing the original Tool", async () => {
    const history = new RecordingHistory();
    const invoke = vi.fn(async () => "must not run");
    const original = {
      ...tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => undefined,
      }),
      invoke,
    };
    const wrapped = withSessionToolHistory(original, history);

    await expect(wrapped.invoke(context(), JSON.stringify({}))).rejects.toThrow(
      "requires the SDK Tool Call ID",
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(history.calls).toEqual([]);
  });

  test("rejects a Call history write failure without executing the original Tool", async () => {
    const logger = new RecordingRuntimeLogger();
    const history: SessionToolHistoryRecorder = {
      recordToolCall: () => {
        throw new Error("secret store failure");
      },
      recordToolResult: () => undefined,
    };
    const invoke = vi.fn(async () => "must not run");
    const original = {
      ...tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => undefined,
      }),
      invoke,
    };
    const wrapped = withSessionToolHistory(original, history, logger);
    const argumentsJson = JSON.stringify({ task: "secret blocked input" });

    await expect(
      wrapped.invoke(context(), argumentsJson, {
        toolCall: toolCall("sdk-call-write-failure", argumentsJson),
      }),
    ).rejects.toThrow("Tool history Call recording failed");

    expect(invoke).not.toHaveBeenCalled();
    expect(logger.entries).toEqual([
      {
        level: "error",
        message: "main_agent.tool.history.write_failed",
        fields: {
          runId: "run-history-1",
          sessionId: "session-history-1",
          toolCallId: "sdk-call-write-failure",
          toolName: "test_history_tool",
          historyStage: "call",
          errorType: "Error",
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("secret");
  });

  test("adds a model-visible history warning without replacing a successful result when Result recording fails", async () => {
    const logger = new RecordingRuntimeLogger();
    const history: SessionToolHistoryRecorder = {
      recordToolCall: () => undefined,
      recordToolResult: () => {
        throw new Error("secret store failure");
      },
    };
    const wrapped = withSessionToolHistory(
      tool({
        name: "test_history_tool",
        description: "test",
        parameters: z.object({}).passthrough(),
        execute: async () => ({
          status: "accepted",
          taskId: "secret-task-result",
        }),
      }),
      history,
      logger,
    );
    const argumentsJson = JSON.stringify({ task: "secret accepted input" });

    const output = await wrapped.invoke(context(), argumentsJson, {
      toolCall: toolCall("sdk-call-result-write-failure", argumentsJson),
    });

    expect(output).toEqual({
      status: "accepted",
      taskId: "secret-task-result",
      historyWarning: "Tool result history was not persisted.",
    });
    expect(logger.entries).toEqual([
      {
        level: "error",
        message: "main_agent.tool.history.write_failed",
        fields: {
          runId: "run-history-1",
          sessionId: "session-history-1",
          toolCallId: "sdk-call-result-write-failure",
          toolName: "test_history_tool",
          historyStage: "result",
          errorType: "Error",
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("secret");
  });
});
