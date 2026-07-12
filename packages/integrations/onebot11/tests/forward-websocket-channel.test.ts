import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { InboundChannelMessage } from "@huanlink/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { ForwardWebSocketOneBot11Channel } from "../src/index.js";

type JsonObject = Record<string, unknown>;

const servers: WebSocketServer[] = [];
const channels: ForwardWebSocketOneBot11Channel[] = [];

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

  test("does not let a stale socket close reject a new socket action", async () => {
    const { server, url } = await startServer();
    const serverSockets: WebSocket[] = [];
    const framesByConnection: JsonObject[][] = [];
    server.on("connection", (socket) => {
      const index = serverSockets.push(socket) - 1;
      framesByConnection[index] = [];
      socket.on("message", (data) => {
        framesByConnection[index]!.push(readFrame(data));
      });
    });
    const channel = createChannel(url, { reconnectDelaysMs: [0] });
    await channel.start();
    const internals = channel as unknown as {
      socket: WebSocket | undefined;
      scheduleReconnect(): void;
    };
    const staleSocket = internals.socket!;

    internals.socket = undefined;
    internals.scheduleReconnect();
    await waitFor(() => serverSockets.length === 2, "a replacement socket");
    await waitFor(
      () => internals.socket?.readyState === WebSocket.OPEN,
      "the replacement client to open",
    );

    const pending = channel.sendText("20002", "new socket action");
    void pending.catch(() => undefined);
    await waitFor(
      () => framesByConnection[1]?.length === 1,
      "the replacement socket action",
    );
    staleSocket.emit("close", 1006, Buffer.from("late close"));
    const frame = framesByConnection[1]![0]!;
    serverSockets[1]!.send(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 3 },
        echo: frame.echo,
      }),
    );

    await expect(pending).resolves.toBeUndefined();
  });
});
