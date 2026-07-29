import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogger,
} from "@huanlink/core";
import WebSocket, { type RawData } from "ws";

import {
  parseOneBot11JsonFrame,
  type OneBot11Action,
  type OneBot11JsonObject,
} from "./codec.js";
import type {
  ForwardWebSocketOneBot11TransportOptions,
  OneBot11ActionContext,
  OneBot11ChannelErrorListener,
  OneBot11EventListener,
  OneBot11Transport,
} from "./types.js";
import {
  sanitizeOneBot11ConnectionErrorMessage,
} from "./connection-error-sanitizer.js";
import {
  OneBot11DeliveryUncertainError,
  OneBot11RemoteActionError,
  OneBot11TransportUnavailableError,
} from "./action-errors.js";

/** 一个等待 OneBot 按 echo 返回结果的 Action 及其超时、Socket 和会话上下文。 */
type PendingAction = {
  socket: WebSocket;
  conversationId: string;
  resolve: (response: OneBot11JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  dispatched: boolean;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 5_000] as const;

/**
 * OneBot 11 正向 WebSocket Transport。
 * 负责连接与重连、事件分发、Action/echo 响应关联、关闭和安全日志。
 */
export class ForwardWebSocketOneBot11Transport implements OneBot11Transport {
  private readonly url: string;
  private readonly accessToken: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly onError: OneBot11ChannelErrorListener;
  private readonly logger: RuntimeLogger;
  private readonly listeners = new Set<OneBot11EventListener>();
  private readonly pendingActions = new Map<string, PendingAction>();

  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private running = false;
  private closing = false;
  private startOperation: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;

  /** 规范化连接配置并拒绝无效的超时或重连延迟。 */
  constructor(options: ForwardWebSocketOneBot11TransportOptions) {
    this.url = options.url;
    this.accessToken = nonEmptyString(options.accessToken);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }

    this.reconnectDelaysMs =
      options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (
      this.reconnectDelaysMs.length === 0 ||
      this.reconnectDelaysMs.some(
        (delay) => !Number.isInteger(delay) || delay < 0,
      )
    ) {
      throw new Error(
        "reconnectDelaysMs must contain non-negative integer delays",
      );
    }

    this.onError = options.onError ?? (() => undefined);
    this.logger = options.logger ?? new NoopRuntimeLogger();
  }

  /** 建立初始连接；并发调用共享同一个启动 Promise。 */
  start(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error("OneBot 11 transport is closed"));
    }
    if (this.startOperation !== undefined) {
      return this.startOperation;
    }
    if (this.running) {
      return Promise.resolve();
    }

    this.running = true;
    const attempt = this.reconnectAttempt;
    const operation = this.connect().catch((error: unknown) => {
      this.running = false;
      const failedSocket = this.socket;
      this.socket = undefined;
      if (
        failedSocket !== undefined &&
        failedSocket.readyState !== WebSocket.CLOSED
      ) {
        try {
          failedSocket.terminate();
        } catch {
          // The connection failure remains the useful startup error.
        }
      }
      const connectionError = this.sanitizeConnectionError(error);
      this.writeLog("error", "onebot11.error", {
        stage: "connect",
        attempt,
        error: connectionError,
      });
      throw connectionError;
    });
    this.startOperation = operation;
    void operation.then(
      () => this.clearStartOperation(operation),
      () => this.clearStartOperation(operation),
    );
    return operation;
  }

  /** 订阅 OneBot 主动上报事件，并返回对应的取消订阅函数。 */
  onEvent(listener: OneBot11EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 发送 Action 并通过唯一 echo 等待完整 OneBot 响应。
   * 发出后的超时或断连标记为结果不确定，未连接时标记为 Transport 不可用。
   */
  sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<OneBot11JsonObject> {
    const socket = this.socket;
    if (
      !this.running ||
      this.closing ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return this.rejectRequest(
        context.conversationId,
        new OneBot11TransportUnavailableError(
          "OneBot 11 WebSocket is not connected",
        ),
      );
    }
    if (this.pendingActions.has(action.echo)) {
      return this.rejectRequest(
        context.conversationId,
        new Error("OneBot 11 action echo must be unique while pending"),
      );
    }

    const payload = JSON.stringify(action);
    this.writeLog("info", "onebot11.reply.sending", {
      conversationId: context.conversationId,
      echo: action.echo,
    });

    return new Promise<OneBot11JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectAction(
          action.echo,
          this.pendingFailure(
            action.echo,
            "OneBot 11 action " + action.echo + " timed out",
          ),
        );
      }, this.requestTimeoutMs);
      this.pendingActions.set(action.echo, {
        socket,
        conversationId: context.conversationId,
        resolve,
        reject,
        timeout,
        dispatched: false,
      });

      try {
        socket.send(payload, (error) => {
          if (error) {
            this.rejectAction(
              action.echo,
              new OneBot11DeliveryUncertainError(
                "Failed to send OneBot 11 action " +
                  action.echo +
                  ": " +
                  error.message,
                { cause: error },
              ),
            );
          }
        });
        const pending = this.pendingActions.get(action.echo);
        if (pending !== undefined) {
          pending.dispatched = true;
        }
      } catch (error) {
        this.rejectAction(
          action.echo,
          new OneBot11TransportUnavailableError(
            "Failed to dispatch OneBot 11 action " + action.echo,
            { cause: error },
          ),
        );
      }
    });
  }

  /** 幂等关闭 Transport；待处理 Action 会被终止。 */
  close(): Promise<void> {
    if (this.closeOperation !== undefined) {
      return this.closeOperation;
    }
    this.closeOperation = this.performClose();
    return this.closeOperation;
  }

  /** 仅清理由指定启动操作占用的共享 Promise。 */
  private clearStartOperation(operation: Promise<void>): void {
    if (this.startOperation === operation) {
      this.startOperation = undefined;
    }
  }

  /** 停止重连、结束待处理 Action，并优先正常关闭当前 Socket。 */
  private async performClose(): Promise<void> {
    this.writeLog("info", "onebot11.closing");
    this.closing = true;
    this.running = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending("OneBot 11 channel closed", "aborted");

    try {
      const socket = this.socket;
      this.socket = undefined;
      if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        let forceClose: NodeJS.Timeout;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(forceClose);
          resolve();
        };
        forceClose = setTimeout(() => {
          try {
            socket.terminate();
          } finally {
            finish();
          }
        }, 250);
        socket.once("close", finish);
        try {
          socket.close(1000, "HuanLink shutdown");
        } catch {
          socket.terminate();
          finish();
        }
      });
    } finally {
      this.writeLog("info", "onebot11.closed");
    }
  }

  /**
   * 创建一次 WebSocket 连接并安装消息、错误和关闭处理器。
   * Promise 在连接打开时完成，在打开前失败或关闭时拒绝。
   */
  private connect(): Promise<void> {
    const attempt = this.reconnectAttempt;
    this.writeLog("info", "onebot11.connection.connecting", { attempt });
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const headers =
        this.accessToken === undefined
          ? undefined
          : { Authorization: "Bearer " + this.accessToken };
      const socket = new WebSocket(this.url, { headers });
      this.socket = socket;

      const rejectConnection = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      socket.once("open", () => {
        if (this.closing || !this.running || this.socket !== socket) {
          socket.close();
          rejectConnection(
            new Error("OneBot 11 channel closed while connecting"),
          );
          return;
        }
        opened = true;
        this.writeLog("info", "onebot11.connection.opened", { attempt });
        this.reconnectAttempt = 0;
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.on("message", (data) => this.handleFrame(data));
      socket.on("error", (error) => {
        if (!opened) {
          rejectConnection(error);
          return;
        }
        this.reportError(normalizeError(error));
      });
      socket.once("close", (code, reason) => {
        this.writeLog("info", "onebot11.connection.closed", {
          attempt,
          code,
        });
        const isCurrent = this.socket === socket;
        if (isCurrent) {
          this.socket = undefined;
        }
        this.rejectPendingForSocket(
          socket,
          new Error(
            "OneBot 11 WebSocket closed before API response (" +
              code +
              (reason.length === 0 ? "" : ": " + reason.toString("utf8")) +
              ")",
          ),
        );

        if (!opened) {
          rejectConnection(
            new Error(
              "OneBot 11 WebSocket closed before connecting (" + code + ")",
            ),
          );
          return;
        }
        if (isCurrent && this.running && !this.closing) {
          this.scheduleReconnect(code);
        }
      });
    });
  }

  /** 按配置的退避序列安排一次重连，超过序列后复用最后一个延迟。 */
  private scheduleReconnect(code?: number): void {
    if (!this.running || this.closing || this.reconnectTimer !== undefined) {
      return;
    }

    const delay =
      this.reconnectDelaysMs[
        Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
      ]!;
    this.reconnectAttempt += 1;
    this.writeLog("warn", "onebot11.connection.reconnect_scheduled", {
      attempt: this.reconnectAttempt,
      delay,
      ...(code === undefined ? {} : { code }),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running || this.closing) {
        return;
      }
      void this.connect().catch((error) => {
        const failedSocket = this.socket;
        if (
          failedSocket !== undefined &&
          failedSocket.readyState !== WebSocket.OPEN
        ) {
          failedSocket.terminate();
          if (this.socket === failedSocket) {
            this.socket = undefined;
          }
        }
        this.reportError(this.sanitizeConnectionError(error, "reconnect"));
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * 解析收到的 WebSocket 帧。
   * 带 echo 的帧进入 Action 响应处理，主动上报事件分发给订阅者。
   */
  private handleFrame(data: RawData): void {
    let frame: OneBot11JsonObject;
    try {
      frame = parseOneBot11JsonFrame(rawDataToText(data));
    } catch (error) {
      this.reportError(normalizeError(error));
      return;
    }

    if ("echo" in frame) {
      this.handleActionResponse(frame);
      return;
    }
    if (!(`post_type` in frame)) {
      return;
    }

    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(frame)).catch((error) =>
          this.reportError(normalizeError(error)),
        );
      } catch (error) {
        this.reportError(normalizeError(error));
      }
    }
  }

  /** 按 OneBot status/retcode 完成、拒绝或标记待处理 Action 的结果不确定。 */
  private handleActionResponse(frame: OneBot11JsonObject): void {
    if (typeof frame.echo !== "string") {
      return;
    }
    const pending = this.pendingActions.get(frame.echo);
    if (pending === undefined) {
      return;
    }

    if (frame.status === "ok" && frame.retcode === 0) {
      this.pendingActions.delete(frame.echo);
      clearTimeout(pending.timeout);
      this.writeLog("info", "onebot11.reply.sent", {
        conversationId: pending.conversationId,
        echo: frame.echo,
      });
      pending.resolve(frame);
      return;
    }

    if (frame.status === "async" && frame.retcode === 1) {
      this.rejectAction(
        frame.echo,
        new OneBot11DeliveryUncertainError(
          "OneBot 11 accepted the action asynchronously; final result is unknown",
        ),
      );
      return;
    }

    this.rejectAction(
      frame.echo,
      new OneBot11RemoteActionError({
        status: frame.status,
        retcode: frame.retcode,
      }),
    );
  }

  /** 清理指定待处理 Action、记录结果并拒绝其 Promise。 */
  private rejectAction(
    echo: string,
    error: Error,
    outcome: "failed" | "aborted" = "failed",
  ): void {
    const pending = this.pendingActions.get(echo);
    if (pending === undefined) {
      return;
    }
    this.pendingActions.delete(echo);
    clearTimeout(pending.timeout);
    this.writeLog(
      outcome === "aborted" ? "debug" : "error",
      outcome === "aborted"
        ? "onebot11.reply.aborted"
        : "onebot11.reply.failed",
      {
        conversationId: pending.conversationId,
        echo,
        error,
      },
    );
    pending.reject(error);
  }

  /** 记录在创建待处理 Action 前即可确定的请求失败。 */
  private rejectRequest(
    conversationId: string,
    error: Error,
  ): Promise<never> {
    const aborted = this.closing;
    this.writeLog(
      aborted ? "debug" : "error",
      aborted ? "onebot11.reply.aborted" : "onebot11.reply.failed",
      { conversationId, error },
    );
    return Promise.reject(error);
  }

  /** 使用同一原因结束当前所有待处理 Action。 */
  private rejectAllPending(
    message: string,
    outcome: "failed" | "aborted" = "failed",
  ): void {
    for (const echo of [...this.pendingActions.keys()]) {
      this.rejectAction(echo, this.pendingFailure(echo, message), outcome);
    }
  }

  /** 结束绑定到指定已关闭 Socket 的待处理 Action。 */
  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [echo, pending] of [...this.pendingActions.entries()]) {
      if (pending.socket === socket) {
        this.rejectAction(
          echo,
          this.pendingFailure(echo, error.message, error),
        );
      }
    }
  }

  /**
   * 根据 Action 是否已经交给 Socket，区分结果不确定和尚未可靠发出。
   */
  private pendingFailure(
    echo: string,
    message: string,
    cause?: unknown,
  ): Error {
    const pending = this.pendingActions.get(echo);
    return pending?.dispatched === true
      ? new OneBot11DeliveryUncertainError(message, { cause })
      : new OneBot11TransportUnavailableError(message, { cause });
  }

  /** 清理连接错误中的 URL 凭证和 Access Token 后生成可返回错误。 */
  private sanitizeConnectionError(error: unknown, action = "connect"): Error {
    const message = sanitizeOneBot11ConnectionErrorMessage(
      normalizeError(error).message,
      this.url,
      this.accessToken,
    );
    return new Error(
      "Failed to " + action + " OneBot 11 WebSocket: " + message,
    );
  }

  /** 记录错误并通知外部观察者，观察者异常不会中断 WebSocket 读取循环。 */
  private reportError(error: Error): void {
    this.writeLog("error", "onebot11.error", { error });
    try {
      this.onError(error);
    } catch {
      // Error observers must not break the WebSocket reader loop.
    }
  }

  /** 写入运行日志；日志实现自身失败时保持 Transport 生命周期继续运行。 */
  private writeLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: RuntimeLogFields,
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging observers must not break transport lifecycle.
    }
  }
}

/** 将 ws 支持的所有 RawData 形态统一解码为 UTF-8 文本。 */
function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

/** 将未知输入规范为去除首尾空白后的非空字符串。 */
function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/** 将捕获到的任意异常值统一转换为标准 Error。 */
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
