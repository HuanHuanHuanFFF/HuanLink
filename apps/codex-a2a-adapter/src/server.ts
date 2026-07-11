import { createServer, type Server } from "node:http";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler
} from "@a2a-js/sdk/server/express";
import express from "express";

import { createAgentCard } from "./agent-card.js";
import { FixedTaskExecutor } from "./fixed-task-executor.js";

export interface StartAdapterServerOptions {
  executor?: AgentExecutor;
  host?: string;
  port?: number;
}

export interface RunningAdapterServer {
  origin: string;
  close(): Promise<void>;
}

export async function startAdapterServer(
  options: StartAdapterServerOptions = {}
): Promise<RunningAdapterServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4000;
  const app = express();
  const httpServer = createServer(app);

  await listen(httpServer, host, port);

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await close(httpServer);
    throw new Error("Adapter server did not expose a TCP address");
  }

  try {
    const origin = `http://${formatHost(host)}:${address.port}`;
    const agentCard = createAgentCard(origin);
    const requestHandler = new DefaultRequestHandler(
      agentCard,
      new InMemoryTaskStore(),
      options.executor ?? new FixedTaskExecutor()
    );

    app.use(
      `/${AGENT_CARD_PATH}`,
      agentCardHandler({ agentCardProvider: requestHandler })
    );
    app.use(
      "/a2a/jsonrpc",
      jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication
      })
    );

    return {
      origin,
      close: () => close(httpServer)
    };
  } catch (error) {
    await close(httpServer);
    throw error;
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
