import { afterEach, describe, expect, test, vi } from "vitest";

import {
  Runner,
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  CONTINUE_TASK_TOOL_NAME,
  GET_TASK_STATUS_TOOL_NAME,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
  type OpenAiAgentsRunner,
} from "@huanlink/integration-openai-agents";
import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AsyncToolTaskService,
  ConversationSessionStoreToolHistoryRecorder,
  InMemoryConversationSessionStore,
  type AgentCallBackgroundErrorListener,
  type AgentCallInvocationResult,
  type AgentCallReceipt,
  type AgentCallTaskState,
  type AgentCallTransport,
  type AgentCallTransportContinueRequest,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";

import {
  startAdapterServer,
  type RunningAdapterServer,
} from "../../codex-a2a-adapter/src/server.js";
import {
  CONTROLLED_RESPONSE,
  ControlledTaskExecutor,
} from "../../codex-a2a-adapter/tests/support/controlled-task-executor.js";
import {
  createPhase3HuanLinkRuntime as createRawPhase3HuanLinkRuntime,
  type CreatePhase3HuanLinkRuntimeOptions,
  type Phase3HuanLinkRuntime,
  type Phase3ReentryResult,
} from "../src/index.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

const servers: RunningAdapterServer[] = [];
const runtimes: Phase3HuanLinkRuntime[] = [];
const runtimeSessionStores = new WeakMap<
  Phase3HuanLinkRuntime,
  InMemoryConversationSessionStore
>();
let messageSequence = 0;
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
        providerData: { annotations: [] },
      },
    ],
  };
}

function agentCallInvocationResult(
  request: ModelRequest | undefined,
): AgentCallInvocationResult {
  if (request === undefined || typeof request.input === "string") {
    throw new Error("Expected an AgentCall tool continuation request");
  }

  const resultItem = request.input.find(
    (item) => item.type === "function_call_result",
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

function acceptedAgentCall(
  request: ModelRequest | undefined,
): AgentCallReceipt {
  const result = agentCallInvocationResult(request);
  if (result.status !== "accepted") {
    throw new Error(
      `Expected an accepted AgentCall, received ${result.status}`,
    );
  }
  return result;
}

function taskStatusResult(request: ModelRequest | undefined): unknown {
  if (request === undefined || typeof request.input === "string") {
    throw new Error("Expected a task-status tool continuation request");
  }

  const resultItem = request.input.find(
    (item) => item.type === "function_call_result",
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
    private readonly beforeSummary: () => Promise<void> | void = () =>
      undefined,
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
              task: "make a controlled Phase 3 code change",
            }),
          },
        ],
      };
    }

    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Codex task was accepted.")],
      };
    }

    await this.beforeSummary();
    return {
      usage: new Usage(),
      output: [assistantMessage("Codex task finished and is ready to report.")],
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
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
              executionMode: "blocking",
            }),
          },
        ],
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("Codex task completed in the current turn.")],
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
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
            arguments: JSON.stringify({ task: "start one status-test task" }),
          },
        ],
      };
    }
    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Task accepted for later status lookup.")],
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
            arguments: JSON.stringify({ taskId: accepted.taskId }),
          },
        ],
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("The existing task is still working.")],
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class DelegateContinueThenSummarizeModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-submit-before-input",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({ task: "start one resumable task" }),
          },
        ],
      };
    }
    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Task accepted before input is required.")],
      };
    }
    if (this.requests.length === 3) {
      const accepted = acceptedAgentCall(this.requests[1]);
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-continue-input-required",
            name: CONTINUE_TASK_TOOL_NAME,
            arguments: JSON.stringify({
              taskId: accepted.taskId,
              answers: [{ questionId: "approach", answers: ["Safe"] }],
            }),
          },
        ],
      };
    }
    if (this.requests.length === 4) {
      return {
        usage: new Usage(),
        output: [assistantMessage("The original paused task was continued.")],
      };
    }
    return {
      usage: new Usage(),
      output: [assistantMessage("The continued task completed.")],
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class DelegateFollowUpAfterTerminalModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-sequence-first",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({ task: "run the first sequence step" }),
          },
        ],
      };
    }
    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("The first sequence step was accepted.")],
      };
    }
    if (this.requests.length === 3) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase3-sequence-follow-up",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "run the pre-authorized second sequence step",
            }),
          },
        ],
      };
    }
    if (this.requests.length === 4) {
      return {
        usage: new Usage(),
        output: [
          assistantMessage(
            "The first step completed and the second step was accepted.",
          ),
        ],
      };
    }

    return {
      usage: new Usage(),
      output: [assistantMessage("The second sequence step completed.")],
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

function terminalTransport(state: AgentCallTaskState): AgentCallTransport {
  return {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task",
    }),
    submitTask: async () => ({
      outcome: "accepted",
      snapshot: {
        taskId: `task-${state}`,
        contextId: "session-phase3",
        state: "submitted",
        artifacts: [],
      },
    }),
    async *watchTask() {
      yield {
        taskId: `task-${state}`,
        contextId: "session-phase3",
        state,
        artifacts: [{ id: `artifact-${state}`, text: `${state} result` }],
      };
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      contextId: "session-phase3",
      state: "canceled",
      artifacts: [],
    }),
  };
}

