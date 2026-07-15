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
  CONTINUE_TASK_TOOL_NAME,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
} from "@huanlink/integration-openai-agents";
import {
  type AgentCallInvocationResult,
  type AgentCallTransport,
  type AgentCallTransportContinueRequest,
  type AgentCallTransportSubmitRequest,
  type ChannelAdapter,
  type ChannelMessageListener,
  type InboundChannelMessage
} from "@huanlink/core";
import { expect, vi } from "vitest";

export const TARGET_GROUP = "20002";
export const SESSION_ID = `onebot11:group:${TARGET_GROUP}`;

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class BlockSendAtIndexChannel implements ChannelAdapter {
  readonly channel = "onebot11" as const;
  readonly sendCalls: Array<{ conversationId: string; text: string }> = [];
  readonly sent: Array<{ conversationId: string; text: string }> = [];
  readonly blockedSendStarted = deferred();
  private readonly blockedSendRelease = deferred();
  private readonly listeners = new Set<ChannelMessageListener>();

  constructor(private readonly blockedIndex: number) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.blockedSendRelease.resolve();
  }

  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const callIndex = this.sendCalls.length;
    const output = { conversationId, text };
    this.sendCalls.push(output);
    if (callIndex === this.blockedIndex) {
      this.blockedSendStarted.resolve();
      await this.blockedSendRelease.promise;
    }
    this.sent.push(output);
  }

  async emit(message: InboundChannelMessage): Promise<void> {
    await Promise.all(
      [...this.listeners].map((listener) => Promise.resolve(listener(message)))
    );
  }

  releaseBlockedSend(): void {
    this.blockedSendRelease.resolve();
  }
}

export class RejectSendAtIndexChannel extends BlockSendAtIndexChannel {
  constructor(private readonly rejectedIndex: number) {
    super(-1);
  }

  override async sendText(
    conversationId: string,
    text: string
  ): Promise<void> {
    const callIndex = this.sendCalls.length;
    const output = { conversationId, text };
    this.sendCalls.push(output);
    if (callIndex === this.rejectedIndex) {
      throw new Error(`QQ send ${callIndex} failed`);
    }
    this.sent.push(output);
  }
}

export class ImmediateResumeTransport implements AgentCallTransport {
  readonly taskId = "a2a-task-egress-ordering";
  readonly contextId = "a2a-context-egress-ordering";
  readonly submitTask = vi.fn<AgentCallTransport["submitTask"]>(
    async (request: AgentCallTransportSubmitRequest) => ({
      taskId: this.taskId,
      contextId: request.contextId,
      state: "working",
      artifacts: []
    })
  );
  readonly continueTask = vi.fn<AgentCallTransport["continueTask"]>(
    async (request: AgentCallTransportContinueRequest) => ({
      taskId: request.taskId,
      contextId: request.contextId,
      state: "working",
      artifacts: []
    })
  );
  private watchCount = 0;

  async discoverCapability(skillId: string) {
    return { id: skillId, name: "Codex code task" };
  }

  async *watchTask(currentTaskId: string) {
    this.watchCount += 1;
    if (this.watchCount === 1) {
      yield {
        taskId: currentTaskId,
        contextId: this.contextId,
        state: "input-required" as const,
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
                description: "Preserve the current contract."
              }
            ],
            question: "Which approach should Codex use?"
          }
        ],
        artifacts: []
      };
      return;
    }

    yield {
      taskId: currentTaskId,
      contextId: this.contextId,
      state: "completed" as const,
      artifacts: [
        {
          id: "artifact-egress-ordering",
          text: "The safe approach was completed."
        }
      ]
    };
  }

  async cancelTask(taskId: string) {
    return { taskId, state: "canceled" as const, artifacts: [] };
  }
}

abstract class ResumableTaskModel implements Model {
  readonly requests: ModelRequest[] = [];
  protected huanLinkTaskId: string | undefined;

  abstract responseForRequest(request: ModelRequest): ModelResponse;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 2) {
      this.huanLinkTaskId = acceptedAgentCallId(request);
    }
    return this.responseForRequest(request);
  }

  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }

  protected continueTaskCall(callId: string): ModelResponse {
    if (this.huanLinkTaskId === undefined) {
      throw new Error("Expected the original HuanLink task ID");
    }
    return {
      usage: new Usage(),
      output: [
        {
          type: "function_call",
          callId,
          name: CONTINUE_TASK_TOOL_NAME,
          arguments: JSON.stringify({
            taskId: this.huanLinkTaskId,
            answers: [{ questionId: "approach", answers: ["Safe"] }]
          })
        }
      ]
    };
  }
}

export class AutoContinuePausedModel extends ResumableTaskModel {
  responseForRequest(_request: ModelRequest): ModelResponse {
    switch (this.requests.length) {
      case 1:
        return submitTaskCall("auto-submit");
      case 2:
        return assistantResponse("The task was accepted.");
      case 3:
        return this.continueTaskCall("auto-continue");
      case 4:
        return assistantResponse(
          "The paused task was automatically continued."
        );
      default:
        return assistantResponse(
          "The automatically continued task completed."
        );
    }
  }
}

export class AskThenContinuePausedModel extends ResumableTaskModel {
  responseForRequest(_request: ModelRequest): ModelResponse {
    switch (this.requests.length) {
      case 1:
        return submitTaskCall("answer-submit");
      case 2:
        return assistantResponse("The task was accepted.");
      case 3:
        return assistantResponse("Which approach should Codex use?");
      case 4:
        return this.continueTaskCall("answer-continue");
      case 5:
        return assistantResponse("The user's answer continued the task.");
      default:
        return assistantResponse("The user-continued task completed.");
    }
  }
}

export class PauseThenRecoverModel extends ResumableTaskModel {
  responseForRequest(_request: ModelRequest): ModelResponse {
    switch (this.requests.length) {
      case 1:
        return submitTaskCall("reentry-send-failure-submit");
      case 2:
        return assistantResponse("The pausing task was accepted.");
      case 3:
        return assistantResponse("This paused re-entry send must fail.");
      default:
        return assistantResponse("The later user turn succeeded.");
    }
  }
}

class SingleModelProvider implements ModelProvider {
  constructor(private readonly model: Model) {}

  getModel(): Model {
    return this.model;
  }
}

export function runner(model: Model): Runner {
  return new Runner({
    modelProvider: new SingleModelProvider(model),
    tracingDisabled: true
  });
}

export function message(
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

export function runIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `run-extra-${index}`;
}

export async function waitForSentCount(
  channel: BlockSendAtIndexChannel,
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(channel.sent).toHaveLength(count), {
    timeout: 1_000
  });
}

function submitTaskCall(callId: string): ModelResponse {
  return {
    usage: new Usage(),
    output: [
      {
        type: "function_call",
        callId,
        name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
        arguments: JSON.stringify({ task: "make one resumable code change" })
      }
    ]
  };
}

function assistantResponse(text: string): ModelResponse {
  return {
    usage: new Usage(),
    output: [
      {
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
      }
    ]
  };
}

function acceptedAgentCallId(request: ModelRequest): string {
  if (!Array.isArray(request.input)) {
    throw new Error("Expected an AgentCall tool continuation request");
  }
  const resultItem = request.input.find(
    (item) => item.type === "function_call_result"
  );
  if (
    resultItem === undefined ||
    resultItem.name !== SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
  ) {
    throw new Error("Expected an AgentCall function result");
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
  const result = JSON.parse(text) as AgentCallInvocationResult;
  if (result.status !== "accepted") {
    throw new Error(`Expected an accepted AgentCall, received ${result.status}`);
  }
  return result.agentCallId;
}
