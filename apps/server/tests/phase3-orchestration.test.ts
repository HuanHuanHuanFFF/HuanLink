import { afterEach, describe, expect, test, vi } from "vitest";

import {
  Runner,
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent
} from "@openai/agents";
import {
  GET_TASK_STATUS_TOOL_NAME,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
} from "@huanlink/integration-openai-agents";
import type {
  AgentCallInvocationResult,
  AgentCallReceipt,
  AgentCallTaskState,
  AgentCallTransport
} from "@huanlink/core";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../../codex-a2a-adapter/src/server.js";
import {
  CONTROLLED_RESPONSE,
  ControlledTaskExecutor
} from "../../codex-a2a-adapter/tests/support/controlled-task-executor.js";
import {
  createPhase3HuanLinkRuntime,
  type Phase3HuanLinkRuntime,
  type Phase3ReentryResult
} from "../src/index.js";

const servers: RunningAdapterServer[] = [];
const runtimes: Phase3HuanLinkRuntime[] = [];
const rejectUnexpectedContinuation: AgentCallTransport["continueTask"] =
  async () => {
    throw new Error("Unexpected task continuation in this test");
  };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assistantMessage(text: string): ModelResponse["output"][number] {
  return {
    id: "msg-phase3-reentry",
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

function agentCallInvocationResult(
  request: ModelRequest | undefined
): AgentCallInvocationResult {
  if (request === undefined || typeof request.input === "string") {
    throw new Error("Expected an AgentCall tool continuation request");
  }

  const resultItem = request.input.find(
    (item) => item.type === "function_call_result"
  );
  if (
    resultItem === undefined ||
    resultItem.name !== SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
  ) {
    throw new Error("Expected an AgentCall function_call_result item");
  }

  const output = resultItem.output;
  const text =
    typeof output === "string"
      ? output
      : !Array.isArray(output) && output.type === "text"
        ? output.text
        : undefined;
  if (text === undefined) {
    throw new Error("Expected a text AgentCall function result");
  }

  return JSON.parse(text) as AgentCallInvocationResult;
}

function acceptedAgentCall(request: ModelRequest | undefined): AgentCallReceipt {
  const result = agentCallInvocationResult(request);
  if (result.status !== "accepted") {
    throw new Error(`Expected an accepted AgentCall, received ${result.status}`);
  }
  return result;
}

function taskStatusResult(request: ModelRequest | undefined): unknown {
  if (request === undefined || typeof request.input === "string") {
    throw new Error("Expected a task-status tool continuation request");
  }

  const resultItem = request.input.find(
    (item) => item.type === "function_call_result"
  );
  if (
    resultItem === undefined ||
    resultItem.name !== GET_TASK_STATUS_TOOL_NAME
  ) {
    throw new Error("Expected a task-status function_call_result item");
  }
  const output = resultItem.output;
  const text =
    typeof output === "string"
      ? output
      : !Array.isArray(output) && output.type === "text"
        ? output.text
        : undefined;
  if (text === undefined) {
    throw new Error("Expected a text task-status function result");
  }

  return JSON.parse(text) as unknown;
}

class DelegateThenSummarizeModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly beforeSummary: () => Promise<void> | void = () => undefined
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-tool-call",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "make a controlled Phase 3 code change"
            })
          }
        ]
      };
    }

    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Codex task was accepted.")]
      };
    }

    await this.beforeSummary();
    return {
      usage: new Usage(),
      output: [assistantMessage("Codex task finished and is ready to report.")]
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class BlockingThenReplyModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-blocking-tool-call",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "make a controlled Phase 3 code change",
              executionMode: "blocking"
            })
          }
        ]
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("Codex task completed in the current turn.")]
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class SubmitThenQueryStatusModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-submit-before-status",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({ task: "start one status-test task" })
          }
        ]
      };
    }
    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Task accepted for later status lookup.")]
      };
    }
    if (this.requests.length === 3) {
      const accepted = acceptedAgentCall(this.requests[1]);
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-status-query",
            name: GET_TASK_STATUS_TOOL_NAME,
            arguments: JSON.stringify({ taskId: accepted.agentCallId })
          }
        ]
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("The existing task is still working.")]
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

