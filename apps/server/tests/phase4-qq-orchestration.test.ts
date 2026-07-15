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
import type { OpenAiAgentsRunner } from "@huanlink/integration-openai-agents";
import {
  InMemoryConversationStore,
  type AgentCallBackgroundErrorListener,
  type AgentCallTransport,
  type AgentCallTransportSubmitRequest,
  type ChannelAdapter,
  type ChannelMessageListener,
  type InboundChannelMessage
} from "@huanlink/core";

import {
  createPhase4QqRuntime,
  type Phase4QqRuntime
} from "../src/index.js";
import { ThrowingMutatingRuntimeLogger } from "./support/hostile-runtime-logger.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

const TARGET_GROUP = "20002";
const OTHER_GROUP = "90009";
const SESSION_ID = `onebot11:group:${TARGET_GROUP}`;
const runtimes: Phase4QqRuntime[] = [];
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
    id: `message-${text}`,
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

class ControlledChannel implements ChannelAdapter {
  readonly channel = "onebot11" as const;
  readonly sendCalls: Array<{ conversationId: string; text: string }> = [];
  readonly sent: Array<{ conversationId: string; text: string }> = [];
  readonly firstSendRelease = deferred();
  startCalls = 0;
  closeCalls = 0;
  private readonly listeners = new Set<ChannelMessageListener>();

  constructor(private readonly blockFirstSend = false) {}

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const callIndex = this.sendCalls.length;
    const output = { conversationId, text };
    this.sendCalls.push(output);
    if (this.blockFirstSend && callIndex === 0) {
      await this.firstSendRelease.promise;
    }
    this.sent.push(output);
  }

  async emit(message: InboundChannelMessage): Promise<void> {
    await Promise.all(
      [...this.listeners].map((listener) => Promise.resolve(listener(message)))
    );
  }
}

class CloseReleasesSendChannel extends ControlledChannel {
  readonly sendStarted = deferred();
  private readonly sendRelease = deferred();

  override async sendText(
    conversationId: string,
    text: string
  ): Promise<void> {
    this.sendCalls.push({ conversationId, text });
    this.sendStarted.resolve();
    await this.sendRelease.promise;
    throw new Error("send rejected because channel closed");
  }

  override async close(): Promise<void> {
    await super.close();
    this.sendRelease.resolve();
  }

  forceRelease(): void {
    this.sendRelease.resolve();
  }
}

class RejectFirstSendChannel extends ControlledChannel {
  private attempts = 0;

  override async sendText(
    conversationId: string,
    text: string
  ): Promise<void> {
    const output = { conversationId, text };
    this.sendCalls.push(output);
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("first QQ send failed");
    }
    this.sent.push(output);
  }
}

class DeferredStartChannel extends ControlledChannel {
  readonly startEntered = deferred();
  readonly startRelease = deferred();

  override async start(): Promise<void> {
    this.startCalls += 1;
    this.startEntered.resolve();
    await this.startRelease.promise;
  }
}

class IdleModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return { usage: new Usage(), output: [] };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class BoundReplyModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage(),
      output: [assistantMessage("MainAgent used the injected model binding.")]
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class DelegateThenSummarizeModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly delegateTerminalFollowUp = false) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase4-tool-call",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "make the requested Phase 4 code change"
            })
          }
        ]
      };
    }
    if (this.requests.length === 2) {
      return {
        usage: new Usage(),
        output: [assistantMessage("Codex task accepted by MainAgent.")]
      };
    }
    if (this.requests.length === 3 && this.delegateTerminalFollowUp) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "phase4-terminal-follow-up",
            name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
            arguments: JSON.stringify({
              task: "run the explicitly authorized second step",
              executionMode: "blocking"
            })
          }
        ]
      };
    }
    if (this.requests.length === 4 && this.delegateTerminalFollowUp) {
      return {
        usage: new Usage(),
        output: [
          assistantMessage(
            "The first task completed and the authorized follow-up was accepted."
          )
        ]
      };
    }
    return {
      usage: new Usage(),
      output: [assistantMessage("Codex task completed with the latest context.")]
    };
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class ThrowingModel implements Model {
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("MainAgent failed before replying");
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

class ControlledTransport implements AgentCallTransport {
  readonly submitted = deferred<AgentCallTransportSubmitRequest>();
  readonly completion = deferred();
  readonly followUpCompletion = deferred();
  readonly submissions: AgentCallTransportSubmitRequest[] = [];

  constructor(
    readonly taskId = "a2a-task-phase4",
    private readonly completeImmediately = false
  ) {}

  async discoverCapability(skillId: string) {
    return { id: skillId, name: "Codex" };
  }

  async submitTask(request: AgentCallTransportSubmitRequest) {
    this.submissions.push(request);
    this.submitted.resolve(request);
    const taskId =
      this.submissions.length === 1 ? this.taskId : `${this.taskId}-follow-up`;
    return {
      taskId,
      contextId: "a2a-context-phase4",
      state: "submitted" as const,
      artifacts: []
    };
  }

  continueTask = rejectUnexpectedContinuation;

  async *watchTask(
    taskId: string,
    options: { signal: AbortSignal }
  ) {
    const isFollowUp = taskId === `${this.taskId}-follow-up`;
    yield {
      taskId,
      contextId: "a2a-context-phase4",
      state: "working" as const,
      artifacts: []
    };
    if (!this.completeImmediately) {
      const released = await waitUntilReleased(
        isFollowUp
          ? this.followUpCompletion.promise
          : this.completion.promise,
        options.signal
      );
      if (!released) {
        return;
      }
    }
    yield {
      taskId,
      contextId: "a2a-context-phase4",
      state: "completed" as const,
      artifacts: [
        { id: `artifact-${taskId}`, text: `${taskId} controlled diff` }
      ]
    };
  }

  async cancelTask(taskId: string) {
    return { taskId, state: "canceled" as const, artifacts: [] };
  }
}

class PausingTransport implements AgentCallTransport {
  readonly submitted = deferred<AgentCallTransportSubmitRequest>();
  readonly pausePublished = deferred();
  readonly taskId = "a2a-task-paused-phase4";

  async discoverCapability(skillId: string) {
    return { id: skillId, name: "Codex" };
  }

  async submitTask(request: AgentCallTransportSubmitRequest) {
    this.submitted.resolve(request);
    return {
      taskId: this.taskId,
      contextId: "a2a-context-paused-phase4",
      state: "working" as const,
      artifacts: []
    };
  }

  async *watchTask(taskId: string) {
    this.pausePublished.resolve();
    yield {
      taskId,
      contextId: "a2a-context-paused-phase4",
      state: "input-required" as const,
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
              description: "Preserve the existing contract."
            }
          ],
          question: "Which approach should Codex use?"
        }
      ],
      artifacts: []
    };
  }

  continueTask = rejectUnexpectedContinuation;

  async cancelTask(taskId: string) {
    return { taskId, state: "canceled" as const, artifacts: [] };
  }
}

function idleTransport(): AgentCallTransport {
  return {
    discoverCapability: async (skillId) => ({ id: skillId, name: "Codex" }),
    submitTask: async () => ({
      taskId: "a2a-unused",
      state: "submitted",
      artifacts: []
    }),
    async *watchTask() {},
    continueTask: rejectUnexpectedContinuation,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: []
    })
  };
}

