export const CORE_SCHEMA_VERSION = 1;

export type CoreSchemaVersion = typeof CORE_SCHEMA_VERSION;

export type RunId = string;

export type SessionId = string;

export type AgentEvent = {
  schemaVersion: CoreSchemaVersion;
  type: string;
  runId: RunId;
  sessionId: SessionId;
  timestamp: string;
  data?: Record<string, unknown>;
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolResult = {
  callId: string;
  output: string;
  metadata?: Record<string, unknown>;
};

export type ModelResponse = {
  message: ModelMessage;
  toolCalls?: ToolCall[];
};

export type ModelClient = {
  complete(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
  }): Promise<ModelResponse>;
};

export type PolicyDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "requires_approval"; reason: string };