function terminalTransport(state: AgentCallTaskState): AgentCallTransport {
  return {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task"
    }),
    submitTask: async () => ({
      taskId: `task-${state}`,
      contextId: "session-phase3",
      state: "submitted",
      artifacts: []
    }),
    async *watchTask() {
      yield {
        taskId: `task-${state}`,
        contextId: "session-phase3",
        state,
        artifacts: [{ id: `artifact-${state}`, text: `${state} result` }]
      };
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      contextId: "session-phase3",
      state: "canceled",
      artifacts: []
    })
  };
}

function pendingTransport() {
  const submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request) => ({
      taskId: "a2a-task-status-query",
      contextId: request.contextId,
      state: "working",
      artifacts: [],
      statusMessage: "Codex is working"
    })
  );
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task"
    }),
    submitTask,
    async *watchTask(_taskId, { signal }) {
      await waitForAbort(signal);
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: []
    })
  };
  return { transport, submitTask };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Phase 3 HuanLink orchestration", () => {
  test("queries an existing session task without submitting another AgentCall", async () => {
    const model = new SubmitThenQueryStatusModel();
    const { transport, submitTask } = pendingTransport();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      })
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-status-submission",
      sessionId: "session-phase3-status",
      input: "start a task"
    });
    const accepted = acceptedAgentCall(model.requests[1]);

    await expect(
      runtime.runMainAgent({
        runId: "run-phase3-status-query",
        sessionId: "session-phase3-status",
        input: `report task ${accepted.agentCallId}`
      })
    ).resolves.toEqual({ output: "The existing task is still working." });

    expect(taskStatusResult(model.requests[3])).toMatchObject({
      status: "found",
      task: {
        taskId: accepted.agentCallId,
        a2aTaskId: accepted.taskId,
        state: "working",
        executionMode: "async",
        statusMessage: "Codex is working",
        artifacts: []
      }
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(runtime.agentCalls.listByRunId("run-phase3-status-query")).toEqual([]);
    expect(model.requests[2]?.systemInstructions).toContain(
      "use get_task_status"
    );
    expect(model.requests[2]?.systemInstructions).toContain(
      "never use submit_codex_agent_call"
    );
  });

  test("blocking mode returns the remote result in the current turn without re-entry", async () => {
    const remoteStarted = deferred();
    const remoteCompletion = deferred();
    const executor = new ControlledTaskExecutor({
      waitBeforeComplete: async () => {
        remoteStarted.resolve();
        await remoteCompletion.promise;
      }
    });
    const server = await startAdapterServer({ executor, port: 0 });
    servers.push(server);

    const model = new BlockingThenReplyModel();
    const onReentry = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: server.origin,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      }),
      onReentry
    });
    runtimes.push(runtime);
    let initialRunSettled = false;
    const initialRun = runtime
      .runMainAgent({
        runId: "run-phase3-blocking",
        sessionId: "session-phase3",
        input: "delegate this task and block until completion"
      })
      .finally(() => {
        initialRunSettled = true;
      });

    const firstSignal = await Promise.race([
      remoteStarted.promise.then(() => "remote-started" as const),
      initialRun.then(() => "initial-run-settled" as const)
    ]);
    expect(firstSignal).toBe("remote-started");
    expect(initialRunSettled).toBe(false);

    remoteCompletion.resolve();
    await expect(initialRun).resolves.toMatchObject({
      output: "Codex task completed in the current turn."
    });
    await runtime.agentCalls.waitForIdle();

    expect(onReentry).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(2);
    const continuationInput = JSON.stringify(model.requests[1]?.input);
    expect(continuationInput).toContain("completed");
    expect(continuationInput).toContain(CONTROLLED_RESPONSE);
  });

  test("accepts an async A2A AgentCall immediately and starts one fresh MainAgent turn on completion", async () => {
    const remoteCompletion = deferred();
    const executor = new ControlledTaskExecutor({
      waitBeforeComplete: async () => remoteCompletion.promise
    });
    const server = await startAdapterServer({ executor, port: 0 });
    servers.push(server);

    const model = new DelegateThenSummarizeModel();
    const reentry = deferred<Phase3ReentryResult>();
    let latestContext = "group context before acceptance";
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: server.origin,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      }),
      createRunId: () => "run-phase3-reentry",
      getLatestContext: async () => latestContext,
      onReentry: (result) => reentry.resolve(result)
    });
    runtimes.push(runtime);

    const first = await runtime.runMainAgent({
      runId: "run-phase3-initial",
      sessionId: "session-phase3",
      input: "delegate this code task to Codex"
    });
    const accepted = acceptedAgentCall(model.requests[1]);

    expect(first.output).toBe("Codex task was accepted.");
    expect(accepted).toMatchObject({
      status: "accepted",
      executionMode: "async"
    });
    expect(runtime.agentCalls.getByAgentCallId(accepted.agentCallId)).toMatchObject({
      taskId: accepted.taskId,
      sessionId: "session-phase3",
      state: expect.stringMatching(/submitted|working/)
    });
    expect(model.requests).toHaveLength(2);

    latestContext = "latest group message arrived while Codex was working";
    remoteCompletion.resolve();
    const completed = await reentry.promise;

    expect(completed).toMatchObject({
      runId: "run-phase3-reentry",
      sessionId: "session-phase3",
      latestContext,
      output: "Codex task finished and is ready to report.",
      agentCall: {
        agentCallId: accepted.agentCallId,
        taskId: accepted.taskId,
        state: "completed"
      }
    });
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]?.tools).toEqual([]);
    const reentryModelInput = JSON.stringify(model.requests[2]?.input);
    expect(reentryModelInput).toContain(latestContext);
    expect(reentryModelInput).toContain(accepted.taskId);
  });

  test.each(["failed", "canceled", "rejected"] as const)(
    "starts one fresh MainAgent turn when an AgentCall becomes %s",
    async (state) => {
      const model = new DelegateThenSummarizeModel();
      const reentry = deferred<Phase3ReentryResult>();
      const runtime = createPhase3HuanLinkRuntime({
        codexA2aOrigin: "http://127.0.0.1:1",
        transport: terminalTransport(state),
        runner: new Runner({
          modelProvider: new SingleModelProvider(model),
          tracingDisabled: true
        }),
        createRunId: () => `run-phase3-${state}`,
        getLatestContext: () => `latest context for ${state}`,
        onReentry: (result) => reentry.resolve(result)
      });
      runtimes.push(runtime);

      const first = await runtime.runMainAgent({
        runId: `run-phase3-initial-${state}`,
        sessionId: "session-phase3",
        input: `delegate a task that becomes ${state}`
      });
      const accepted = acceptedAgentCall(model.requests[1]);
      const result = await reentry.promise;

      expect(first.output).toBe("Codex task was accepted.");
      expect(result).toMatchObject({
        runId: `run-phase3-${state}`,
        sessionId: "session-phase3",
        latestContext: `latest context for ${state}`,
        agentCall: {
          agentCallId: accepted.agentCallId,
          state,
          artifacts: [{ text: `${state} result` }]
        }
      });
      expect(model.requests).toHaveLength(3);
      expect(model.requests[2]?.tools).toEqual([]);
    }
  );

  test("starts only one re-entry when competing terminal updates arrive for the same task", async () => {
    const summaryStarted = deferred();
    const releaseSummary = deferred();
    const model = new DelegateThenSummarizeModel(async () => {
      summaryStarted.resolve();
      await releaseSummary.promise;
    });
    const reentry = deferred<Phase3ReentryResult>();
    const onReentry = vi.fn((result: Phase3ReentryResult) =>
      reentry.resolve(result)
    );
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      }),
      onReentry
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-competing-terminal",
      sessionId: "session-phase3",
      input: "delegate and accept only the first terminal update"
    });
    const accepted = acceptedAgentCall(model.requests[1]);
    await summaryStarted.promise;

    await runtime.agentCalls.cancel(accepted.agentCallId);
    releaseSummary.resolve();
    await reentry.promise;
    await runtime.agentCalls.waitForIdle();

    expect(runtime.agentCalls.getByAgentCallId(accepted.agentCallId)?.state).toBe(
      "completed"
    );
    expect(onReentry).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(3);
  });

  test("reports a MainAgent re-entry failure through the background error callback", async () => {
    const model = new DelegateThenSummarizeModel();
    const observed = deferred<{
      error: Error;
      recordState: AgentCallTaskState | undefined;
      notificationError: string | undefined;
    }>();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true
      }),
      onReentry: () => {
        throw new Error("QQ egress is unavailable");
      },
      onBackgroundError: (error, record) =>
        observed.resolve({
          error,
          recordState: record?.state,
          notificationError: record?.terminalNotificationError
        })
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-reentry-error",
      sessionId: "session-phase3",
      input: "delegate and surface any re-entry failure"
    });
    const failure = await observed.promise;

    expect(failure.error.message).toContain("QQ egress is unavailable");
    expect(failure.recordState).toBe("completed");
    expect(failure.notificationError).toContain("QQ egress is unavailable");
  });
});
