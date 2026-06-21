// Core 运行链路的共享类型定义。

// 当前 core 事件 schema 版本。
export const CORE_SCHEMA_VERSION = "1.0" as const;

// 事件 schema 版本类型。
export type CoreSchemaVersion = typeof CORE_SCHEMA_VERSION;

// 一次 agent run 的唯一标识。
export type RunId = string;

// 一段会话的唯一标识。
export type SessionId = string;

// 传给模型或由模型返回的消息。
export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

// 模型请求执行工具时给出的结构化调用。
export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// 工具执行后的结构化结果。
export type ToolResult = {
  callId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
};

// 模型单轮响应，可能包含 tool call。
export type ModelResponse = {
  message: ModelMessage;
  toolCalls?: ToolCall[];
};

// 策略引擎对工具调用的决策结果。
export type PolicyDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "requires_approval"; reason: string };

// 当前 core 已知的 agent 事件类型。
export const AGENT_EVENT_TYPES = [
  "run.created",
  "context.built",
  "model.requested",
  "model.responded",
  "tool.requested",
  "policy.decided",
  "tool.completed",
  "tool.failed",
  "tool.blocked",
  "observation.appended",
  "run.completed",
  "run.max_steps_exceeded",
  "run.failed",
  "run.cancelled"
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// 事件来源，表示哪个运行组件发出了事件。
export const AGENT_EVENT_SOURCES = [
  "agent_loop",
  "tool_gateway"
] as const;

export type EventSource = (typeof AGENT_EVENT_SOURCES)[number];

// 各事件类型对应的业务 payload。
export type AgentEventDataByType = {
  "run.created": {
    userMessage: string;
  };
  "context.built": {
    messages: ModelMessage[];
    messageCount: number;
  };
  "model.requested": {
    step: number;
  };
  "model.responded": {
    content: string;
    toolCalls: ToolCall[];
  };
  "tool.requested": {
    toolCall: ToolCall;
  };
  "policy.decided": {
    decision: PolicyDecision;
    toolCall: ToolCall;
  };
  "tool.completed": {
    result: ToolResult;
    toolCall: ToolCall;
  };
  "tool.failed": {
    result: ToolResult;
    toolCall: ToolCall;
  };
  "tool.blocked": {
    result: ToolResult;
    toolCall: ToolCall;
  };
  "observation.appended": {
    toolCallId: string;
    toolName: string;
    message: ModelMessage;
  };
  "run.completed": {
    finalAnswer: string;
  };
  "run.max_steps_exceeded": {
    maxSteps: number;
  };
  "run.failed": {
    error: string;
  };
  "run.cancelled": {
    reason: string;
  };
};

// 调用方写入事件时只提供业务字段，完整 envelope 由 EventLog 补齐。
export type AgentEventDraftOf<Type extends AgentEventType> = {
  type: Type;
  runId: RunId;
  sessionId: SessionId;
  source: EventSource;
  step?: number;
  toolCallId?: string;
  parentEventId?: string;
  data: AgentEventDataByType[Type];
};

export type AgentEventDraft = {
  [Type in AgentEventType]: AgentEventDraftOf<Type>;
}[AgentEventType];

// 已补齐 schema、id、seq 和 timestamp 的完整事件。
export type AgentEventOf<Type extends AgentEventType> =
  AgentEventDraftOf<Type> & {
    schemaVersion: CoreSchemaVersion;
    id: string;
    seq: number;
    timestamp: string;
  };

export type AgentEvent = {
  [Type in AgentEventType]: AgentEventOf<Type>;
}[AgentEventType];

export type ToolGatewayResult = {
  result: ToolResult;
  terminalEvent: AgentEvent;
};

// 模型适配器接口，真实 LLM 和 fake model 都实现它。
export type ModelClient = {
  complete(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
};

// 事件写入接口，接收 draft 并返回完整事件。
export type EventWriter = {
  append(event: AgentEventDraft): Promise<AgentEvent> | AgentEvent;
};

// 事件读取接口，按 runId 取回事件序列。
export type EventReader = {
  readByRun(runId: RunId): Promise<AgentEvent[]> | AgentEvent[];
};

// 完整事件日志接口，同时支持写入和读取。
export type EventLog = EventWriter & EventReader;

// 工具调用策略接口，后续可扩展审批和权限规则。
export type PolicyEngine = {
  decide(input: {
    runId: RunId;
    sessionId: SessionId;
    toolCall: ToolCall;
  }): Promise<PolicyDecision> | PolicyDecision;
};

// 工具接口，所有工具都通过 ToolGateway 调用。
export type Tool = {
  name: string;
  execute(toolCall: ToolCall): Promise<ToolResult> | ToolResult;
};

// 启动一次 agent run 所需的最小输入。
export type AgentRunInput = {
  runId: RunId;
  sessionId: SessionId;
  userMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
};

// 上下文组装接口，负责生成模型初始消息。
export type ContextAssembler = {
  assemble(input: AgentRunInput): Promise<ModelMessage[]> | ModelMessage[];
};

// 一次 agent run 完成后的最小输出。
export type AgentRunResult = {
  finalAnswer: string;
  toolResults: ToolResult[];
};
