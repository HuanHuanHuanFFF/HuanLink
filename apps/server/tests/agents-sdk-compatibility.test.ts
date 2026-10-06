import { Agent, ModelTimeoutError, Runner, tool } from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { createDeepSeekMainAgentModelBinding } from "../src/main-agent-model.js";

const config = {
  provider: "deepseek" as const,
  modelId: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com/beta",
  apiKey: "test-api-key",
};

function segmentedModel(parts: string[]) {
  const doGenerate = vi.fn(async () => ({
    content: parts.map((text) => ({ type: "text" as const, text })),
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
    warnings: [],
  }));
  return {
    doGenerate,
    model: aisdk({
      specificationVersion: "v3",
      provider: "controlled-provider",
      modelId: "segmented-model",
      supportedUrls: {},
      doGenerate,
      doStream: async () => {
        throw new Error("Unexpected streaming request");
      },
    }),
  };
}

function finalTextResponse() {
  return Response.json({
    id: "sdk-compatibility-response",
    created: 1,
    model: config.modelId,
    choices: [
      {
        message: { role: "assistant", content: "done" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

describe("Agents SDK compatibility through the AI SDK bridge", () => {
  test("preserves every adjacent text segment in the final output", async () => {
    const { model } = segmentedModel(["first ", "second ", "third"]);
    const agent = new Agent({ name: "Segmented text", model });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      "read",
    );

    expect(result.finalOutput).toBe("first second third");
  });

  test("parses structured output split across multiple provider text segments", async () => {
    const { model, doGenerate } = segmentedModel([
      '{"taskId":"task-sdk",',
      '"state":"completed"}',
    ]);
    const agent = new Agent({
      name: "Structured segments",
      model,
      outputType: z.object({
        taskId: z.string(),
        state: z.literal("completed"),
      }),
    });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      "read",
    );

    expect(result.finalOutput).toEqual({
      taskId: "task-sdk",
      state: "completed",
    });
    expect(doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: expect.objectContaining({ type: "json" }),
      }),
    );
  });

  test("preserves an explicit non-strict tool schema in the DeepSeek request", async () => {
    const requests: Record<string, unknown>[] = [];
    const binding = createDeepSeekMainAgentModelBinding({
      config,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return finalTextResponse();
      },
    });
    const agent = new Agent({
      name: "Non-strict schema",
      ...binding,
      tools: [
        tool({
          name: "read_label",
          description: "Read a label without changing any task.",
          strict: false,
          parameters: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: true,
          },
          execute: () => "label",
        }),
      ],
    });
    await new Runner({ tracingDisabled: true }).run(agent, "read");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ strict: false }),
      }),
    ]);
  });

  test("keeps text and tool calls from one DeepSeek response together before the tool result", async () => {
    const requests: Record<string, unknown>[] = [];
    const execute = vi.fn(({ label }: { label: string }) => label);
    const binding = createDeepSeekMainAgentModelBinding({
      config,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length === 1) {
          return Response.json({
            id: "mixed-text-tool-response",
            created: 1,
            model: config.modelId,
            choices: [
              {
                message: {
                  role: "assistant",
                  reasoning_content: "Read the label once.",
                  content: "Reading the label.",
                  tool_calls: [
                    {
                      id: "call-mixed-text",
                      type: "function",
                      function: {
                        name: "read_label",
                        arguments: JSON.stringify({ label: "sdk" }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          });
        }
        if (requests.length !== 2) throw new Error("Unexpected model retry");
        return finalTextResponse();
      },
    });
    const agent = new Agent({
      name: "Mixed text and tool call",
      ...binding,
      tools: [
        tool({
          name: "read_label",
          description: "Read a label once.",
          parameters: z.object({ label: z.string() }),
          execute,
        }),
      ],
    });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      "read",
    );
    const messages = requests[1]?.messages as Record<string, unknown>[];

    expect(result.finalOutput).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({
        role: "assistant",
        content: "Reading the label.",
        reasoning_content: "Read the label once.",
        tool_calls: [expect.objectContaining({ id: "call-mixed-text" })],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-mixed-text",
      }),
    ]);
  });

  test.each(["timeout", "run cancellation"] as const)(
    "aborts the DeepSeek request on %s without starting another model call or tool",
    async (mode) => {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const fakeFetch: typeof fetch = vi.fn(async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        if (!requestSignal) throw new Error("Expected provider AbortSignal");
        resolveStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = requestSignal!;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      });
      const execute = vi.fn(() => "unexpected task submission");
      const binding = createDeepSeekMainAgentModelBinding({
        config,
        fetch: fakeFetch,
      });
      const agent = new Agent({
        name: "Abortable DeepSeek call",
        ...binding,
        modelSettings: {
          ...binding.modelSettings,
          ...(mode === "timeout" ? { timeoutMs: 25 } : {}),
        },
        tools: [
          tool({
            name: "submit_task",
            description: "Submit a task only after a model tool call.",
            parameters: z.object({ task: z.string() }),
            execute,
          }),
        ],
      });
      const controller = new AbortController();
      const failure = new Error("HuanLink user canceled the run");
      const pending = new Runner({ tracingDisabled: true }).run(
        agent,
        "submit",
        {
          signal: controller.signal,
        },
      );
      const rejected =
        mode === "timeout"
          ? expect(pending).rejects.toBeInstanceOf(ModelTimeoutError)
          : expect(pending).rejects.toThrow(failure.message);
      await started;
      if (mode === "run cancellation") controller.abort(failure);
      await rejected;

      expect(requestSignal?.aborted).toBe(true);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
