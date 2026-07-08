// 验证 OpenAI Agents 适配器能用真实 Runner 配合 mock 模型跑通文本 run。
import { describe, expect, test } from "vitest";

import { Agent, Runner, Usage } from "@openai/agents";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent
} from "@openai/agents";

import { OpenAiAgentsRuntime } from "../src/index.js";

// 构造最小 assistant message，供 mock 模型复用。
function createAssistantMessage(text: string): ModelResponse["output"][number] {
  return {
    id: "msg_mock_01",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        providerData: {
          annotations: []
        }
      }
    ]
  };
}

// 提供固定文本输出的最小 mock Model。
class MockTextModel implements Model {
  constructor(
    private readonly text: string,
    private readonly seenSignals: AbortSignal[] = []
  ) {}

  // 记录 signal，并返回一次固定文本响应。
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal) {
      this.seenSignals.push(request.signal);
    }

    return {
      usage: new Usage(),
      output: [createAssistantMessage(this.text)]
    };
  }

  // 当前 spike 不覆盖流式路径。
  async *getStreamedResponse(
    _request: ModelRequest
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not implemented in this test model");
  }
}

// 用固定 mock Model 实现最小 ModelProvider。
class MockTextModelProvider implements ModelProvider {
  constructor(private readonly model: Model) {}

  // 返回测试注入的 mock Model。
  getModel(): Model {
    return this.model;
  }
}

describe("OpenAiAgentsRuntime", () => {
  // 验证真实 SDK 主循环能被适配为 Core 文本结果。
  test("runs a real Agent and Runner through a custom ModelProvider", async () => {
    const runtime = new OpenAiAgentsRuntime({
      agent: new Agent({
        name: "MockAgent",
        instructions: "Return the mock text output.",
        model: "mock-text-model"
      }),
      runner: new Runner({
        modelProvider: new MockTextModelProvider(
          new MockTextModel("hello from openai agents runtime")
        ),
        tracingDisabled: true
      })
    });

    const result = await runtime.run({
      runId: "run_openai_agents_01",
      sessionId: "session_openai_agents_01",
      input: "ping"
    });

    expect(result).toEqual({
      output: "hello from openai agents runtime"
    });
  });

  // 验证 AbortSignal 会沿着适配器传到模型请求。
  test("passes AbortSignal through the Runner to the model request", async () => {
    const seenSignals: AbortSignal[] = [];
    const abortController = new AbortController();
    const runtime = new OpenAiAgentsRuntime({
      agent: new Agent({
        name: "MockAgentWithSignal",
        instructions: "Return the mock text output.",
        model: "mock-text-model"
      }),
      runner: new Runner({
        modelProvider: new MockTextModelProvider(
          new MockTextModel("signal observed", seenSignals)
        ),
        tracingDisabled: true
      })
    });

    const result = await runtime.run({
      runId: "run_openai_agents_signal_01",
      sessionId: "session_openai_agents_signal_01",
      input: "ping",
      signal: abortController.signal
    });

    expect(result.output).toBe("signal observed");
    expect(seenSignals).toEqual([abortController.signal]);
  });

  // 验证非文本输出会被适配器明确拒绝。
  test("throws when the runner result does not resolve to text output", async () => {
    const runtime = new OpenAiAgentsRuntime({
      agent: new Agent({
        name: "NonTextAgent",
        instructions: "Return a non-text final output.",
        model: "mock-text-model"
      }),
      runner: {
        run: async () => ({
          finalOutput: {
            answer: "not text"
          }
        })
      }
    });

    await expect(
      runtime.run({
        runId: "run_openai_agents_non_text_01",
        sessionId: "session_openai_agents_non_text_01",
        input: "ping"
      })
    ).rejects.toThrow(
      "OpenAiAgentsRuntime expected a text finalOutput from @openai/agents"
    );
  });
});
