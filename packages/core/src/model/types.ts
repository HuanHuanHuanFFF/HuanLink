import type { RunId, SessionId } from "../shared/ids.js";
import type { ToolCall } from "../tools/types.js";

export type SystemModelMessage = {
  role: "system";
  content: string;
};

export type UserModelMessage = {
  role: "user";
  content: string;
};

export type AssistantModelMessage = {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
};

export type ToolModelMessage = {
  role: "tool";
  content: string;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
};

export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage;

export type ModelResponse = {
  message: AssistantModelMessage;
};

export type ModelStreamEvent =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "tool-call";
      toolCall: ToolCall;
    }
  | {
      type: "finish";
      response: ModelResponse;
    };

export type ModelClient = {
  complete(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
};

export type StreamingModelClient = ModelClient & {
  stream(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelStreamEvent>;
};
