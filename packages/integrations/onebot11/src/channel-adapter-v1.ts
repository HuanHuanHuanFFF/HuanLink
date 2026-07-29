import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  ChannelOperationError,
  NoopRuntimeLogger,
  type ChannelAdapterV1,
  type ChannelDescriptorV1,
  type ChannelErrorCodeV1,
  type ChannelMessageListenerV1,
  type DeliveryReceiptV1,
  type InboundChannelMessageV1,
  type RetractChannelMessageCommandV1,
  type RuntimeLogFields,
  type RuntimeLogger,
  type SendChannelMessageCommandV1,
} from "@huanlink/core";

import { parseOneBot11MessageV1 } from "./message-v1.js";
import {
  createOneBot11DeleteMessageActionV1,
  createOneBot11SendMessageActionV1,
  readOneBot11MessageId,
} from "./outbound-message-v1.js";
import type {
  OneBot11ChannelAdapterV1Options,
  OneBot11ChannelErrorListener,
  OneBot11Transport,
} from "./types.js";
import {
  OneBot11DeliveryUncertainError,
  OneBot11RemoteActionError,
  OneBot11TransportUnavailableError,
} from "./action-errors.js";

/** 当前 OneBot 11 Adapter 已实际实现并向 Core 公布的能力。 */
const ONEBOT11_CAPABILITIES = {
  conversationKinds: ["direct", "group"],
  threads: false,
  inboundContentFormats: ["onebot11.cq"],
  outboundPartTypes: [
    "text",
    "mention",
    "attachmentLink",
    "attachmentLocalPath",
  ],
  reply: true,
  edit: false,
  retract: true,
  reaction: false,
  typing: false,
  streaming: false,
} as const;

/**
 * OneBot 11 的 Channel Contract V1 Adapter。
 * 负责双向合同映射、消息订阅、能力声明，以及稳定 Channel 错误转换。
 */
export class OneBot11ChannelAdapterV1 implements ChannelAdapterV1 {
  readonly descriptor: ChannelDescriptorV1;

  private readonly transport: OneBot11Transport;
  private readonly onError: OneBot11ChannelErrorListener;
  private readonly logger: RuntimeLogger;
  private readonly listeners = new Set<ChannelMessageListenerV1>();
  private readonly unsubscribeTransport: () => void;
  private closeOperation: Promise<void> | undefined;

