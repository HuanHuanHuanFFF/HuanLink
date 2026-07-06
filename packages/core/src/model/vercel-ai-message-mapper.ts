import type {
  GenerateTextResult,
  ModelMessage as AiSdkModelMessage,
  TextPart,
  TextStreamPart,
  ToolCallPart,
  ToolResultPart,
  ToolSet
} from "ai";

import type {
  AssistantModelMessage,
  ModelMessage,
  ModelResponse,
  ModelStreamEvent
} from "./types.js";
import type { ToolCall } from "../tools/types.js";

// 从 AI SDK 的公开导出推导消息和流事件类型，让 mapper 尽量贴近真实 SDK 合同。
type SdkResponseMessage = GenerateTextResult<
  ToolSet,
  any,
  any
>["responseMessages"][number];
type SdkStreamPart = TextStreamPart<ToolSet>;

export function toVercelAiPrompt(messages: ModelMessage[]): {
  system?: string;
  messages: AiSdkModelMessage[];
} {
  // generateText/streamText 接受的是单个 system 字符串，
  // 所以这里先把多个 system message 压平成一个值。
  const systemMessages: string[] = [];
  const promptMessages: AiSdkModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
      continue;
    }

    if (message.role === "user") {
      promptMessages.push({
        role: "user",
        content: message.content
      });
      continue;
    }

    if (message.role === "assistant") {
      if (!message.toolCalls || message.toolCalls.length === 0) {
        promptMessages.push({
          role: "assistant",
          content: message.content
        });
        continue;
      }

      const content: Array<TextPart | ToolCallPart> = [];

      if (message.content.length > 0) {
        content.push({
          type: "text",
          text: message.content
        });
      }

      for (const toolCall of message.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.args
        });
      }

      promptMessages.push({
        role: "assistant",
        content
      });
      continue;
    }

    promptMessages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: requireString(message.toolCallId, "toolCallId"),
          toolName: requireString(message.toolName, "toolName"),
          output: toToolResultOutput(message.content, message.isError)
        }
      ]
    });
  }

  return {
    ...(systemMessages.length > 0
      ? { system: systemMessages.join("\n\n") }
      : {}),
    messages: promptMessages
  };
}

export function toModelResponse(
  responseMessages: ReadonlyArray<SdkResponseMessage>
): ModelResponse {
  // Huaness 最终只需要把 assistant message 这一层结果交还给 AgentLoop。
  for (let index = responseMessages.length - 1; index >= 0; index -= 1) {
    const responseMessage = responseMessages[index];

    if (responseMessage?.role !== "assistant") {
      continue;
    }

    const toolCalls = readToolCalls(responseMessage.content);
    const message: AssistantModelMessage = {
      role: "assistant",
      content: readAssistantText(responseMessage.content),
      ...(toolCalls.length > 0 ? { toolCalls } : {})
    };

    return { message };
  }

  throw new Error("AI SDK response did not contain an assistant message");
}

export function toModelStreamEvent(
  part: SdkStreamPart
): ModelStreamEvent | undefined {
  // Huaness 有意把 SDK 的流事件面收窄到批准的最小集合：
  // text-delta、tool-call，以及最终的 finish。
  if (part.type === "text-delta") {
    return {
      type: "text-delta",
      text: requireString(part.text, "text")
    };
  }

  if (part.type === "tool-call") {
    return {
      type: "tool-call",
      toolCall: {
        id: requireString(part.toolCallId, "toolCallId"),
        name: requireString(part.toolName, "toolName"),
        args: requireRecord(part.input, "input")
      }
    };
  }

  return undefined;
}

function readAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("");
}

function readToolCalls(content: unknown): ToolCall[] {
  if (typeof content === "string") {
    return [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];

  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-call") {
      continue;
    }

    toolCalls.push({
      id: requireString(part.toolCallId, "toolCallId"),
      name: requireString(part.toolName, "toolName"),
      args: requireRecord(part.input, "input")
    });
  }

  return toolCalls;
}

function toToolResultOutput(
  content: string,
  isError?: boolean
): ToolResultPart["output"] {
  if (isError) {
    return {
      type: "error-text",
      value: content
    };
  }

  return {
    type: "text",
    value: content
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function requireRecord(
  value: unknown,
  fieldName: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
