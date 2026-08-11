// core 运行链路共享的标识类型。

// 一次 agent run 的唯一标识。
export type RunId = string;

// 一段会话的唯一标识。
export type SessionId = string;

// 一次外部 Agent 异步调用的唯一标识。
export type AgentCallId = string;

// HuanLink 延迟 Tool Task 对模型公开的唯一标识。
export type HuanLinkTaskId = string;
