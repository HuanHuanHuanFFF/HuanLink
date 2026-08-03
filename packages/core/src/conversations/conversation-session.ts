import type {
  DeliveryReceiptV1,
  ChannelConversationRouteV1,
  InboundChannelMessageV1
} from "../channels/contract-v1.js";
import type { RunId, SessionId } from "../shared/ids.js";

/** 可安全保存在结构化 Agent 会话历史中的 JSON 值。 */
export type ConversationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ConversationJsonValue[]
  | { readonly [key: string]: ConversationJsonValue };

/** 一个 Channel session 只保存一次的固定路由与内容格式。 */
export type ConversationSessionMetadata = {
  readonly route: ChannelConversationRouteV1;
  readonly contentFormat: string;
};

/** 平台回流消息与 HuanLink Tool Call 的内部关联元数据。 */
export type ConversationOutboundDelivery = {
  readonly sentAt: string;
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly sourceSessionId: SessionId;
  readonly origin: "current_session" | "cross_session";
};

/**
 * 一条公开 Channel 消息。
 *
 * `observed` 来自平台事件；`outbound` 只在消息回流后关联对应 Tool Call。
 * 成功发送回执本身不会创建公开消息。
 */
export type ConversationChannelMessageEntry = {
  readonly type: "channel_message";
  readonly channelId: string;
  readonly messageId: string;
  readonly observed?: InboundChannelMessageV1;
  readonly outbound?: ConversationOutboundDelivery;
};

/** Agent 发出的结构化 Tool Call；参数不降级为展示文本。 */
export type ConversationAgentToolCallEntry = {
  readonly type: "agent_tool_call";
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, ConversationJsonValue>>;
};

/** 与 Tool Call 配对的结构化 Tool Result。 */
export type ConversationAgentToolResultEntry = {
  readonly type: "agent_tool_result";
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: ConversationJsonValue;
};

/** B07 当前要求保存的三类 Session 时间线条目。 */
export type ConversationTimelineEntry =
  | ConversationChannelMessageEntry
  | ConversationAgentToolCallEntry
  | ConversationAgentToolResultEntry;

/** 进程存活期间的一份完整 Channel Conversation Session。 */
export type ConversationSession = {
  readonly metadata: ConversationSessionMetadata;
  readonly timeline: readonly ConversationTimelineEntry[];
};

/** 成功发送后登记待回流关联所需的可信数据。 */
export type RecordConversationOutboundDelivery = {
  readonly route: ChannelConversationRouteV1;
  readonly contentFormat: string;
  readonly receipt: DeliveryReceiptV1;
  readonly sentAt: string;
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly sourceSessionId: SessionId;
};

export type AppendConversationAgentToolCall = Omit<
  ConversationAgentToolCallEntry,
  "type"
>;

export type AppendConversationAgentToolResult = Omit<
  ConversationAgentToolResultEntry,
  "type"
>;
