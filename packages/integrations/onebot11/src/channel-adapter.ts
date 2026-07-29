import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  ChannelAdapter,
  ChannelMessageListener,
  RuntimeLogFields,
  RuntimeLogger,
} from "@huanlink/core";
import { NoopRuntimeLogger } from "@huanlink/core";

import { createOneBot11SendGroupTextAction } from "./codec.js";
import { parseOneBot11GroupMessage } from "./group-message.js";
import type {
  OneBot11ChannelAdapterOptions,
  OneBot11ChannelErrorListener,
  OneBot11Transport,
} from "./types.js";

/**
 * B07 切换前保留的旧版 OneBot Channel Adapter。
 * 只支持旧合同的群消息解析和群文本发送，连接生命周期已委托给 Transport。
 */
export class OneBot11ChannelAdapter implements ChannelAdapter {
  readonly channel = "onebot11" as const;

  private readonly commandPrefix: string;
  private readonly transport: OneBot11Transport;
  private readonly onError: OneBot11ChannelErrorListener;
  private readonly logger: RuntimeLogger;
  private readonly listeners = new Set<ChannelMessageListener>();
  private readonly unsubscribeTransport: () => void;
  private closeOperation: Promise<void> | undefined;

  /** 校验旧命令前缀配置并订阅底层 Transport 事件。 */
  constructor(options: OneBot11ChannelAdapterOptions) {
    this.commandPrefix = options.commandPrefix.trim();
    if (this.commandPrefix.length === 0) {
      throw new Error("commandPrefix must be non-empty");
    }
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

  /** 注册旧合同消息监听器，并返回对应的取消订阅函数。 */
  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 使用旧合同向指定群发送单段文本消息。 */
  sendText(conversationId: string, text: string): Promise<void> {
    let action;
    try {
      action = createOneBot11SendGroupTextAction(
        conversationId,
        text,
        "send-group:" + randomUUID(),
      );
    } catch (error) {
      return this.rejectReply(conversationId, normalizeError(error));
    }

    return this.transport
      .sendAction(action, {
        conversationId,
      })
      .then(() => undefined);
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

  /** 将 Transport 事件映射为旧版群消息，记录摘要后分发。 */
  private handleEvent(event: Record<string, unknown>): void {
    try {
      const message = parseOneBot11GroupMessage(event, {
        commandPrefix: this.commandPrefix,
      });
      if (message === undefined) {
        return;
      }
      this.writeLog("info", "onebot11.message.received", {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        contentBytes: Buffer.byteLength(message.text, "utf8"),
        ...(message.trigger === undefined
          ? {}
          : { trigger: message.trigger.kind }),
      });
      this.dispatchMessage(message);
    } catch (error) {
      this.reportError(normalizeError(error));
    }
  }

  /** 向旧合同监听器分发独立消息副本，并隔离监听器错误。 */
  private dispatchMessage(
    message: NonNullable<ReturnType<typeof parseOneBot11GroupMessage>>,
  ): void {
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

  /** 记录 Action 构造失败并返回拒绝的 Promise。 */
  private rejectReply(conversationId: string, error: Error): Promise<never> {
    this.writeLog("error", "onebot11.reply.failed", {
      conversationId,
      error,
    });
    return Promise.reject(error);
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

/** 复制旧版消息及其触发字段，避免监听器之间共享可变嵌套对象。 */
function cloneMessage(
  message: NonNullable<ReturnType<typeof parseOneBot11GroupMessage>>,
): NonNullable<ReturnType<typeof parseOneBot11GroupMessage>> {
  return {
    ...message,
    ...(message.trigger === undefined
      ? {}
      : { trigger: { ...message.trigger } }),
  };
}

/** 将捕获到的任意异常值统一转换为标准 Error。 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
