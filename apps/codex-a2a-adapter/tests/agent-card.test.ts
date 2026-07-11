import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClientFactory } from "@a2a-js/sdk/client";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../src/server.js";

describe("Codex A2A adapter Agent Card", () => {
  let server: RunningAdapterServer | undefined;

  beforeAll(async () => {
    server = await startAdapterServer({ port: 0 });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("is discovered by the official A2A client as JSON-RPC v1.0", async () => {
    if (!server) {
      throw new Error("Adapter server did not start");
    }
    const client = await new ClientFactory().createFromUrl(server.origin);
    const card = await client.getAgentCard();

    expect(client.protocolVersion).toBe("1.0");
    expect(card.name).toBe("HuanLink Codex A2A Adapter");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.supportedInterfaces).toEqual([
      {
        url: `${server.origin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: ""
      }
    ]);
    expect(card.skills.map((skill) => skill.id)).toEqual([
      "phase-1-fixed-response"
    ]);
  });

  it("serves the standard well-known Agent Card path", async () => {
    if (!server) {
      throw new Error("Adapter server did not start");
    }
    const response = await fetch(
      `${server.origin}/.well-known/agent-card.json`,
      { headers: { "A2A-Version": "1.0" } }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      name: "HuanLink Codex A2A Adapter",
      supportedInterfaces: [
        {
          url: `${server.origin}/a2a/jsonrpc`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0"
        }
      ]
    });
  });
});
