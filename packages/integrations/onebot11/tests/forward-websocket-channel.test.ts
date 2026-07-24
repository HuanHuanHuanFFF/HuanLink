import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type {
  InboundChannelMessage,
  RuntimeLogFields,
  RuntimeLogger,
} from "@huanlink/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { ForwardWebSocketOneBot11Channel } from "../src/index.js";

type JsonObject = Record<string, unknown>;

const servers: WebSocketServer[] = [];
const channels: ForwardWebSocketOneBot11Channel[] = [];

type RecordedLog = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: RuntimeLogFields;
};

class RecordingRuntimeLogger implements RuntimeLogger {
  readonly entries: RecordedLog[];

  constructor(
    entries: RecordedLog[] = [],
    private readonly bindings: RuntimeLogFields = {},
  ) {
    this.entries = entries;
  }

  debug(message: string, fields: RuntimeLogFields = {}): void {
    this.record("debug", message, fields);
  }

  info(message: string, fields: RuntimeLogFields = {}): void {
    this.record("info", message, fields);
  }

  warn(message: string, fields: RuntimeLogFields = {}): void {
    this.record("warn", message, fields);
  }

  error(message: string, fields: RuntimeLogFields = {}): void {
    this.record("error", message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new RecordingRuntimeLogger(this.entries, {
      ...this.bindings,
      ...bindings,
    });
  }

  private record(
    level: RecordedLog["level"],
    message: string,
    fields: RuntimeLogFields,
  ): void {
    this.entries.push({
      level,
      message,
      fields: { ...this.bindings, ...fields },
    });
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startServer(
  options: ConstructorParameters<typeof WebSocketServer>[0] = { port: 0 },
): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer(options);
  servers.push(server);
  if (server.address() === null) {
    await once(server, "listening");
  }
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `ws://127.0.0.1:${address.port}/`,
  };
}

function createChannel(
  url: string,
  overrides: Partial<
    ConstructorParameters<typeof ForwardWebSocketOneBot11Channel>[0]
  > = {},
): ForwardWebSocketOneBot11Channel {
  const channel = new ForwardWebSocketOneBot11Channel({
    url,
    commandPrefix: "/huanlink",
    requestTimeoutMs: 200,
    reconnectDelaysMs: [10, 20],
    ...overrides,
  });
  channels.push(channel);
  return channel;
}

function groupEvent(
  messageId: number,
  text: string,
  overrides: Record<string, unknown> = {},
): JsonObject {
  return {
    time: 1_704_067_200,
    self_id: "10001",
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: messageId,
    group_id: "20002",
    user_id: "30003",
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { nickname: "Alice", card: "Alice Card" },
    ...overrides,
  };
}

function readFrame(data: Parameters<WebSocket["on"]>[1] extends never
  ? never
  : unknown): JsonObject {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : String(data);
  return JSON.parse(text) as JsonObject;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(async () => {
  await Promise.allSettled(channels.splice(0).map((channel) => channel.close()));
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) {
        client.terminate();
      }
      if (server.address() !== null) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
  );
});

