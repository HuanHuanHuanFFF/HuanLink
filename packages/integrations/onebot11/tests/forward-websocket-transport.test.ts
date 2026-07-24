import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { RuntimeLogFields, RuntimeLogger } from "@huanlink/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  createOneBot11SendGroupTextAction,
  ForwardWebSocketOneBot11Transport,
  type OneBot11JsonObject,
} from "../src/index.js";

const servers: WebSocketServer[] = [];
const transports: ForwardWebSocketOneBot11Transport[] = [];

type RecordedLog = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: RuntimeLogFields;
};

class RecordingRuntimeLogger implements RuntimeLogger {
  readonly entries: RecordedLog[] = [];

  debug(message: string, fields: RuntimeLogFields = {}): void {
    this.entries.push({ level: "debug", message, fields });
  }

  info(message: string, fields: RuntimeLogFields = {}): void {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields: RuntimeLogFields = {}): void {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields: RuntimeLogFields = {}): void {
    this.entries.push({ level: "error", message, fields });
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    const parent = this;
    return {
      debug: (message, fields = {}) =>
        parent.debug(message, { ...bindings, ...fields }),
      info: (message, fields = {}) =>
        parent.info(message, { ...bindings, ...fields }),
      warn: (message, fields = {}) =>
        parent.warn(message, { ...bindings, ...fields }),
      error: (message, fields = {}) =>
        parent.error(message, { ...bindings, ...fields }),
      child: (nested) => parent.child({ ...bindings, ...nested }),
    };
  }
}

async function startServer(): Promise<{
  server: WebSocketServer;
  url: string;
}> {
  const server = new WebSocketServer({ port: 0 });
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

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(async () => {
  await Promise.allSettled(
    transports.splice(0).map((transport) => transport.close()),
  );
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

describe("ForwardWebSocketOneBot11Transport", () => {
  test("owns WebSocket events and echo-correlated actions without Channel types", async () => {
    const { server, url } = await startServer();
    let socket: WebSocket | undefined;
    let request: OneBot11JsonObject | undefined;
    server.on("connection", (connected) => {
      socket = connected;
      connected.on("message", (data) => {
        request = JSON.parse(data.toString("utf8")) as OneBot11JsonObject;
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

    const transport = new ForwardWebSocketOneBot11Transport({
      url,
      requestTimeoutMs: 200,
      reconnectDelaysMs: [10],
    });
    transports.push(transport);
    const events: OneBot11JsonObject[] = [];
    transport.onEvent((event) => {
      events.push(event);
    });

    await transport.start();
    socket!.send(JSON.stringify({ post_type: "message", message_id: 1 }));
    await waitFor(() => events.length === 1, "the protocol event");

    const action = createOneBot11SendGroupTextAction(
      "20002",
      "hello",
      "send-group:1",
    );
    await expect(
      transport.sendAction(action, { conversationId: "20002" }),
    ).resolves.toBeUndefined();

    expect(events).toEqual([{ post_type: "message", message_id: 1 }]);
    expect(request).toEqual(action);
  });

  test("sanitizes established socket errors only in logs and preserves the observer error", async () => {
    const { server, url } = await startServer();
    server.on("connection", () => undefined);
    const sensitiveUrl = new URL(url);
    sensitiveUrl.username = "onebot-user-secret";
    sensitiveUrl.password = "onebot-password-secret";
    sensitiveUrl.searchParams.set("session", "onebot-query-secret");
    const logger = new RecordingRuntimeLogger();
    const onError = vi.fn();
    const transport = new ForwardWebSocketOneBot11Transport({
      url: sensitiveUrl.toString(),
      logger,
      onError,
    });
    transports.push(transport);
    await transport.start();
    const businessError = new Error(
      `socket failed ${sensitiveUrl.toString()} onebot-query-secret`,
    );
    const clientSocket = (
      transport as unknown as { socket: WebSocket | undefined }
    ).socket;

    expect(clientSocket).toBeDefined();
    clientSocket!.emit("error", businessError);

    expect(onError).toHaveBeenCalledWith(businessError);
    const logged = logger.entries.find(
      (entry) => entry.message === "onebot11.error",
    );
    expect(logged).toBeDefined();
    const loggedError = logged!.fields.error;
    expect(loggedError).toBeInstanceOf(Error);
    for (const secret of [
      "onebot-user-secret",
      "onebot-password-secret",
      "onebot-query-secret",
    ]) {
      expect((loggedError as Error).message).not.toContain(secret);
    }
  });

  test("does not let a stale socket close reject a new socket action", async () => {
    const { server, url } = await startServer();
    const serverSockets: WebSocket[] = [];
    const framesByConnection: OneBot11JsonObject[][] = [];
    server.on("connection", (socket) => {
      const index = serverSockets.push(socket) - 1;
      framesByConnection[index] = [];
      socket.on("message", (data) => {
        framesByConnection[index]!.push(
          JSON.parse(data.toString("utf8")) as OneBot11JsonObject,
        );
      });
    });
    const transport = new ForwardWebSocketOneBot11Transport({
      url,
      reconnectDelaysMs: [0],
    });
    transports.push(transport);
    await transport.start();
    const internals = transport as unknown as {
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

    const action = createOneBot11SendGroupTextAction(
      "20002",
      "new socket action",
      "send-group:new-socket",
    );
    const pending = transport.sendAction(action, {
      conversationId: "20002",
    });
    void pending.catch(() => undefined);
    await waitFor(
      () => framesByConnection[1]?.length === 1,
      "the replacement socket action",
    );
    staleSocket.emit("close", 1006, Buffer.from("late close"));
    serverSockets[1]!.send(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: 3 },
        echo: action.echo,
      }),
    );

    await expect(pending).resolves.toBeUndefined();
  });
});