function sequentialTerminalTransport() {
  const completions = [deferred(), deferred()];
  let submissionCount = 0;
  const submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request) => {
      submissionCount += 1;
      return {
        outcome: "accepted",
        snapshot: {
          taskId: `a2a-task-sequence-${submissionCount}`,
          contextId: request.contextId,
          state: "working",
          artifacts: [],
        },
      };
    },
  );
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task",
    }),
    submitTask,
    async *watchTask(taskId) {
      const index = Number(taskId.at(-1)) - 1;
      const completion = completions[index];
      if (completion === undefined) {
        throw new Error(`Unexpected sequence task ${taskId}`);
      }
      yield {
        taskId,
        contextId: "session-phase3-sequence",
        state: "working",
        artifacts: [],
      };
      await completion.promise;
      yield {
        taskId,
        contextId: "session-phase3-sequence",
        state: "completed",
        artifacts: [{ id: `artifact-${taskId}`, text: `${taskId} completed` }],
      };
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: [],
    }),
  };

  return { transport, submitTask, completions };
}

function pendingTransport() {
  const submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request) => ({
      outcome: "accepted",
      snapshot: {
        taskId: "a2a-task-status-query",
        contextId: request.contextId,
        state: "working",
        artifacts: [],
        statusMessage: "Codex is working",
      },
    }),
  );
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task",
    }),
    submitTask,
    async *watchTask(_taskId, { signal }) {
      await waitForAbort(signal);
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: [],
    }),
  };
  return { transport, submitTask };
}

function pausedTransport() {
  const submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request) => ({
      outcome: "accepted",
      snapshot: {
        taskId: "a2a-task-input-required",
        contextId: request.contextId,
        state: "working",
        artifacts: [],
      },
    }),
  );
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task",
    }),
    submitTask,
    async *watchTask(taskId) {
      yield {
        taskId,
        contextId: "a2a-context-input-required",
        state: "input-required",
        statusMessage: "A material choice is required",
        questions: [
          {
            header: "Approach",
            id: "approach",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Safe",
                description: "Preserve the existing public contract.",
              },
            ],
            question: "Which approach should Codex use?",
          },
        ],
        artifacts: [
          {
            id: "artifact-before-choice",
            name: "Current analysis",
            description: "What Codex learned before pausing.",
            text: "The safer approach keeps compatibility.",
          },
        ],
      };
    },
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: [],
    }),
  };
  return { transport, submitTask };
}

