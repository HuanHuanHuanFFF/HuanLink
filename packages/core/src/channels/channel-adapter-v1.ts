import type {
  ChannelConversationRouteV1,
  ChannelDescriptorV1
} from "./channel-instance-v1.js";
import type {
  ChannelOutboundMessagePartV1,
  InboundChannelMessageV1
} from "./channel-message-v1.js";

/** Server 要求指定 Channel 实例发送消息的命令。 */
export type SendChannelMessageCommandV1 = {
  readonly route: ChannelConversationRouteV1;
  readonly parts: readonly ChannelOutboundMessagePartV1[];
  readonly replyToMessageId?: string;
};

/** Server 要求指定 Channel 实例主动撤回消息的命令。 */
export type RetractChannelMessageCommandV1 = {
  readonly route: ChannelConversationRouteV1;
  /** Adapter 原样解释的平台消息 ID；Core 不解析其内部格式。 */
  readonly messageId: string;
};

/**
 * 平台接受发送并分配消息 ID 后返回的最小稳定回执。
 * 这不表示接收方已经收到或读取消息。
 */
export type DeliveryReceiptV1 = {
  readonly channelId: string;
  readonly messageId: string;
};

/** 跨平台稳定错误码；平台原始错误只作为受控 cause 或日志保留。 */
export type ChannelErrorCodeV1 =
  | "not_supported"
  | "rate_limited"
  | "temporarily_unavailable"
  | "authentication_failed"
  | "invalid_target"
  | "permanent_failure";

/** Channel 操作失败时交给 Server 的结构化错误。 */
export class ChannelOperationError extends Error {
  readonly code: ChannelErrorCodeV1;
  readonly retryAfterMs?: number;

  constructor(
    code: ChannelErrorCodeV1,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChannelOperationError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type ChannelMessageListenerV1 = (
  message: InboundChannelMessageV1
) => Promise<void> | void;

/**
 * Server 依赖的最小 Channel Adapter 接口。
 * 连接、鉴权、心跳、重连和平台协议映射都由具体 Adapter 内部负责。
 */
export interface ChannelAdapterV1 {
  readonly descriptor: ChannelDescriptorV1;
  /** 启动连接或事件接收；成功返回时 Adapter 已可用。 */
  start(): Promise<void>;
  /** 停止接收并释放连接及未完成的内部操作。 */
  close(): Promise<void>;
  /** 订阅规范入站消息；返回的函数用于取消订阅。 */
  onMessage(listener: ChannelMessageListenerV1): () => void;
  /** 发送消息，并在平台接受后返回消息 ID。 */
  send(command: SendChannelMessageCommandV1): Promise<DeliveryReceiptV1>;
  /**
   * 主动撤回指定消息；成功时不返回额外内容。
   * 不支持撤回时必须拒绝并返回 `ChannelOperationError("not_supported")`。
   */
  retract(command: RetractChannelMessageCommandV1): Promise<void>;
}
