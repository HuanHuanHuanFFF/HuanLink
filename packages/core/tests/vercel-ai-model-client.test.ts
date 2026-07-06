import { describe, expect, test, vi } from "vitest";
import {
  generateText as aiGenerateText,
  simulateReadableStream,
  streamText as aiStreamText,
  tool
} from "ai";
import { z } from "zod";

import { VercelAiModelClient } from "../src/model/vercel-ai-model-client.js";

type GenerateTextResult = Pick<
  Awaited<ReturnType<typeof aiGenerateText>>,
  "responseMessages"
>;
type StreamTextResult = Pick<
  ReturnType<typeof aiStreamText>,
  "stream" | "responseMessages"
>;
type StreamPart = StreamTextResult["stream"] extends AsyncIterable<infer Part>
  ? Part
  : never;

const EMPTY_USAGE = {
  inputTokens: undefined,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined
  },
  outputTokens: undefined,
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined
  },
  totalTokens: undefined
};

describe("VercelAiModelClient", () => {
  test("complete passes only declarative tool definitions into AI SDK and mirrors tool calls onto the assistant message", async () => {
    const generateText = vi.fn(
      async (_input: unknown): Promise<GenerateTextResult> => ({
        responseMessages: [
          {
            role: "assistant" as const,
            content: [
              {
                type: "text" as const,
                text: "Calling echo"
              },
              {
                type: "tool-call" as const,
                toolCallId: "call_echo_01",
                toolName: "echo",
                input: {
                  text: "hello from sdk"
                }
              }
            ]
          }
        ]
      })
    );
    const echoTool = tool({
      description: "Echo text back to the caller",
      inputSchema: z.object({
        text: z.string()
      }),
      execute: async ({ text }) => text
    });
    const client = new VercelAiModelClient(
      {
        model: { id: "test-model" } as never,
        maxOutputTokens: 256,
        temperature: 0.2,
        tools: {
          echo: echoTool
        }
      },
      {
        generateText
      }
    );

    const response = await client.complete({
      runId: "run_01",
      sessionId: "session_01",
      messages: [
        {
          role: "system",
          content: "You are a focused runtime."
        },
        {
          role: "user",
          content: "Say hello"
        }
      ]
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      model: {
        id: "test-model"
      },
      system: "You are a focused runtime.",
      maxOutputTokens: 256,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ],
      tools: {
        echo: expect.objectContaining({
          description: "Echo text back to the caller"
        })
      }
    });
    const sdkInput = generateText.mock.calls[0]?.[0] as {
      tools: {
        echo: Record<string, unknown>;
      };
    };
    const sdkTools = sdkInput.tools as {
      echo: Record<string, unknown>;
    };
    expect(sdkTools.echo).not.toBe(echoTool);
    expect(sdkTools.echo.execute).toBeUndefined();
    expect(response).toEqual({
      message: {
        role: "assistant",
        content: "Calling echo",
        toolCalls: [
          {
            id: "call_echo_01",
            name: "echo",
            args: {
              text: "hello from sdk"
            }
          }
        ]
      }
    });
  });

  test("complete rebuilds tool context from assistant message toolCalls instead of client-side run caches", async () => {
    const generateText = vi.fn(
      async (_input: unknown): Promise<GenerateTextResult> => ({
        responseMessages: [
          {
            role: "assistant" as const,
            content: "Final answer: hello from sdk"
          }
        ]
      })
    );
    const client = new VercelAiModelClient(
      {
        model: { id: "test-model" } as never
      },
      {
        generateText
      }
    );

    const response = await client.complete({
      runId: "run_02",
      sessionId: "session_02",
      messages: [
        {
          role: "user",
          content: "Say hello"
        },
        {
          role: "assistant",
          content: "Calling echo",
          toolCalls: [
            {
              id: "call_echo_01",
              name: "echo",
              args: {
                text: "hello from sdk"
              }
            }
          ]
        },
        {
          role: "tool",
          content: "hello from sdk",
          toolCallId: "call_echo_01",
          toolName: "echo"
        }
      ]
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        {
          role: "user",
          content: "Say hello"
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Calling echo"
            },
            {
              type: "tool-call",
              toolCallId: "call_echo_01",
              toolName: "echo",
              input: {
                text: "hello from sdk"
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_echo_01",
              toolName: "echo",
              output: {
                type: "text",
                value: "hello from sdk"
              }
            }
          ]
        }
      ]
    });
    expect(response).toEqual({
      message: {
        role: "assistant",
        content: "Final answer: hello from sdk"
      }
    });
  });

  test("stream passes only declarative tool definitions into AI SDK and emits only text-delta, tool-call, and finish events", async () => {
    const streamText = vi.fn(
      (_input: unknown): StreamTextResult => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [
            {
              type: "text-start",
              id: "msg_01"
            },
            {
              type: "text-delta",
              id: "msg_01",
              text: "Calling "
            },
            {
              type: "tool-input-start",
              id: "call_echo_01",
              toolName: "echo"
            },
            {
              type: "tool-input-delta",
              id: "call_echo_01",
              delta: "{\"text\":\"hello from sdk\"}"
            },
            {
              type: "tool-input-end",
              id: "call_echo_01"
            },
            {
              type: "tool-call",
              toolCallId: "call_echo_01",
              toolName: "echo",
              input: {
                text: "hello from sdk"
              }
            },
            {
              type: "tool-result",
              toolCallId: "call_echo_01",
              toolName: "echo",
              input: {
                text: "hello from sdk"
              },
              output: "hello from sdk"
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              rawFinishReason: "tool-calls",
              totalUsage: EMPTY_USAGE
            },
            {
              type: "text-end",
              id: "msg_01"
            }
          ]
        }),
        responseMessages: Promise.resolve([
          {
            role: "assistant" as const,
            content: [
              {
                type: "text" as const,
                text: "Calling echo"
              },
              {
                type: "tool-call" as const,
                toolCallId: "call_echo_01",
                toolName: "echo",
                input: {
                  text: "hello from sdk"
                }
              }
            ]
          }
        ])
      })
    );
    const echoTool = tool({
      description: "Echo text back to the caller",
      inputSchema: z.object({
        text: z.string()
      }),
      execute: async ({ text }) => text
    });
    const client = new VercelAiModelClient(
      {
        model: { id: "test-model" } as never,
        tools: {
          echo: echoTool
        }
      },
      {
        streamText
      }
    );
    const events = [];

    for await (const event of client.stream({
      runId: "run_03",
      sessionId: "session_03",
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ]
    })) {
      events.push(event);
    }

    const streamInput = streamText.mock.calls[0]?.[0] as {
      tools: {
        echo: Record<string, unknown>;
      };
    };
    const sdkTools = streamInput.tools as {
      echo: Record<string, unknown>;
    };
    expect(sdkTools.echo).not.toBe(echoTool);
    expect(sdkTools.echo.execute).toBeUndefined();
    expect(events).toEqual([
      {
        type: "text-delta",
        text: "Calling "
      },
      {
        type: "tool-call",
        toolCall: {
          id: "call_echo_01",
          name: "echo",
          args: {
            text: "hello from sdk"
          }
        }
      },
      {
        type: "finish",
        response: {
          message: {
            role: "assistant",
            content: "Calling echo",
            toolCalls: [
              {
                id: "call_echo_01",
                name: "echo",
                args: {
                  text: "hello from sdk"
                }
              }
            ]
          }
        }
      }
    ]);
  });
});