  /** 校验实例配置、建立描述信息，并订阅 Transport 事件流。 */
  constructor(options: OneBot11ChannelAdapterV1Options) {
    const channelId = requireNonEmpty(options.channelId, "channelId");
    this.descriptor = {
      channelId,
      platform: "onebot11",
      ...(options.accountId === undefined
        ? {}
        : { accountId: requireNonEmpty(options.accountId, "accountId") }),
      capabilities: ONEBOT11_CAPABILITIES,
    };
    this.transport = options.transport;
    this.onError = options.onError ?? (() => undefined);
    this.logger = options.logger ?? new NoopRuntimeLogger();
    this.unsubscribeTransport = this.transport.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  /** 启动底层 OneBot Transport。 */
  start(): Promise<void> {
    return this.transport.start();
  }

  /** 注册规范化入站消息监听器，并返回对应的取消订阅函数。 */
  onMessage(listener: ChannelMessageListenerV1): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 发送一条 V1 Channel 消息，并返回 OneBot 分配的消息 ID。
   * 所有协议和传输异常都会转换为稳定的 ChannelOperationError。
   */
  async send(
    command: SendChannelMessageCommandV1,
  ): Promise<DeliveryReceiptV1> {
    const conversationId = command.route?.conversationId ?? "unknown";
    try {
      const action = await createOneBot11SendMessageActionV1(
        command,
        this.descriptor.channelId,
        `send-${command.route.conversationKind}:${randomUUID()}`,
      );
      const response = await this.transport.sendAction(action, {
        conversationId,
      });
      const messageId = readOneBot11MessageId(response);
      if (messageId === undefined) {
        throw new ChannelOperationError(
          "permanent_failure",
          "OneBot 11 send response did not contain message_id",
        );
      }
      return { channelId: this.descriptor.channelId, messageId };
    } catch (error) {
      throw normalizeOperationError(error, "send");
    }
  }

  /** 使用 OneBot `delete_msg` 主动撤回指定消息。 */
  async retract(command: RetractChannelMessageCommandV1): Promise<void> {
    const conversationId = command.route?.conversationId ?? "unknown";
    try {
      const action = createOneBot11DeleteMessageActionV1(
        command,
        this.descriptor.channelId,
        `delete:${randomUUID()}`,
      );
      await this.transport.sendAction(action, { conversationId });
    } catch (error) {
      throw normalizeOperationError(error, "retract");
    }
  }

  /** 取消事件订阅并幂等关闭底层 Transport。 */
  close(): Promise<void> {
    if (this.closeOperation !== undefined) {
      return this.closeOperation;
    }
    this.unsubscribeTransport();
    this.closeOperation = this.transport.close();
    return this.closeOperation;
  }

  /** 将 Transport 事件解析为 V1 入站消息，记录摘要后分发给订阅者。 */
  private handleEvent(event: Record<string, unknown>): void {
    try {
      const message = parseOneBot11MessageV1(event, {
        channelId: this.descriptor.channelId,
      });
      if (message === undefined) {
        return;
      }
      this.writeLog("info", "onebot11.message.received", {
        messageId: message.messageId,
        conversationId: message.route.conversationId,
        conversationKind: message.route.conversationKind,
        senderId: message.sender.id,
        isSelf: message.sender.isSelf,
        contentBytes:
          message.contentOmitted?.originalSizeBytes ??
          Buffer.byteLength(message.content, "utf8"),
        ...(message.trigger === undefined
          ? {}
          : { trigger: message.trigger.kind }),
      });
      this.dispatchMessage(message);
    } catch (error) {
      this.reportError(normalizeError(error));
    }
  }

  /** 向每个监听器分发独立消息副本，并隔离同步及异步监听器错误。 */
  private dispatchMessage(message: InboundChannelMessageV1): void {
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(cloneMessage(message))).catch((error) =>
          this.reportError(normalizeError(error)),
        );
      } catch (error) {
        this.reportError(normalizeError(error));
      }
    }
  }

  /** 记录错误并通知外部观察者，观察者异常不会中断消息流。 */
  private reportError(error: Error): void {
    this.writeLog("error", "onebot11.error", { error });
    try {
      this.onError(error);
    } catch {
      // Error observers must not break Channel message dispatch.
    }
  }

  /** 写入运行日志；日志实现自身失败时保持 Channel 生命周期继续运行。 */
  private writeLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging observers must not break Channel lifecycle.
    }
  }
}

/** 复制消息及其嵌套字段，避免一个监听器修改其他监听器看到的对象。 */
function cloneMessage(
  message: InboundChannelMessageV1,
): InboundChannelMessageV1 {
  return {
    ...message,
    route: { ...message.route },
    sender: { ...message.sender },
    ...(message.contentOmitted === undefined
      ? {}
      : { contentOmitted: { ...message.contentOmitted } }),
    ...(message.trigger === undefined
      ? {}
      : { trigger: { ...message.trigger } }),
  };
}

/** 将内部、Transport 和远端错误归一为稳定的 Channel 错误码。 */
function normalizeOperationError(
  error: unknown,
  operation: "send" | "retract",
): ChannelOperationError {
  if (error instanceof ChannelOperationError) {
    return error;
  }
  if (error instanceof OneBot11DeliveryUncertainError) {
    return new ChannelOperationError(
      "delivery_uncertain",
      `OneBot 11 ${operation} result is unknown`,
      { cause: error },
    );
  }
  if (error instanceof OneBot11TransportUnavailableError) {
    return new ChannelOperationError(
      "temporarily_unavailable",
      `OneBot 11 ${operation} transport is unavailable`,
      { cause: error },
    );
  }
  if (error instanceof OneBot11RemoteActionError) {
    const code = mapRemoteActionErrorCode(error.retcode);
    return new ChannelOperationError(
      code,
      `OneBot 11 ${operation} was rejected by the platform`,
      { cause: error },
    );
  }
  return new ChannelOperationError(
    "permanent_failure",
    `OneBot 11 ${operation} failed`,
    { cause: error },
  );
}

/** 保守映射 OneBot 标准通信错误；未知 retcode 不猜测为可重试错误。 */
function mapRemoteActionErrorCode(retcode: unknown): ChannelErrorCodeV1 {
  switch (retcode) {
    case 1400:
      return "invalid_target";
    case 1401:
    case 1403:
      return "authentication_failed";
    case 1404:
      return "not_supported";
    default:
      return "permanent_failure";
  }
}

/** 规范化必填字符串配置，并拒绝全空白值。 */
function requireNonEmpty(input: string, label: string): string {
  const normalized = input.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

/** 将捕获到的任意异常值统一转换为标准 Error。 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