function message(
  messageId: string,
  overrides: Partial<InboundChannelMessage> = {}
): InboundChannelMessage {
  return {
    channel: "onebot11",
    conversationId: TARGET_GROUP,
    messageId,
    senderId: "30003",
    senderName: "Alice",
    text: `message ${messageId}`,
    receivedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

function runner(model: Model): Runner {
  return new Runner({
    modelProvider: new SingleModelProvider(model),
    tracingDisabled: true
  });
}

function runIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `run-extra-${index}`;
}

async function waitForSendCount(
  channel: ControlledChannel,
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(channel.sent).toHaveLength(count));
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("Phase 4 QQ orchestration", () => {
  test("keeps MainAgent input and QQ egress intact when the logger mutates fields and throws", async () => {
    const channel = new ControlledChannel();
    const model = new BoundReplyModel();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(model),
      logger: new ThrowingMutatingRuntimeLogger()
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("hostile-logger", {
        text: "/huanlink preserve this request",
        trigger: { kind: "command", text: "preserve this request" }
      })
    );
    await waitForSendCount(channel, 1);

    const modelInput = JSON.stringify(model.requests[0]?.input);
    expect(modelInput).toContain("preserve this request");
    expect(modelInput).not.toContain("logger-corrupted");
    expect(channel.sent[0]).toEqual({
      conversationId: TARGET_GROUP,
      text: "MainAgent used the injected model binding."
    });
  });

  test("passes the production model binding through Phase 4 without a Runner override", async () => {
    const channel = new ControlledChannel();
    const model = new BoundReplyModel();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      modelBinding: { model }
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("bound-model", {
        trigger: { kind: "command", text: "use the configured model" }
      })
    );
    await waitForSendCount(channel, 1);

    expect(channel.sent[0]?.text).toBe(
      "MainAgent used the injected model binding."
    );
    expect(runtime.conversations.formatLatestContext(SESSION_ID)).toBe(
      [
        "Alice: message bound-model",
        "HuanLink: MainAgent used the injected model binding."
      ].join("\n")
    );
    expect(
      runtime.conversations.getMessages(SESSION_ID).map(({ messageId }) =>
        messageId
      )
    ).toEqual(["bound-model"]);
    expect(model.requests).toHaveLength(1);
  });

  test("stores an ordinary target-group message without running MainAgent", async () => {
    const channel = new ControlledChannel();
    const store = new InMemoryConversationStore();
    const model = new IdleModel();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(model),
      store
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(message("ordinary", { text: "ambient context" }));

    expect(store.getMessages(SESSION_ID)).toEqual([
      message("ordinary", { text: "ambient context" })
    ]);
    expect(model.requests).toHaveLength(0);
    expect(channel.sent).toEqual([]);
  });

  test("returns from channel ingress while MainAgent is still running and buffers later context", async () => {
    const channel = new ControlledChannel();
    const store = new InMemoryConversationStore();
    const started = deferred();
    const release = deferred();
    const gatedRunner: OpenAiAgentsRunner = {
      async run() {
        started.resolve();
        await release.promise;
        return { finalOutput: "MainAgent finished after release." };
      }
    };
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: gatedRunner,
      store
    });
    runtimes.push(runtime);

    await runtime.start();
    await expect(
      channel.emit(
        message("slow-trigger", {
          trigger: { kind: "mention", text: "wait inside MainAgent" }
        })
      )
    ).resolves.toBeUndefined();
    await started.promise;
    await expect(
      channel.emit(message("during-run", { text: "arrived during the run" }))
    ).resolves.toBeUndefined();

    expect(store.getMessages(SESSION_ID).map((item) => item.messageId)).toEqual([
      "slow-trigger",
      "during-run"
    ]);
    expect(channel.sent).toEqual([]);

    release.resolve();
    await waitForSendCount(channel, 1);
  });

  test("builds a waiting user turn from context captured after the previous egress", async () => {
    const channel = new ControlledChannel(true);
    const inputs: string[] = [];
    const outputs = ["first reply", "second reply"];
    const captureRunner: OpenAiAgentsRunner = {
      run: async (_agent, input) => {
        inputs.push(input);
        return { finalOutput: outputs[inputs.length - 1] ?? "extra reply" };
      }
    };
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: captureRunner,
      createRunId: runIds("run-user-first", "run-user-second")
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("user-first", {
        text: "/huanlink first request",
        trigger: { kind: "command", text: "first request" }
      })
    );
    await vi.waitFor(() => expect(channel.sendCalls).toHaveLength(1));
    await channel.emit(
      message("user-second", {
        text: "@<10001> second request",
        trigger: { kind: "mention", text: "second request" }
      })
    );

    try {
      expect(inputs).toHaveLength(1);
    } finally {
      channel.firstSendRelease.resolve();
    }
    await waitForSendCount(channel, 2);

    expect(inputs[1]).toContain("HuanLink: first reply");
    expect(inputs[1]).toContain("Current explicit request:\nsecond request");
  });

  test("acknowledges a triggered code task with mechanical HuanLink and A2A task IDs", async () => {
    const channel = new ControlledChannel();
    const store = new InMemoryConversationStore();
    const model = new DelegateThenSummarizeModel();
    const transport = new ControlledTransport();
    const logger = new RecordingRuntimeLogger();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds("run-phase4-initial", "run-phase4-reentry"),
      store,
      logger
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(message("ambient", { text: "keep the API stable" }));
    await channel.emit(
      message("trigger", {
        text: "@<10001> update the adapter",
        trigger: { kind: "mention", text: "update the adapter" }
      })
    );
    const submitted = await transport.submitted.promise;
    await waitForSendCount(channel, 1);

    const [agentCall] = runtime.agentCalls.listByRunId("run-phase4-initial");
    expect(agentCall).toBeDefined();
    expect(channel.sent[0]).toEqual({
      conversationId: TARGET_GROUP,
      text: expect.stringContaining("Codex task accepted by MainAgent.")
    });
    expect(channel.sent[0]?.text).toContain(
      `HuanLink taskId: ${agentCall?.agentCallId}`
    );
    expect(channel.sent[0]?.text).toContain(`A2A taskId: ${transport.taskId}`);
    expect(countOccurrences(channel.sent[0]?.text ?? "", "HuanLink taskId:"))
      .toBe(1);
    expect(countOccurrences(channel.sent[0]?.text ?? "", "A2A taskId:"))
      .toBe(1);
    expect(submitted.contextId).toBe(SESSION_ID);
    expect(agentCall?.sessionId).toBe(SESSION_ID);
    expect(
      store.getMessages(SESSION_ID).map((item) => item.messageId)
    ).toEqual(["ambient", "trigger"]);
    const initialInput = JSON.stringify(model.requests[0]?.input);
    expect(initialInput).toContain("keep the API stable");
    expect(initialInput).toContain("update the adapter");
    expect(initialInput).toContain(
      "Current explicit request:\\nupdate the adapter"
    );

    transport.completion.resolve();
    await waitForSendCount(channel, 2);

    const expectedCorrelation = {
      sessionId: SESSION_ID,
      agentCallId: agentCall!.agentCallId,
      a2aTaskId: transport.taskId,
      contextId: "a2a-context-phase4"
    };
    expect(logger.find("qq.message.accepted")).toMatchObject({
      fields: {
        sessionId: SESSION_ID,
        messageId: "ambient",
        conversationId: TARGET_GROUP,
        senderId: "30003"
      }
    });
    expect(
      logger.filter("main_agent.run.started").map((entry) => entry.fields)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: SESSION_ID,
          runId: "run-phase4-initial",
          trigger: "user"
        }),
        expect.objectContaining({
          sessionId: SESSION_ID,
          runId: "run-phase4-reentry",
          trigger: "agent_call_terminal"
        })
      ])
    );
    expect(logger.find("qq.reply.sent")).toMatchObject({
      fields: {
        sessionId: SESSION_ID,
        runId: "run-phase4-initial",
        messageId: "trigger",
        trigger: "mention",
        agentCalls: [
          {
            agentCallId: agentCall!.agentCallId,
            a2aTaskId: transport.taskId,
            contextId: "a2a-context-phase4"
          }
        ]
      }
    });
    expect(logger.find("main_agent.reentry.context_ready")).toMatchObject({
      fields: {
        ...expectedCorrelation,
        runId: "run-phase4-reentry",
        trigger: "agent_call_terminal"
      }
    });
    expect(logger.find("main_agent.reentry.completed")).toMatchObject({
      fields: {
        ...expectedCorrelation,
        runId: "run-phase4-reentry",
        trigger: "agent_call_terminal"
      }
    });
    expect(logger.find("main_agent.reentry.egress.sent")).toMatchObject({
      fields: {
        ...expectedCorrelation,
        runId: "run-phase4-reentry",
        trigger: "agent_call_terminal"
      }
    });
  });

  test("keeps receiving group context while Codex works and uses it for terminal re-entry", async () => {
    const channel = new ControlledChannel();
    const model = new DelegateThenSummarizeModel(true);
    const transport = new ControlledTransport();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds(
        "run-pending",
        "run-terminal",
        "run-follow-up-terminal"
      )
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("trigger", {
        text: "/huanlink change the parser",
        trigger: { kind: "command", text: "change the parser" }
      })
    );
    await transport.submitted.promise;
    await waitForSendCount(channel, 1);

    await expect(
      channel.emit(
        message("follow-up", {
          senderId: "40004",
          senderName: "Bob",
          text: "after this completes, run the connection check without asking me"
        })
      )
    ).resolves.toBeUndefined();
    expect(runtime.conversations.formatLatestContext(SESSION_ID)).toContain(
      "after this completes, run the connection check without asking me"
    );

    transport.completion.resolve();
    await waitForSendCount(channel, 2);

    expect(channel.sent.map((sent) => sent.conversationId)).toEqual([
      TARGET_GROUP,
      TARGET_GROUP
    ]);
    const [followUp] = runtime.agentCalls.listByRunId("run-terminal");
    expect(followUp).toBeDefined();
    expect(followUp?.executionMode).toBe("async");
    expect(channel.sent[1]?.text).toContain(
      "The first task completed and the authorized follow-up was accepted."
    );
    expect(channel.sent[1]?.text).toContain(
      `HuanLink taskId: ${followUp?.agentCallId}`
    );
    expect(channel.sent[1]?.text).toContain(
      `A2A taskId: ${transport.taskId}-follow-up`
    );
    const contextAfterCompletion = runtime.conversations.formatLatestContext(
      SESSION_ID
    );
    expect(contextAfterCompletion).toContain(
      `HuanLink: ${channel.sent[0]!.text}`
    );
    expect(contextAfterCompletion).toContain(
      `HuanLink: ${channel.sent[1]!.text}`
    );
    expect(contextAfterCompletion.indexOf(`HuanLink: ${channel.sent[0]!.text}`))
      .toBeLessThan(
        contextAfterCompletion.indexOf(`HuanLink: ${channel.sent[1]!.text}`)
      );
    const terminalInput = JSON.stringify(model.requests[2]?.input);
    expect(terminalInput).toContain(
      "after this completes, run the connection check without asking me"
    );
    expect(model.requests).toHaveLength(4);
    expect(model.requests[2]?.tools.map(({ name }) => name)).toEqual([
      SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
    ]);
    transport.followUpCompletion.resolve();
    await waitForSendCount(channel, 3);
    await runtime.agentCalls.waitForIdle();
    expect(transport.submissions).toHaveLength(2);
    expect(channel.sendCalls).toHaveLength(3);
  });

  test("ignores even triggered messages from groups outside the configured target", async () => {
    const channel = new ControlledChannel();
    const model = new IdleModel();
    const logger = new RecordingRuntimeLogger();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(model),
      logger
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("other-ordinary", {
        conversationId: OTHER_GROUP,
        text: "off-target ambient context"
      })
    );
    await channel.emit(
      message("other-group", {
        conversationId: OTHER_GROUP,
        trigger: { kind: "mention", text: "do not run this" }
      })
    );

    expect(
      runtime.conversations.getMessages(`onebot11:group:${OTHER_GROUP}`)
    ).toEqual([]);
    expect(model.requests).toHaveLength(0);
    expect(channel.sent).toEqual([]);
    expect(logger.filter("qq.message.ignored")).toHaveLength(2);
    expect(logger.filter("qq.message.ignored")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "debug",
          fields: expect.objectContaining({
            conversationId: OTHER_GROUP,
            reason: "non_target_conversation"
          })
        })
      ])
    );
  });

  test("does not let an immediate terminal reply overtake the initial task receipt", async () => {
    const channel = new ControlledChannel(true);
    const model = new DelegateThenSummarizeModel();
    const transport = new ControlledTransport("a2a-immediate", true);
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds("run-immediate", "run-immediate-terminal")
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("immediate", {
        trigger: { kind: "command", text: "complete immediately" }
      })
    );
    await vi.waitFor(() => expect(channel.sendCalls).toHaveLength(1));
    try {
      expect(model.requests).toHaveLength(2);
      expect(channel.sendCalls).toHaveLength(1);
    } finally {
      channel.firstSendRelease.resolve();
    }
    await waitForSendCount(channel, 2);

    expect(model.requests).toHaveLength(3);
    expect(channel.sent[0]?.text).toContain("HuanLink taskId:");
    expect(channel.sent[1]?.text).toBe(
      "Codex task completed with the latest context."
    );
  });

  test("waits for the initial receipt to be sent and recorded before paused re-entry starts", async () => {
    const channel = new ControlledChannel(true);
    const model = new DelegateThenSummarizeModel();
    const transport = new PausingTransport();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds("run-paused-initial", "run-paused-reentry")
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("pause-after-receipt", {
        trigger: { kind: "command", text: "pause for one choice" }
      })
    );
    await transport.pausePublished.promise;
    await vi.waitFor(() => expect(channel.sendCalls).toHaveLength(1));

    try {
      expect(model.requests).toHaveLength(2);
    } finally {
      channel.firstSendRelease.resolve();
    }
    await waitForSendCount(channel, 2);
    const [agentCall] = runtime.agentCalls.listByRunId("run-paused-initial");
    const pausedInput = JSON.stringify(model.requests[2]?.input);

    expect(pausedInput).toContain("Codex task accepted by MainAgent.");
    expect(pausedInput).toContain(`HuanLink taskId: ${agentCall!.agentCallId}`);
    expect(pausedInput).toContain(`A2A taskId: ${transport.taskId}`);
    expect(channel.sent[0]?.text).toContain("HuanLink taskId:");
    expect(channel.sent[1]?.text).toBe(
      "Codex task completed with the latest context."
    );
  });

  test("reports detached MainAgent failures instead of rejecting channel ingress", async () => {
    const channel = new ControlledChannel();
    const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(new ThrowingModel()),
      onBackgroundError
    });
    runtimes.push(runtime);

    await runtime.start();
    await expect(
      channel.emit(
        message("failure", {
          trigger: { kind: "mention", text: "this run will fail" }
        })
      )
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());

    expect(onBackgroundError.mock.calls[0]?.[0].message).toContain(
      "MainAgent failed before replying"
    );
    expect(channel.sent).toEqual([]);
  });

  test("does not record a failed send and releases the session for the next turn", async () => {
    const channel = new RejectFirstSendChannel();
    const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
    const logger = new RecordingRuntimeLogger();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(new BoundReplyModel()),
      onBackgroundError,
      logger
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("failed-send", {
        trigger: { kind: "command", text: "this reply will fail" }
      })
    );
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());

    const failedReply = logger
      .filter("qq.reply.failed")
      .find((entry) => entry.fields.messageId === "failed-send");
    expect(failedReply).toMatchObject({
      level: "error",
      fields: {
        sessionId: SESSION_ID,
        runId: expect.any(String),
        messageId: "failed-send",
        conversationId: TARGET_GROUP,
        trigger: "command"
      }
    });
    expect(
      logger
        .filter("qq.reply.sent")
        .some((entry) => entry.fields.runId === failedReply?.fields.runId)
    ).toBe(false);

    expect(runtime.conversations.formatLatestContext(SESSION_ID)).toBe(
      "Alice: message failed-send"
    );

    await channel.emit(
      message("successful-send", {
        trigger: { kind: "command", text: "this reply should pass" }
      })
    );
    await waitForSendCount(channel, 1);

    expect(runtime.conversations.formatLatestContext(SESSION_ID)).toContain(
      "HuanLink: MainAgent used the injected model binding."
    );
  });

  test("aborts supervised runs and removes channel ingress during shutdown", async () => {
    const channel = new ControlledChannel();
    const started = deferred();
    const aborted = deferred();
    let runCount = 0;
    const logger = new RecordingRuntimeLogger();
    const abortableRunner: OpenAiAgentsRunner = {
      run(_agent, _input, options) {
        runCount += 1;
        started.resolve();
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (signal === undefined) {
            reject(new Error("Expected a Phase 4 abort signal"));
            return;
          }
          const rejectAborted = () => {
            aborted.resolve();
            reject(signal.reason ?? new Error("aborted"));
          };
          if (signal.aborted) {
            rejectAborted();
            return;
          }
          signal.addEventListener("abort", rejectAborted, { once: true });
        });
      }
    };
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: abortableRunner,
      logger
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("shutdown-trigger", {
        trigger: { kind: "command", text: "keep running" }
      })
    );
    await started.promise;
    await expect(runtime.close()).resolves.toBeUndefined();
    await aborted.promise;

    await channel.emit(
      message("after-close", {
        trigger: { kind: "mention", text: "must be ignored" }
      })
    );
    expect(runCount).toBe(1);
    expect(channel.closeCalls).toBe(1);
    expect(channel.sent).toEqual([]);
    expect(logger.find("main_agent.run.aborted")).toMatchObject({
      level: "debug",
      fields: {
        sessionId: SESSION_ID,
        runId: expect.any(String),
        trigger: "user"
      }
    });
    expect(logger.find("main_agent.run.failed")).toBeUndefined();
  });

  test("closes the channel before waiting for a pending receipt send", async () => {
    const channel = new CloseReleasesSendChannel();
    const logger = new RecordingRuntimeLogger();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: {
        run: async () => ({ finalOutput: "receipt waiting on channel close" })
      },
      logger
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("pending-send", {
        trigger: { kind: "command", text: "start a local reply" }
      })
    );
    await channel.sendStarted.promise;

    const close = runtime.close();
    const settledPromptly = await Promise.race([
      close.then(() => true),
      delay(100).then(() => false)
    ]);
    if (!settledPromptly) {
      channel.forceRelease();
    }
    await close;

    expect(settledPromptly).toBe(true);
    expect(channel.closeCalls).toBe(1);
    expect(logger.find("qq.reply.aborted")).toMatchObject({ level: "debug" });
    expect(logger.find("qq.reply.failed")).toBeUndefined();
  });

  test("rejects a start that finishes after shutdown and all later starts", async () => {
    const channel = new DeferredStartChannel();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: idleTransport(),
      runner: runner(new IdleModel())
    });
    runtimes.push(runtime);

    const start = runtime.start();
    await channel.startEntered.promise;
    await runtime.close();
    channel.startRelease.resolve();

    await expect(start).rejects.toThrow(/closed/i);
    await expect(runtime.start()).rejects.toThrow(/closed/i);
    expect(channel.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

async function waitUntilReleased(
  release: Promise<void>,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void release.then(() => {
      cleanup();
      resolve(true);
    });
  });
}

function countOccurrences(input: string, needle: string): number {
  return input.split(needle).length - 1;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