describe("ForwardWebSocketOneBot11Channel", () => {
  test("logs safe connection, message, reply, and close lifecycle details", async () => {
    const { server, url } = await startServer();
    const sensitiveUrl = new URL(url);
    sensitiveUrl.username = "onebot-user-secret";
    sensitiveUrl.password = "onebot-password-secret";
    sensitiveUrl.searchParams.set("session", "onebot-query-secret");
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
      socket = connected;
      connected.on("message", (data) => {
        const request = readFrame(data);
        connected.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { message_id: 5678 },
            echo: request.echo,
          }),
        );
      });
    });
    const logger = new RecordingRuntimeLogger();
    const received: InboundChannelMessage[] = [];
    const channel = createChannel(sensitiveUrl.toString(), { logger });
    channel.onMessage((message) => {
      received.push(message);
    });

    await channel.start();
    socket!.send(
      JSON.stringify(
        groupEvent(7, "/huanlink inspect this", {
          raw_transport_secret: "raw-frame-secret",
        }),
      ),
    );
    await waitFor(() => received.length === 1, "the logged group event");
    await channel.sendText("20002", "reply payload");
    await channel.close();

    expect(logger.entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "onebot11.connection.connecting",
        "onebot11.connection.opened",
        "onebot11.message.received",
        "onebot11.message.payload",
        "onebot11.reply.sending",
        "onebot11.reply.payload",
        "onebot11.reply.sent",
        "onebot11.closing",
        "onebot11.connection.closed",
        "onebot11.closed",
      ]),
    );
    expect(logEntry(logger, "onebot11.message.received")).toMatchObject({
      level: "info",
      fields: {
        messageId: "7",
        conversationId: "20002",
        senderId: "30003",
        trigger: "command",
      },
    });
    expect(logEntry(logger, "onebot11.message.payload")).toMatchObject({
      level: "debug",
      fields: {
        messageId: "7",
        payload: expect.objectContaining({ text: "/huanlink inspect this" }),
      },
    });
    const sending = logEntry(logger, "onebot11.reply.sending");
    expect(sending).toMatchObject({
      level: "info",
      fields: {
        conversationId: "20002",
        echo: expect.stringMatching(/^send-group:/),
      },
    });
    expect(logEntry(logger, "onebot11.reply.payload")).toMatchObject({
      level: "debug",
      fields: { payload: { text: "reply payload" } },
    });
    expect(logEntry(logger, "onebot11.reply.sent")).toMatchObject({
      level: "info",
      fields: {
        conversationId: "20002",
        echo: sending.fields.echo,
      },
    });
    expect(logEntry(logger, "onebot11.connection.closed")).toMatchObject({
      fields: { code: 1000 },
    });

    const serialized = JSON.stringify(logger.entries);
    for (const secret of [
      "onebot-user-secret",
      "onebot-password-secret",
      "onebot-query-secret",
      "raw-frame-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("logs disconnect and reconnect scheduling with the real attempt, delay, and code", async () => {
    const { server, url } = await startServer();
    const sockets: WebSocket[] = [];
    server.on("connection", (socket) => sockets.push(socket));
    const logger = new RecordingRuntimeLogger();
    const channel = createChannel(url, { logger, reconnectDelaysMs: [10] });

    await channel.start();
    sockets[0]!.close(1011, "test disconnect");
    await waitFor(
      () =>
        logger.entries.filter(
          (entry) => entry.message === "onebot11.connection.opened",
        ).length === 2,
      "the second opened connection log",
    );

    expect(logEntry(logger, "onebot11.connection.closed")).toMatchObject({
      fields: { attempt: 0, code: 1011 },
    });
    expect(
      logEntry(logger, "onebot11.connection.reconnect_scheduled"),
    ).toMatchObject({
      fields: { attempt: 1, delay: 10, code: 1011 },
    });
    expect(
      logger.entries
        .filter((entry) => entry.message === "onebot11.connection.opened")
        .map((entry) => entry.fields.attempt),
    ).toEqual([0, 1]);
  });

  test("logs a failed reply without a false sent event", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = readFrame(data);
        socket.send(
          JSON.stringify({
            status: "failed",
            retcode: 1404,
            message: "reply rejected",
            echo: request.echo,
          }),
        );
      });
    });
    const logger = new RecordingRuntimeLogger();
    const channel = createChannel(url, { logger });
    await channel.start();

    await expect(channel.sendText("20002", "failed reply")).rejects.toThrow(
      "reply rejected",
    );

    const failed = logEntry(logger, "onebot11.reply.failed");
    expect(failed).toMatchObject({
      level: "error",
      fields: {
        conversationId: "20002",
        echo: expect.stringMatching(/^send-group:/),
      },
    });
    expect(
      logger.entries.some(
        (entry) =>
          entry.message === "onebot11.reply.sent" &&
          entry.fields.echo === failed.fields.echo,
      ),
    ).toBe(false);
    expect(loggedError(failed).message).toContain("reply rejected");
  });

  test("reports a remote close reason in the pending reply failure", async () => {
    const { server, url } = await startServer();
    const closeReason = "remote-close-reason";
    server.on("connection", (socket) => {
      socket.on("message", () => socket.close(1011, closeReason));
    });
    const logger = new RecordingRuntimeLogger();
    const channel = createChannel(url, { logger });
    await channel.start();

    await expect(channel.sendText("20002", "close this reply")).rejects.toThrow(
      closeReason,
    );

    const failed = logEntry(logger, "onebot11.reply.failed");
    expect(loggedError(failed).message).toContain(closeReason);
  });

  test("connects at the configured root with a Bearer header and dispatches parsed events", async () => {
    const { server, url } = await startServer();
    const connections: Array<{ socket: WebSocket; url: string; authorization?: string }> = [];
    server.on("connection", (socket, request) => {
      connections.push({
        socket,
        url: request.url ?? "",
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
    });
    const received: InboundChannelMessage[] = [];
    const channel = createChannel(url, { accessToken: "onebot-secret" });
    channel.onMessage((message) => {
      received.push(message);
    });

    await channel.start();
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      url: "/",
      authorization: "Bearer onebot-secret",
    });

    connections[0]!.socket.send(JSON.stringify(groupEvent(1, "hello group")));
    await waitFor(() => received.length === 1, "the parsed group event");

    expect(received[0]).toMatchObject({
      channel: "onebot11",
      conversationId: "20002",
      messageId: "1",
      text: "hello group",
    });
  });

  test("does not let a slow listener block a later event and survives malformed JSON", async () => {
    const { server, url } = await startServer();
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
      socket = connected;
    });
    const releaseFirst = deferred();
    const received: string[] = [];
    const errors: Error[] = [];
    const channel = createChannel(url, {
      onError: (error) => errors.push(error),
    });
    channel.onMessage(async (message) => {
      received.push(message.messageId);
      if (message.messageId === "1") {
        await releaseFirst.promise;
      }
    });

    await channel.start();
    socket!.send("not-json");
    socket!.send(JSON.stringify(groupEvent(1, "first")));
    socket!.send(JSON.stringify(groupEvent(2, "second")));

    await waitFor(() => received.length === 2, "the second non-blocked event");
    expect(received).toEqual(["1", "2"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/JSON|frame/i);
    releaseFirst.resolve();
  });

  test("sends the standard send_group_msg action and resolves its matching echo", async () => {
    const { server, url } = await startServer();
    let request: JsonObject | undefined;
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        request = readFrame(data);
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { message_id: 5678 },
            echo: request.echo,
          }),
        );
      });
    });
    const channel = createChannel(url);
    await channel.start();

    await expect(channel.sendText("20002", "已受理")).resolves.toBeUndefined();
    expect(request).toMatchObject({
      action: "send_group_msg",
      params: {
        group_id: 20002,
        message: [{ type: "text", data: { text: "已受理" } }],
      },
    });
    expect(request?.echo).toMatch(/^send-group:/);
  });

  test.each(["0", "01", "1.5", "9007199254740992", "not-a-group"])(
    "rejects a non-standard or unsafe outgoing group ID %s",
    async (groupId) => {
      const { server, url } = await startServer();
      const requests: JsonObject[] = [];
      server.on("connection", (socket) => {
        socket.on("message", (data) => requests.push(readFrame(data)));
      });
      const channel = createChannel(url);
      await channel.start();

      await expect(channel.sendText(groupId, "must not send")).rejects.toThrow(
        /safe positive integer/i,
      );
      expect(requests).toEqual([]);
    },
  );

  test("pairs concurrent action responses by echo even when responses arrive in reverse order", async () => {
    const { server, url } = await startServer();
    const requests: JsonObject[] = [];
    let socket: WebSocket | undefined;
    server.on("connection", (connected) => {
      socket = connected;
      connected.on("message", (data) => {
        requests.push(readFrame(data));
        if (requests.length === 2) {
          const first = requests.find((frame) =>
            JSON.stringify(frame).includes("first"),
          )!;
          const second = requests.find((frame) =>
            JSON.stringify(frame).includes("second"),
          )!;
          connected.send(
            JSON.stringify({
              status: "failed",
              retcode: 1404,
              message: "second rejected",
              echo: second.echo,
            }),
          );
          connected.send(
            JSON.stringify({
              status: "ok",
              retcode: 0,
              data: { message_id: 1 },
              echo: first.echo,
            }),
          );
        }
      });
    });
    const channel = createChannel(url);
    await channel.start();

    const first = channel.sendText("20002", "first");
    const second = channel.sendText("20002", "second");

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/1404|second rejected/);
    expect(new Set(requests.map((frame) => frame.echo)).size).toBe(2);
    expect(socket).toBeDefined();
  });

  test("rejects an unanswered action after its request timeout", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket) => {
      socket.on("message", () => undefined);
    });
    const channel = createChannel(url, { requestTimeoutMs: 30 });
    await channel.start();

    await expect(channel.sendText("20002", "will time out")).rejects.toThrow(
      /timed out/i,
    );
  });

  test("logs a pending reply canceled by channel close only as a debug abort", async () => {
    const { server, url } = await startServer();
    server.on("connection", (socket) => {
      socket.on("message", () => undefined);
    });
    const logger = new RecordingRuntimeLogger();
    const channel = createChannel(url, { logger });
    await channel.start();

    const pending = channel.sendText("20002", "pending during shutdown");
    const rejected = expect(pending).rejects.toThrow(
      "OneBot 11 channel closed",
    );
    await channel.close();
    await rejected;

    const aborted = logEntry(logger, "onebot11.reply.aborted");
    expect(aborted).toMatchObject({
      level: "debug",
      fields: { conversationId: "20002" },
    });
    expect(
      logger.entries.some(
        (entry) =>
          entry.message === "onebot11.reply.failed" &&
          entry.fields.echo === aborted.fields.echo,
      ),
    ).toBe(false);
  });

  test("rejects pending actions on disconnect, reconnects, and never replays them", async () => {
    const { server, url } = await startServer();
    const sockets: WebSocket[] = [];
    const framesByConnection: JsonObject[][] = [];
    server.on("connection", (socket) => {
      const connectionIndex = sockets.push(socket) - 1;
      framesByConnection[connectionIndex] = [];
      socket.on("message", (data) => {
        framesByConnection[connectionIndex]!.push(readFrame(data));
      });
    });
    const channel = createChannel(url);
    await channel.start();

    const pending = channel.sendText("20002", "do not replay");
    await waitFor(
      () => framesByConnection[0]?.length === 1,
      "the first action frame",
    );
    sockets[0]!.close(1011, "test disconnect");

    await expect(pending).rejects.toThrow(/closed|disconnect/i);
    await waitFor(() => sockets.length === 2, "a reconnected socket");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(framesByConnection[1]).toEqual([]);

    const afterReconnect = channel.sendText("20002", "new action");
    await waitFor(
      () => framesByConnection[1]?.length === 1,
      "a new post-reconnect action",
    );
    const reconnectFrame = framesByConnection[1]![0]!;
    sockets[1]!.send(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 2 },
        echo: reconnectFrame.echo,
      }),
    );
    await expect(afterReconnect).resolves.toBeUndefined();
  });

  test("an active close prevents reconnecting", async () => {
    const { server, url } = await startServer();
    const sockets: WebSocket[] = [];
    server.on("connection", (socket) => sockets.push(socket));
    const channel = createChannel(url);
    await channel.start();

    await channel.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(sockets).toHaveLength(1);
  });

  test("shares an in-flight start and rejects every caller when the handshake fails", async () => {
    const handshakeStarted = deferred();
    const releaseHandshake = deferred();
    const server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => {
        handshakeStarted.resolve();
        void releaseHandshake.promise.then(() =>
          done(false, 503, "Service Unavailable"),
        );
      },
    });
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const channel = createChannel(`ws://127.0.0.1:${address.port}/`);

    const firstStart = channel.start();
    await handshakeStarted.promise;
    const secondStart = channel.start();
    let secondSettled = false;
    void secondStart.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondSettledBeforeHandshake = secondSettled;
    const results = Promise.allSettled([firstStart, secondStart]);
    releaseHandshake.resolve();

    expect(secondStart).toBe(firstStart);
    expect(secondSettledBeforeHandshake).toBe(false);
    await expect(results).resolves.toMatchObject([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
  });

  test("reports an initial handshake failure without leaking the access token", async () => {
    const server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => done(false, 401, "Unauthorized"),
    });
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const token = "must-not-appear-in-errors";
    const onError = vi.fn();
    const channel = createChannel(`ws://127.0.0.1:${address.port}/`, {
      accessToken: token,
      onError,
    });

    const error = await channel.start().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/401|handshake|connect/i);
    expect((error as Error).message).not.toContain(token);
  });

});

function logEntry(
  logger: RecordingRuntimeLogger,
  message: string,
): RecordedLog {
  const entry = logger.entries.find((candidate) => candidate.message === message);
  if (entry === undefined) {
    throw new Error(`Missing recorded log ${message}`);
  }
  return entry;
}

function loggedError(entry: RecordedLog): Error {
  const error = entry.fields.error;
  if (!(error instanceof Error)) {
    throw new Error(`Log ${entry.message} did not contain an Error`);
  }
  return error;
}