function resumablePausedTransport() {
  const taskId = "a2a-task-resumable";
  const submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request) => ({
      outcome: "accepted",
      snapshot: {
        taskId,
        contextId: request.contextId,
        state: "working",
        artifacts: [],
      },
    }),
  );
  const continueTask = vi.fn<AgentCallTransport["continueTask"]>(
    async (request: AgentCallTransportContinueRequest) => ({
      taskId: request.taskId,
      contextId: request.contextId,
      state: "working",
      artifacts: [],
    }),
  );
  let watchCount = 0;
  const transport: AgentCallTransport = {
    discoverCapability: async (skillId) => ({
      id: skillId,
      name: "Codex code task",
    }),
    submitTask,
    async *watchTask(currentTaskId) {
      watchCount += 1;
      if (watchCount === 1) {
        yield {
          taskId: currentTaskId,
          contextId: "a2a-context-resumable",
          state: "input-required",
          statusMessage: "Choose an approach",
          questions: [
            {
              header: "Approach",
              id: "approach",
              isOther: false,
              isSecret: false,
              options: [
                {
                  label: "Safe",
                  description: "Preserve the current contract.",
                },
              ],
              question: "Which approach should Codex use?",
            },
          ],
          artifacts: [],
        };
        return;
      }

      yield {
        taskId: currentTaskId,
        contextId: "a2a-context-resumable",
        state: "completed",
        artifacts: [
          {
            id: "artifact-resumed",
            text: "The safe approach was completed.",
          },
        ],
      };
    },
    continueTask,
    cancelTask: async (currentTaskId) => ({
      taskId: currentTaskId,
      state: "canceled",
      artifacts: [],
    }),
  };
  return { transport, submitTask, continueTask, taskId };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createPhase3HuanLinkRuntime(
  options: Omit<
    CreatePhase3HuanLinkRuntimeOptions,
    "taskService" | "sessionStore"
  >,
): Phase3HuanLinkRuntime {
  const sessionStore = new InMemoryConversationSessionStore();
  const taskService = new AsyncToolTaskService({
    maxActiveTasksPerSession: 8,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const storeRecorder = new ConversationSessionStoreToolHistoryRecorder(
    sessionStore,
  );
  const observedRecorder = options.historyRecorder;
  const historyRecorder: SessionToolHistoryRecorder =
    observedRecorder === undefined
      ? storeRecorder
      : {
          recordToolCall: (sessionId, call) => {
            storeRecorder.recordToolCall(sessionId, call);
            observedRecorder.recordToolCall(sessionId, call);
          },
          recordToolResult: (sessionId, result) => {
            storeRecorder.recordToolResult(sessionId, result);
            observedRecorder.recordToolResult(sessionId, result);
          },
        };
  const suppliedBeforeReentry = options.beforeReentry;
  const runtime = createRawPhase3HuanLinkRuntime({
    ...options,
    taskService,
    sessionStore,
    historyRecorder,
    beforeReentry: async (input) => {
      if (options.getLatestContext !== undefined) {
        const content = await options.getLatestContext(input.sessionId);
        appendTestSessionMessage(sessionStore, input.sessionId, content);
      }
      return await suppliedBeforeReentry?.(input);
    },
  });
  const runMainAgent = runtime.runMainAgent.bind(runtime);
  runtime.runMainAgent = (input) => {
    appendTestSessionMessage(
      sessionStore,
      input.sessionId,
      input.input ?? "test MainAgent turn",
      true,
    );
    return runMainAgent(input);
  };
  runtimeSessionStores.set(runtime, sessionStore);
  return runtime;
}

function appendTestSessionMessage(
  sessions: InMemoryConversationSessionStore,
  sessionId: string,
  content: string,
  onlyWhenMissing = false,
): void {
  if (onlyWhenMissing && sessions.getSession(sessionId) !== undefined) {
    return;
  }
  messageSequence += 1;
  sessions.appendChannelMessage(sessionId, {
    messageId: `phase3-test-message-${messageSequence}`,
    route: {
      channelId: "phase3-test",
      conversationKind: "group",
      conversationId: sessionId,
    },
    sender: { id: "test-user", username: "test", isSelf: false },
    receivedAt: `2026-08-12T00:00:${String(messageSequence % 60).padStart(2, "0")}.000Z`,
    content,
    contentFormat: "plain_text",
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Phase 3 HuanLink orchestration", () => {
  test("projects the latest Session context only after a queued turn obtains its slot", async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const observedInputs: string[] = [];
    const runner: OpenAiAgentsRunner = {
      run: async (_agent, input) => {
        observedInputs.push(input);
        if (observedInputs.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { finalOutput: "done" };
      },
    };
    let latestContext = "context before first turn";
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner,
      getLatestContext: () => latestContext,
    });
    runtimes.push(runtime);

    const first = runtime.runMainAgent({
      runId: "run-context-first",
      sessionId: "session-context-queue",
      input: "stale caller input one",
    });
    await firstStarted.promise;

    latestContext = "context when second turn was queued";
    const second = runtime.runMainAgent({
      runId: "run-context-second",
      sessionId: "session-context-queue",
      input: "stale caller input two",
    });
    latestContext = "context after second turn was queued";
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observedInputs).toEqual(["context before first turn"]);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { output: "done" },
      { output: "done" },
    ]);
    expect(observedInputs).toEqual([
      "context before first turn",
      "context after second turn was queued",
    ]);
  });

  test("queues a terminal re-entry behind the active turn and projects context when it obtains the slot", async () => {
    const activeTurnStarted = deferred();
    const releaseActiveTurn = deferred();
    const reentry = deferred<Phase3ReentryResult>();
    const observedInputs: string[] = [];
    const { transport, completions } = sequentialTerminalTransport();
    const runner: OpenAiAgentsRunner = {
      run: async (_agent, input) => {
        observedInputs.push(input);
        if (observedInputs.length === 1) {
          activeTurnStarted.resolve();
          await releaseActiveTurn.promise;
        }
        return { finalOutput: "done" };
      },
    };
    let latestContext = "context for active turn";
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner,
      getLatestContext: () => latestContext,
      onReentry: (result) => reentry.resolve(result),
    });
    runtimes.push(runtime);

    const activeTurn = runtime.runMainAgent({
      runId: "run-active-before-terminal",
      sessionId: "session-phase3-sequence",
    });
    await activeTurnStarted.promise;

    runtimeSessionStores
      .get(runtime)!
      .appendAgentToolCall("session-phase3-sequence", {
        runId: "run-submit-before-terminal",
        toolCallId: "call-submit-before-terminal",
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
        arguments: { task: "long external task", executionMode: "async" },
      });
    const accepted = await runtime.agentCalls.invoke({
      runId: "run-submit-before-terminal",
      sessionId: "session-phase3-sequence",
      contextId: "session-phase3-sequence",
      skillId: "codex-code-task",
      input: "long external task",
      executionMode: "async",
      toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      sourceToolCallId: "call-submit-before-terminal",
    });
    latestContext = "context before terminal arrived";
    completions[0]!.resolve();
    await runtime.agentCalls.waitForIdle();
    latestContext = "context after terminal was queued";

    expect(observedInputs).toEqual(["context for active turn"]);

    releaseActiveTurn.resolve();
    await expect(activeTurn).resolves.toEqual({ output: "done" });
    const completed = await reentry.promise;

    expect(completed.latestContext).toContain(
      "context after terminal was queued",
    );
    expect(observedInputs).toHaveLength(2);
    expect(observedInputs[1]).toContain("context after terminal was queued");
  });

  test("logs MainAgent payload sizes without recording full Channel content", async () => {
    const logger = new RecordingRuntimeLogger();
    const secretInput = "private Channel message with attachment key";
    const secretOutput = "private Agent result";
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner: {
        run: async () => ({ finalOutput: secretOutput }),
      },
      logger,
    });
    runtimes.push(runtime);

    await expect(
      runtime.runMainAgent({
        runId: "run-safe-log",
        sessionId: "session-safe-log",
        input: secretInput,
      }),
    ).resolves.toEqual({ output: secretOutput });

    expect(JSON.stringify(logger.entries)).not.toContain(secretInput);
    expect(JSON.stringify(logger.entries)).not.toContain(secretOutput);
    expect(logger.find("main_agent.run.input")?.fields).toMatchObject({
      inputChars: secretInput.length,
    });
    expect(logger.find("main_agent.run.output")?.fields).toMatchObject({
      outputChars: secretOutput.length,
    });
  });

  test("starts one structured fresh MainAgent turn when an async AgentCall requires input", async () => {
    const model = new DelegateThenSummarizeModel();
    const { transport, submitTask } = pausedTransport();
    const onReentry = vi.fn((_result: Phase3ReentryResult) => undefined);
    const latestContext = [
      "Alice: please update the parser",
      "HuanLink: Codex task accepted.",
      "Bob: preserve compatibility",
    ].join("\n");
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      createRunId: () => "run-phase3-input-required",
      getLatestContext: () => latestContext,
      onReentry,
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-input-required-initial",
      sessionId: "session-phase3-input-required",
      input: "delegate a task that needs one material choice",
    });
    const accepted = acceptedAgentCall(model.requests[1]);
    await runtime.agentCalls.waitForIdle();
    await vi.waitFor(() => expect(onReentry).toHaveBeenCalledTimes(1));
    const [result] = onReentry.mock.calls[0]!;

    expect(result).toMatchObject({
      runId: "run-phase3-input-required",
      sessionId: "session-phase3-input-required",
      trigger: "agent_call_input_required",
      reason: "input-required",
      task: {
        status: "found",
        taskId: accepted.taskId,
        state: "input-required",
        statusMessage: "A material choice is required",
        payload: {
          questions: [expect.objectContaining({ id: "approach" })],
          artifacts: [
            expect.objectContaining({
              id: "artifact-before-choice",
              text: "The safer approach keeps compatibility.",
            }),
          ],
        },
      },
    });
    expect(result.input).toContain('"questions"');
    expect(result.input).toContain('"options"');
    expect(result.input).toContain("Bob: preserve compatibility");
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(3);
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      GET_TASK_STATUS_TOOL_NAME,
      CONTINUE_TASK_TOOL_NAME,
    ]);
    expect(model.requests[2]?.tools.map(({ name }) => name)).toEqual([
      GET_TASK_STATUS_TOOL_NAME,
      CONTINUE_TASK_TOOL_NAME,
    ]);
    expect(model.requests[2]?.systemInstructions).toContain(
      "continue_task for this same task",
    );
    expect(model.requests[2]?.systemInstructions).toContain("ask the QQ user");
    expect(model.requests[2]?.systemInstructions).toContain("/huanlink");
    expect(model.requests[2]?.systemInstructions).toContain("@HuanLink");
    expect(model.requests[2]?.systemInstructions).toContain(
      "never submit a replacement AgentCall",
    );
  });

  test("continues the original paused task when session context already contains the answer", async () => {
    const model = new DelegateContinueThenSummarizeModel();
    const { transport, submitTask, continueTask, taskId } =
      resumablePausedTransport();
    const reentries: Phase3ReentryResult[] = [];
    const bothReentries = deferred();
    const reentryRunIds = [
      "run-phase3-auto-continue",
      "run-phase3-auto-continue-terminal",
    ];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      createRunId: () => reentryRunIds.shift() ?? "run-phase3-extra",
      getLatestContext: () =>
        "Alice: use the Safe option and preserve the existing contract",
      onReentry: (result) => {
        reentries.push(result);
        if (reentries.length === 2) {
          bothReentries.resolve();
        }
      },
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-auto-continue-initial",
      sessionId: "session-phase3-auto-continue",
      input: "delegate a task whose answer is already authorized",
    });
    const accepted = acceptedAgentCall(model.requests[1]);
    await bothReentries.promise;
    await runtime.agentCalls.waitForIdle();

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(continueTask).toHaveBeenCalledTimes(1);
    expect(continueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        contextId: "a2a-context-resumable",
        answers: { approach: ["Safe"] },
      }),
    );
    expect(reentries.map(({ reason }) => reason)).toEqual([
      "input-required",
      "terminal",
    ]);
    expect(
      reentries.map(({ task }) => ({
        taskId: task.taskId,
        state: task.state,
      })),
    ).toEqual([
      { taskId: accepted.taskId, state: "input-required" },
      { taskId: accepted.taskId, state: "completed" },
    ]);
    expect(
      runtime.agentCalls.listByRunId("run-phase3-auto-continue-initial"),
    ).toHaveLength(1);
    expect(runtime.agentCalls.listByRunId("run-phase3-auto-continue")).toEqual(
      [],
    );
    expect(model.requests).toHaveLength(5);
  });

  test("does not start a duplicate paused re-entry for the first blocking pause", async () => {
    const model = new BlockingThenReplyModel();
    const { transport, submitTask } = pausedTransport();
    const onReentry = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      onReentry,
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-blocking-input-required",
      sessionId: "session-phase3-blocking-input-required",
      input: "delegate and wait for the first material choice",
    });
    await runtime.agentCalls.waitForIdle();

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(onReentry).not.toHaveBeenCalled();
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "input-required",
    );
  });

  test("queries an existing session task without submitting another AgentCall", async () => {
    const model = new SubmitThenQueryStatusModel();
    const { transport, submitTask } = pendingTransport();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-status-submission",
      sessionId: "session-phase3-status",
      input: "start a task",
    });
    const accepted = acceptedAgentCall(model.requests[1]);

    await expect(
      runtime.runMainAgent({
        runId: "run-phase3-status-query",
        sessionId: "session-phase3-status",
        input: `report task ${accepted.taskId}`,
      }),
    ).resolves.toEqual({ output: "The existing task is still working." });

    expect(taskStatusResult(model.requests[3])).toMatchObject({
      status: "found",
      taskId: accepted.taskId,
      state: "working",
      statusMessage: "Codex is working",
      payload: { artifacts: [] },
    });
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(runtime.agentCalls.listByRunId("run-phase3-status-query")).toEqual(
      [],
    );
    expect(model.requests[2]?.systemInstructions).toContain(
      "use get_task_status",
    );
    expect(model.requests[2]?.systemInstructions).toContain(
      "never use submit_codex_agent_call",
    );
  });

  test("blocking mode returns the remote result in the current turn without re-entry", async () => {
    const remoteStarted = deferred();
    const remoteCompletion = deferred();
    const executor = new ControlledTaskExecutor({
      waitBeforeComplete: async () => {
        remoteStarted.resolve();
        await remoteCompletion.promise;
      },
    });
    const server = await startAdapterServer({ executor, port: 0 });
    servers.push(server);

    const model = new BlockingThenReplyModel();
    const onReentry = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: server.origin,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      onReentry,
    });
    runtimes.push(runtime);
    let initialRunSettled = false;
    const initialRun = runtime
      .runMainAgent({
        runId: "run-phase3-blocking",
        sessionId: "session-phase3",
        input: "delegate this task and block until completion",
      })
      .finally(() => {
        initialRunSettled = true;
      });

    const firstSignal = await Promise.race([
      remoteStarted.promise.then(() => "remote-started" as const),
      initialRun.then(() => "initial-run-settled" as const),
    ]);
    expect(firstSignal).toBe("remote-started");
    expect(initialRunSettled).toBe(false);

    remoteCompletion.resolve();
    await expect(initialRun).resolves.toMatchObject({
      output: "Codex task completed in the current turn.",
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
      waitBeforeComplete: async () => remoteCompletion.promise,
    });
    const server = await startAdapterServer({ executor, port: 0 });
    servers.push(server);

    const model = new DelegateThenSummarizeModel();
    const reentry = deferred<Phase3ReentryResult>();
    const historyRecorder: SessionToolHistoryRecorder = {
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
    };
    let latestContext = "group context before acceptance";
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: server.origin,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      createRunId: () => "run-phase3-reentry",
      getLatestContext: async () => latestContext,
      historyRecorder,
      onReentry: (result) => reentry.resolve(result),
    });
    runtimes.push(runtime);

    const first = await runtime.runMainAgent({
      runId: "run-phase3-initial",
      sessionId: "session-phase3",
      input: "delegate this code task to Codex",
    });
    const accepted = acceptedAgentCall(model.requests[1]);

    expect(first.output).toBe("Codex task was accepted.");
    expect(accepted).toMatchObject({
      status: "accepted",
    });
    expect(
      runtime.agentCalls.listByRunId("run-phase3-initial")[0],
    ).toMatchObject({
      sessionId: "session-phase3",
      sourceToolCallId: "phase3-tool-call",
      state: expect.stringMatching(/submitted|working/),
    });
    expect(historyRecorder.recordToolCall).toHaveBeenCalledWith(
      "session-phase3",
      expect.objectContaining({
        runId: "run-phase3-initial",
        toolCallId: "phase3-tool-call",
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      }),
    );
    expect(historyRecorder.recordToolResult).toHaveBeenCalledWith(
      "session-phase3",
      expect.objectContaining({
        runId: "run-phase3-initial",
        toolCallId: "phase3-tool-call",
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      }),
    );
    expect(model.requests).toHaveLength(2);

    latestContext = "latest group message arrived while Codex was working";
    remoteCompletion.resolve();
    const completed = await reentry.promise;

    expect(completed).toMatchObject({
      runId: "run-phase3-reentry",
      sessionId: "session-phase3",
      trigger: "agent_call_terminal",
      reason: "terminal",
      output: "Codex task finished and is ready to report.",
      task: {
        status: "found",
        taskId: accepted.taskId,
        state: "completed",
      },
    });
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]?.tools.map(({ name }) => name)).toEqual([
      SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    ]);
    const reentryModelInput = JSON.stringify(model.requests[2]?.input);
    expect(reentryModelInput).toContain(latestContext);
    expect(reentryModelInput).toContain(accepted.taskId);
    expect(reentryModelInput).toContain("explicit, unambiguous follow-up");
    expect(reentryModelInput).toContain("Never repeat the completed task");
  });

  test("submits a pre-authorized follow-up from terminal re-entry and reports both terminal steps", async () => {
    const model = new DelegateFollowUpAfterTerminalModel();
    const { transport, submitTask, completions } =
      sequentialTerminalTransport();
    const reentries: Phase3ReentryResult[] = [];
    const firstReentry = deferred<Phase3ReentryResult>();
    const secondReentry = deferred<Phase3ReentryResult>();
    const runIds = [
      "run-phase3-sequence-follow-up",
      "run-phase3-sequence-finished",
    ];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      createRunId: () => runIds.shift() ?? "run-phase3-sequence-extra",
      getLatestContext: () =>
        "The user explicitly authorized the second step without confirmation.",
      onReentry: (result) => {
        reentries.push(result);
        if (reentries.length === 1) {
          firstReentry.resolve(result);
        } else if (reentries.length === 2) {
          secondReentry.resolve(result);
        }
      },
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-sequence-initial",
      sessionId: "session-phase3-sequence",
      input: "run two authorized Codex steps without asking between them",
    });

    completions[0]!.resolve();
    await firstReentry.promise;
    expect(submitTask).toHaveBeenCalledTimes(2);
    expect(model.requests[2]?.tools.map(({ name }) => name)).toEqual([
      SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    ]);
    expect(acceptedAgentCall(model.requests[3])).toMatchObject({
      status: "accepted",
      taskId: expect.not.stringContaining("a2a-task-sequence-2"),
    });
    expect(reentries[0]?.output).toBe(
      "The first step completed and the second step was accepted.",
    );

    completions[1]!.resolve();
    await secondReentry.promise;
    await runtime.agentCalls.waitForIdle();

    expect(reentries.map(({ output }) => output)).toEqual([
      "The first step completed and the second step was accepted.",
      "The second sequence step completed.",
    ]);
    expect(submitTask.mock.calls.map(([request]) => request.contextId)).toEqual(
      ["session-phase3-sequence", "session-phase3-sequence"],
    );
    expect(
      runtime.agentCalls.listByRunId("run-phase3-sequence-initial"),
    ).toHaveLength(1);
    expect(
      runtime.agentCalls.listByRunId("run-phase3-sequence-follow-up"),
    ).toHaveLength(1);
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
          tracingDisabled: true,
        }),
        createRunId: () => `run-phase3-${state}`,
        getLatestContext: () => `latest context for ${state}`,
        onReentry: (result) => reentry.resolve(result),
      });
      runtimes.push(runtime);

      const first = await runtime.runMainAgent({
        runId: `run-phase3-initial-${state}`,
        sessionId: "session-phase3",
        input: `delegate a task that becomes ${state}`,
      });
      const accepted = acceptedAgentCall(model.requests[1]);
      const result = await reentry.promise;

      expect(first.output).toBe("Codex task was accepted.");
      expect(result).toMatchObject({
        runId: `run-phase3-${state}`,
        sessionId: "session-phase3",
        trigger: "agent_call_terminal",
        reason: "terminal",
        task: {
          status: "found",
          taskId: accepted.taskId,
          state,
          payload: { artifacts: [{ text: `${state} result` }] },
        },
      });
      expect(model.requests).toHaveLength(3);
      expect(model.requests[2]?.tools.map(({ name }) => name)).toEqual([
        SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      ]);
    },
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
      reentry.resolve(result),
    );
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      onReentry,
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-competing-terminal",
      sessionId: "session-phase3",
      input: "delegate and accept only the first terminal update",
    });
    const accepted = acceptedAgentCall(model.requests[1]);
    await summaryStarted.promise;

    const internalAgentCallId = runtime.agentCalls.listByRunId(
      "run-phase3-competing-terminal",
    )[0]!.agentCallId;
    await runtime.agentCalls.cancel(internalAgentCallId);
    releaseSummary.resolve();
    await reentry.promise;
    await runtime.agentCalls.waitForIdle();

    expect(
      runtime.agentCalls.getByAgentCallId(internalAgentCallId)?.state,
    ).toBe("completed");
    expect(onReentry).toHaveBeenCalledTimes(1);
    expect(model.requests).toHaveLength(3);
  });

  test("releases the re-entry reservation exactly once when the re-entry model fails", async () => {
    const model = new DelegateThenSummarizeModel(() => {
      throw new Error("re-entry model failed");
    });
    const cleanup = vi.fn();
    const beforeReentry = vi.fn(async () => cleanup);
    const onReentry = vi.fn();
    const observed = deferred<Error>();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      beforeReentry,
      onReentry,
      onBackgroundError: (error) => observed.resolve(error),
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-reentry-model-failure",
      sessionId: "session-phase3",
      input: "delegate and release the re-entry reservation on failure",
    });
    const failure = await observed.promise;

    expect(failure.message).toContain("re-entry model failed");
    expect(beforeReentry).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onReentry).not.toHaveBeenCalled();
  });

  test.each([
    ["input-required", () => pausedTransport().transport],
    ["terminal", () => terminalTransport("completed")],
  ] as const)(
    "aborts a hanging %s re-entry without reporting a shutdown error",
    async (_kind, createTransport) => {
      const model = new DelegateThenSummarizeModel();
      const initialRunner = new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      });
      const reentryStarted = deferred<AbortSignal | undefined>();
      const manualRelease = deferred();
      let runnerCalls = 0;
      const hangingRunner: OpenAiAgentsRunner = {
        async run(agent, input, options) {
          runnerCalls += 1;
          if (runnerCalls === 1) {
            return initialRunner.run(agent, input, options);
          }
          reentryStarted.resolve(options?.signal);
          await waitForReleaseOrAbort(manualRelease.promise, options?.signal);
          throw new Error("manually released hanging Phase 3 re-entry");
        },
      };
      const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
      const runtime = createPhase3HuanLinkRuntime({
        codexA2aOrigin: "http://127.0.0.1:1",
        transport: createTransport(),
        runner: hangingRunner,
        onBackgroundError,
      });
      runtimes.push(runtime);

      await runtime.runMainAgent({
        runId: `run-phase3-hanging-${_kind}`,
        sessionId: "session-phase3-hanging-close",
        input: `delegate one ${_kind} task`,
      });
      const reentrySignal = await reentryStarted.promise;

      const closeOperation = runtime.close();
      try {
        await expect(settlesWithin(closeOperation, 1_000)).resolves.toBe(true);
      } finally {
        manualRelease.resolve();
        await Promise.allSettled([closeOperation]);
      }

      expect(reentrySignal?.aborted).toBe(true);
      expect(onBackgroundError).not.toHaveBeenCalled();
    },
  );

  test("drains the actual re-entry turn when its runner ignores shutdown", async () => {
    const model = new DelegateThenSummarizeModel();
    const initialRunner = new Runner({
      modelProvider: new SingleModelProvider(model),
      tracingDisabled: true,
    });
    const reentryStarted = deferred<AbortSignal | undefined>();
    const releaseReentry = deferred();
    let runnerCalls = 0;
    const runner: OpenAiAgentsRunner = {
      async run(agent, input, options) {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          return initialRunner.run(agent, input, options);
        }
        reentryStarted.resolve(options?.signal);
        await releaseReentry.promise;
        return { finalOutput: "late re-entry output" };
      },
    };
    const onReentry = vi.fn();
    const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner,
      onReentry,
      onBackgroundError,
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-noncooperative-reentry",
      sessionId: "session-phase3-noncooperative-reentry",
      input: "delegate and wait for shutdown",
    });
    const signal = await reentryStarted.promise;
    const closeOperation = runtime.close();

    expect(signal?.aborted).toBe(true);
    await expect(settlesWithin(closeOperation, 50)).resolves.toBe(false);

    releaseReentry.resolve();
    await expect(closeOperation).resolves.toBeUndefined();
    expect(onReentry).not.toHaveBeenCalled();
    expect(onBackgroundError).not.toHaveBeenCalled();
  });

  test("aborts and drains the actual fresh turn before Phase3 closes", async () => {
    const turnStarted = deferred<AbortSignal | undefined>();
    const releaseTurn = deferred();
    const runner: OpenAiAgentsRunner = {
      run: async (_agent, _input, options) => {
        turnStarted.resolve(options?.signal);
        await releaseTurn.promise;
        return { finalOutput: "done" };
      },
    };
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: terminalTransport("completed"),
      runner,
    });
    runtimes.push(runtime);

    const turn = runtime.runMainAgent({
      runId: "run-phase3-fresh-close",
      sessionId: "session-phase3-fresh-close",
      input: "wait until Phase3 closes",
    });
    const signal = await turnStarted.promise;
    const closeOperation = runtime.close();

    expect(signal?.aborted).toBe(true);
    await expect(settlesWithin(closeOperation, 50)).resolves.toBe(false);

    releaseTurn.resolve();
    await expect(turn).rejects.toThrow(/closed/i);
    await expect(closeOperation).resolves.toBeUndefined();
    await expect(
      runtime.runMainAgent({
        runId: "run-phase3-after-close",
        sessionId: "session-phase3-fresh-close",
        input: "must not start",
      }),
    ).rejects.toThrow(/closed/i);
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
        tracingDisabled: true,
      }),
      onReentry: () => {
        throw new Error("QQ egress is unavailable");
      },
      onBackgroundError: (error, record) =>
        observed.resolve({
          error,
          recordState: record?.state,
          notificationError: undefined,
        }),
    });
    runtimes.push(runtime);

    await runtime.runMainAgent({
      runId: "run-phase3-reentry-error",
      sessionId: "session-phase3",
      input: "delegate and surface any re-entry failure",
    });
    const failure = await observed.promise;

    expect(failure.error.message).toContain("QQ egress is unavailable");
    expect(failure.recordState).toBeUndefined();
    expect(failure.notificationError).toBeUndefined();
  });
});

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function waitForReleaseOrAbort(
  release: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    return release;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void release.then(() => {
      cleanup();
      resolve();
    });
  });
}
