import { randomUUID } from "node:crypto";

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

export class OneBot11ChannelAdapter implements ChannelAdapter {
  readonly channel = "onebot11" as const;

  private readonly commandPrefix: string;
  private readonly transport: OneBot11Transport;
  private readonly onError: OneBot11ChannelErrorListener;
  private readonly logger: RuntimeLogger;
  private readonly listeners = new Set<ChannelMessageListener>();
  private readonly unsubscribeTransport: () => void;
  private closeOperation: Promise<void> | undefined;

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

  start(): Promise<void> {
    return this.transport.start();
  }

  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

    return this.transport.sendAction(action, {
      conversationId,
      logPayload: { text },
    });
  }

  close(): Promise<void> {
    if (this.closeOperation !== undefined) {
      return this.closeOperation;
    }
    this.unsubscribeTransport();
    this.closeOperation = this.transport.close();
    return this.closeOperation;
  }

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
        ...(message.trigger === undefined
          ? {}
          : { trigger: message.trigger.kind }),
      });
      this.writeLog("debug", "onebot11.message.payload", {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        payload: cloneMessage(message),
      });
      this.dispatchMessage(message);
    } catch (error) {
      this.reportError(normalizeError(error));
    }
  }

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

  private rejectReply(conversationId: string, error: Error): Promise<never> {
    this.writeLog("error", "onebot11.reply.failed", {
      conversationId,
      error,
    });
    return Promise.reject(error);
  }

  private reportError(error: Error): void {
    this.writeLog("error", "onebot11.error", { error });
    try {
      this.onError(error);
    } catch {
      // Error observers must not break Channel message dispatch.
    }
  }

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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
