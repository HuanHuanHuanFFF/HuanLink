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
import { SUBMIT_CODEX_AGENT_CALL_TOOL_NAME } from "@huanlink/integration-openai-agents";
import type {
  AgentCallTaskState,
  AgentCallTransport
} from "@huanlink/core";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../../codex-a2a-adapter/src/server.js";
import { ControlledTaskExecutor } from "../../codex-a2a-adapter/tests/support/controlled-task-executor.js";
import {
  createPhase3HuanLinkRuntime,
  type Phase3HuanLinkRuntime,
  type Phase3ReentryResult
} from "../src/index.js";

const servers: RunningAdapterServer[] = [];
const runtimes: Phase3HuanLinkRuntime[] = [];

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
    cancelTask: async (taskId) => ({
      taskId,
      contextId: "session-phase3",
      state: "canceled",
      artifacts: []
    })
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Phase 3 HuanLink orchestration", () => {
  test("accepts an A2A AgentCall immediately and starts one fresh MainAgent turn on completion", async () => {
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
    const accepted = JSON.parse(first.output) as {
      agentCallId: string;
      taskId: string;
      status: string;
    };

    expect(accepted).toMatchObject({ status: "accepted" });
    expect(runtime.agentCalls.getByAgentCallId(accepted.agentCallId)).toMatchObject({
      taskId: accepted.taskId,
      sessionId: "session-phase3",
      state: expect.stringMatching(/submitted|working/)
    });
    expect(model.requests).toHaveLength(1);

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
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.tools).toEqual([]);
    const reentryModelInput = JSON.stringify(model.requests[1]?.input);
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
      const accepted = JSON.parse(first.output) as { agentCallId: string };
      const result = await reentry.promise;

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
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.tools).toEqual([]);
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

    const first = await runtime.runMainAgent({
      runId: "run-phase3-competing-terminal",
      sessionId: "session-phase3",
      input: "delegate and accept only the first terminal update"
    });
    const accepted = JSON.parse(first.output) as { agentCallId: string };
    await summaryStarted.promise;

    await runtime.agentCalls.cancel(accepted.agentCallId);
    releaseSummary.resolve();
    await reentry.promise;
    await runtime.agentCalls.waitForIdle();

    expect(runtime.agentCalls.getByAgentCallId(accepted.agentCallId)?.state).toBe(
      "completed"
    );
    expect(onReentry).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(2);
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
