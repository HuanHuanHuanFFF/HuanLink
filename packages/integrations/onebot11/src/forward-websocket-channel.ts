import { randomUUID } from "node:crypto";

import type {
  ChannelAdapter,
  ChannelMessageListener,
} from "@huanlink/core";
import WebSocket, { type RawData } from "ws";

import { parseOneBot11GroupMessage } from "./group-message.js";
import type {
  ForwardWebSocketOneBot11ChannelOptions,
  OneBot11ChannelErrorListener,
} from "./types.js";

type PendingAction = {
  socket: WebSocket;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type JsonObject = Record<string, unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 5_000] as const;

export class ForwardWebSocketOneBot11Channel implements ChannelAdapter {
  readonly channel = "onebot11" as const;

  private readonly url: string;
  private readonly accessToken: string | undefined;
  private readonly commandPrefix: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly onError: OneBot11ChannelErrorListener;
  private readonly listeners = new Set<ChannelMessageListener>();
  private readonly pendingActions = new Map<string, PendingAction>();

  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private running = false;
  private closing = false;
  private startOperation: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;

  constructor(options: ForwardWebSocketOneBot11ChannelOptions) {
    this.url = options.url;
    this.accessToken = nonEmptyString(options.accessToken);
    this.commandPrefix = options.commandPrefix.trim();
    if (this.commandPrefix.length === 0) {
      throw new Error("commandPrefix must be non-empty");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
  }

  start(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error("OneBot 11 channel is closed"));
    }
    if (this.startOperation !== undefined) {
      return this.startOperation;
    }
    if (this.running) {
      return Promise.resolve();
    }

    this.running = true;
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
      throw this.sanitizeConnectionError(error);
    });
    this.startOperation = operation;
    void operation.then(
      () => {
        if (this.startOperation === operation) {
          this.startOperation = undefined;
        }
      },
      () => {
        if (this.startOperation === operation) {
          this.startOperation = undefined;
        }
      },
    );
    return operation;
  }

  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendText(conversationId: string, text: string): Promise<void> {
    const socket = this.socket;
    if (
      !this.running ||
      this.closing ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(
        new Error("OneBot 11 WebSocket is not connected"),
      );
    }

    const groupId = parseOutgoingGroupId(conversationId);
    if (groupId === undefined) {
      return Promise.reject(
        new Error(
          "OneBot 11 group ID must be a safe positive integer string",
        ),
      );
    }

    const echo = "send-group:" + randomUUID();
    const payload = JSON.stringify({
      action: "send_group_msg",
      params: {
        group_id: groupId,
        message: [{ type: "text", data: { text } }],
      },
      echo,
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectAction(
          echo,
          new Error("OneBot 11 action " + echo + " timed out"),
        );
      }, this.requestTimeoutMs);
      this.pendingActions.set(echo, { socket, resolve, reject, timeout });

      try {
        socket.send(payload, (error) => {
          if (error) {
            this.rejectAction(
              echo,
              new Error(
                "Failed to send OneBot 11 action " +
                  echo +
                  ": " +
                  error.message,
              ),
            );
          }
        });
      } catch (error) {
        this.rejectAction(echo, normalizeError(error));
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

  private async performClose(): Promise<void> {
    this.closing = true;
    this.running = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending(new Error("OneBot 11 channel closed"));

    const socket = this.socket;
    this.socket = undefined;
    if (
      socket === undefined ||
      socket.readyState === WebSocket.CLOSED
    ) {
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
  }

  private connect(): Promise<void> {
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
        const isCurrent = this.socket === socket;
        if (isCurrent) {
          this.socket = undefined;
        }
        this.rejectPendingForSocket(
          socket,
          new Error(
            "OneBot 11 WebSocket closed before API response (" +
              code +
              (reason.length === 0
                ? ""
                : ": " + reason.toString("utf8")) +
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
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (
      !this.running ||
      this.closing ||
      this.reconnectTimer !== undefined
    ) {
      return;
    }

    const delay =
      this.reconnectDelaysMs[
        Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
      ]!;
    this.reconnectAttempt += 1;
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
    let frame: unknown;
    try {
      frame = JSON.parse(rawDataToText(data));
    } catch (error) {
      this.reportError(
        new Error(
          "Invalid OneBot 11 JSON frame: " +
            normalizeError(error).message,
        ),
      );
      return;
    }

    const object = asObject(frame);
    if (object === undefined) {
      this.reportError(
        new Error("Invalid OneBot 11 frame: expected an object"),
      );
      return;
    }

    if ("echo" in object) {
      this.handleActionResponse(object);
      return;
    }
    if (!("post_type" in object)) {
      return;
    }

    try {
      const message = parseOneBot11GroupMessage(object, {
        commandPrefix: this.commandPrefix,
      });
      if (message !== undefined) {
        this.dispatchMessage(message);
      }
    } catch (error) {
      this.reportError(normalizeError(error));
    }
  }

  private handleActionResponse(frame: JsonObject): void {
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

  private dispatchMessage(
    message: NonNullable<
      ReturnType<typeof parseOneBot11GroupMessage>
    >,
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

  private rejectAction(echo: string, error: Error): void {
    const pending = this.pendingActions.get(echo);
    if (pending === undefined) {
      return;
    }
    this.pendingActions.delete(echo);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const echo of [...this.pendingActions.keys()]) {
      this.rejectAction(echo, error);
    }
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [echo, pending] of [...this.pendingActions.entries()]) {
      if (pending.socket === socket) {
        this.rejectAction(echo, error);
      }
    }
  }

  private sanitizeConnectionError(
    error: unknown,
    action = "connect",
  ): Error {
    let message = normalizeError(error).message;
    if (this.accessToken !== undefined) {
      message = message.split(this.accessToken).join("[redacted]");
    }
    return new Error(
      "Failed to " + action + " OneBot 11 WebSocket: " + message,
    );
  }

  private reportError(error: Error): void {
    try {
      this.onError(error);
    } catch {
      // Error observers must not break the WebSocket reader loop.
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

function cloneMessage(
  message: NonNullable<
    ReturnType<typeof parseOneBot11GroupMessage>
  >,
): NonNullable<ReturnType<typeof parseOneBot11GroupMessage>> {
  return {
    ...message,
    ...(message.trigger === undefined
      ? {}
      : { trigger: { ...message.trigger } }),
  };
}

function asObject(input: unknown): JsonObject | undefined {
  return typeof input === "object" &&
    input !== null &&
    !Array.isArray(input)
    ? (input as JsonObject)
    : undefined;
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

function parseOutgoingGroupId(input: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(input)) {
    return undefined;
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
