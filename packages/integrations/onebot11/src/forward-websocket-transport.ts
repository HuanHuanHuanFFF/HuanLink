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

type PendingAction = {
  socket: WebSocket;
  conversationId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 5_000] as const;

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

  onEvent(listener: OneBot11EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<void> {
    const socket = this.socket;
    if (
      !this.running ||
      this.closing ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return this.rejectRequest(
        context.conversationId,
        new Error("OneBot 11 WebSocket is not connected"),
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
    if (context.logPayload !== undefined) {
      this.writeLog("debug", "onebot11.reply.payload", {
        conversationId: context.conversationId,
        echo: action.echo,
        payload: context.logPayload,
      });
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectAction(
          action.echo,
          new Error("OneBot 11 action " + action.echo + " timed out"),
        );
      }, this.requestTimeoutMs);
      this.pendingActions.set(action.echo, {
        socket,
        conversationId: context.conversationId,
        resolve,
        reject,
        timeout,
      });

      try {
        socket.send(payload, (error) => {
          if (error) {
            this.rejectAction(
              action.echo,
              new Error(
                "Failed to send OneBot 11 action " +
                  action.echo +
                  ": " +
                  error.message,
              ),
            );
          }
        });
      } catch (error) {
        this.rejectAction(action.echo, normalizeError(error));
      }
    });
  }

  close(): Promise<void> {
    if (this.closeOperation !== undefined) {
      return this.closeOperation;
    }
    this.closeOperation = this.performClose();
    return this.closeOperation;
  }

  private clearStartOperation(operation: Promise<void>): void {
    if (this.startOperation === operation) {
      this.startOperation = undefined;
    }
  }

  private async performClose(): Promise<void> {
    this.writeLog("info", "onebot11.closing");
    this.closing = true;
    this.running = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending(new Error("OneBot 11 channel closed"), "aborted");

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
      pending.resolve();
      return;
    }

    const remoteMessage =
      nonEmptyString(frame.message) ??
      nonEmptyString(frame.wording) ??
      "unknown remote error";
    this.rejectAction(
      frame.echo,
      new Error(
        "OneBot 11 action failed: status=" +
          String(frame.status) +
          " retcode=" +
          String(frame.retcode) +
          " message=" +
          remoteMessage,
      ),
    );
  }

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

  private rejectAllPending(
    error: Error,
    outcome: "failed" | "aborted" = "failed",
  ): void {
    for (const echo of [...this.pendingActions.keys()]) {
      this.rejectAction(echo, error, outcome);
    }
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [echo, pending] of [...this.pendingActions.entries()]) {
      if (pending.socket === socket) {
        this.rejectAction(echo, error);
      }
    }
  }

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

  private reportError(error: Error): void {
    this.writeLog("error", "onebot11.error", { error });
    try {
      this.onError(error);
    } catch {
      // Error observers must not break the WebSocket reader loop.
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
      // Logging observers must not break transport lifecycle.
    }
  }
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
