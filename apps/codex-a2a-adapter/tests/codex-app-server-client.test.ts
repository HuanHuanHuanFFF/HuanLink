import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  spawnCodexAppServerTransport,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerTransport
} from "../src/codex-app-server-client.js";

interface TestTransport {
  client: CodexAppServerTransport;
  fromClient: PassThrough;
  toClient: PassThrough;
}

interface WriteFailingTestTransport extends TestTransport {
  closeCalls(): number;
  failNextWrite(error: Error): void;
}

function createTestTransport(): TestTransport {
  const fromClient = new PassThrough();
  const toClient = new PassThrough();

  return {
    client: {
      stdin: fromClient,
      stdout: toClient,
      stderr: new PassThrough(),
      async close() {
        fromClient.end();
        toClient.end();
      }
    },
    fromClient,
    toClient
  };
}

function createWriteFailingTestTransport(): WriteFailingTestTransport {
  const fromClient = new PassThrough();
  const toClient = new PassThrough();
  let closeCalls = 0;
  let nextWriteError: Error | undefined;
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = undefined;
        callback(error);
        return;
      }
      fromClient.write(chunk, encoding);
      callback();
    }
  });
  stdin.on("error", () => undefined);

  return {
    client: {
      stdin,
      stdout: toClient,
      stderr: new PassThrough(),
      async close() {
        closeCalls += 1;
        stdin.destroy();
        fromClient.end();
        toClient.end();
      }
    },
    closeCalls: () => closeCalls,
    failNextWrite(error) {
      nextWriteError = error;
    },
    fromClient,
    toClient
  };
}

function createJsonLineReader(stream: PassThrough) {
  const lines = createInterface({ input: stream })[Symbol.asyncIterator]();
  return async (): Promise<Record<string, unknown>> => {
    const next = await lines.next();
    if (next.done) {
      throw new Error("Stream ended before a JSONL message arrived");
    }
    return JSON.parse(next.value) as Record<string, unknown>;
  };
}

describe("CodexAppServerClient", () => {
  it("completes initialize/initialized before becoming ready", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });

    const initialize = await readFromClient();
    expect(initialize).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "huanlink_codex_a2a_adapter",
          title: "HuanLink Codex A2A Adapter",
          version: "0.2.0"
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      }
    });

    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );

    const initialized = await readFromClient();
    expect(initialized).toEqual({ method: "initialized" });

    const client = await connecting;
    await client.close();
  });

  it("starts threads and turns, streams notifications, and interrupts turns", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;

    const notifications: CodexAppServerNotification[] = [];
    client.onNotification((notification) => notifications.push(notification));

    const startingThread = client.startThread({
      cwd: "D:/CodingProject/HuanLink",
      developerInstructions: "Stay on spike/demo-v0. Do not commit or push.",
      model: "gpt-5.4-mini"
    });
    const threadRequest = await readFromClient();
    expect(threadRequest).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "D:/CodingProject/HuanLink",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
        developerInstructions: "Stay on spike/demo-v0. Do not commit or push.",
        model: "gpt-5.4-mini"
      }
    });
    transport.toClient.write(
      `${JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "thread-1" } }
      })}\n`
    );
    transport.toClient.write(
      `${JSON.stringify({
        id: threadRequest.id,
        result: { thread: { id: "thread-1" } }
      })}\n`
    );
    await expect(startingThread).resolves.toEqual({ threadId: "thread-1" });
    await expect.poll(() => notifications).toContainEqual({
      method: "thread/started",
      params: { thread: { id: "thread-1" } }
    });

    const startingTurn = client.startTurn({
      threadId: "thread-1",
      prompt: "Implement the focused task"
    });
    const turnRequest = await readFromClient();
    expect(turnRequest).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Implement the focused task",
            text_elements: []
          }
        ]
      }
    });
    transport.toClient.write(
      `${JSON.stringify({
        id: turnRequest.id,
        result: { turn: { id: "turn-1", status: "inProgress", items: [] } }
      })}\n`
    );
    await expect(startingTurn).resolves.toEqual({ turnId: "turn-1" });

    const interrupting = client.interruptTurn({
      threadId: "thread-1",
      turnId: "turn-1"
    });
    const interruptRequest = await readFromClient();
    expect(interruptRequest).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" }
    });
    transport.toClient.write(
      `${JSON.stringify({ id: interruptRequest.id, result: {} })}\n`
    );
    await interrupting;

    await client.close();
  });

  it("owns the lifecycle of a spawned stdio app-server process", async () => {
    const scriptFixture = fileURLToPath(
      new URL("./fixtures/scripted-app-server.mjs", import.meta.url)
    );
    const commandFixture = fileURLToPath(
      new URL("./fixtures/scripted-app-server.cmd", import.meta.url)
    );
    const transport = spawnCodexAppServerTransport({
      executable: process.platform === "win32" ? commandFixture : process.execPath,
      args: process.platform === "win32" ? [] : [scriptFixture],
      cwd: process.cwd(),
      shutdownTimeoutMs: 1_000
    });

    const client = await CodexAppServerClient.connect({
      transport,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });

    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("separates user-input server requests from notifications and answers the same request id", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;

    const notifications: unknown[] = [];
    const requests: CodexAppServerRequest[] = [];
    client.onNotification((notification) => notifications.push(notification));
    client.onServerRequest((request) => requests.push(request));

    transport.toClient.write(
      `${JSON.stringify({
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1" }
      })}\n`
    );
    transport.toClient.write(
      `${JSON.stringify({
        id: "input-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files may be changed?",
              isOther: false,
              isSecret: false,
              options: [
                {
                  label: "Adapter only",
                  description: "Limit changes to the Codex adapter."
                }
              ]
            }
          ],
          autoResolutionMs: null
        }
      })}\n`
    );

    await expect.poll(() => requests).toHaveLength(1);
    expect(notifications).toEqual([
      {
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1" }
      }
    ]);
    expect(requests[0]).toMatchObject({
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          expect.objectContaining({ id: "scope", question: "Which files may be changed?" })
        ]
      }
    });

    await client.respondToServerRequest("input-1", {
      answers: { scope: { answers: ["Adapter only"] } }
    });
    await expect(readFromClient()).resolves.toEqual({
      id: "input-1",
      result: { answers: { scope: { answers: ["Adapter only"] } } }
    });

    await client.close();
  });

  it("discards an unresolved server request without sending a response", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;
    const requests: unknown[] = [];
    client.onServerRequest((request) => requests.push(request));

    transport.toClient.write(
      `${JSON.stringify({
        id: "input-discard",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which files may be changed?",
              isOther: false,
              isSecret: false,
              options: null
            }
          ],
          autoResolutionMs: null
        }
      })}\n`
    );
    await expect.poll(() => requests).toHaveLength(1);

    client.discardServerRequest("input-discard");

    await expect(
      client.respondToServerRequest("input-discard", {
        answers: { scope: { answers: ["Adapter only"] } }
      })
    ).rejects.toThrow(/Unknown or already answered/);
    await client.close();
  });

  it("fails the connection for every subscriber when a server response write fails", async () => {
    const transport = createWriteFailingTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;
    const requests: CodexAppServerRequest[] = [];
    const executorFailures: unknown[] = [];
    client.onServerRequest((request) => requests.push(request));
    client.onClose((error) => executorFailures.push(error));
    client.onClose((error) => executorFailures.push(error));

    for (const id of ["input-write-failure", "input-still-pending"]) {
      transport.toClient.write(
        `${JSON.stringify({
          id,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: `item-${id}`,
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which files may be changed?",
                isOther: false,
                isSecret: false,
                options: null
              }
            ],
            autoResolutionMs: null
          }
        })}\n`
      );
    }
    await expect.poll(() => requests).toHaveLength(2);

    const writeFailure = new Error("server response write failed");
    const answer = { answers: { scope: { answers: ["Adapter only"] } } };
    transport.failNextWrite(writeFailure);

    try {
      await expect(
        client.respondToServerRequest("input-write-failure", answer)
      ).rejects.toBe(writeFailure);
      await expect.poll(() => executorFailures).toHaveLength(2);
      expect(executorFailures).toEqual([writeFailure, writeFailure]);
      expect(transport.closeCalls()).toBe(1);
      await expect(
        client.respondToServerRequest("input-still-pending", answer)
      ).rejects.toThrow(/Unknown or already answered/);
      await expect(
        client.respondToServerRequest("input-write-failure", answer)
      ).rejects.toThrow(/Unknown or already answered/);
    } finally {
      await client.close();
    }
  });

  it("fails closed when app-server sends an unsupported reverse request", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;

    transport.toClient.write(
      `${JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 1
        }
      })}\n`
    );

    await expect(readFromClient()).resolves.toEqual({
      id: "approval-1",
      error: {
        code: -32601,
        message:
          "Unsupported Codex app-server request: item/commandExecution/requestApproval"
      }
    });

    await client.close();
  });

  it("rejects a similar but non-matching app-server version", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.50",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );

    await expect(connecting).rejects.toThrow(
      "Unexpected Codex app-server version: codex-cli/0.142.50; expected 0.142.5"
    );
  });

  it("reports an unexpected app-server stdout close", async () => {
    const transport = createTestTransport();
    const readFromClient = createJsonLineReader(transport.fromClient);
    const connecting = CodexAppServerClient.connect({
      transport: transport.client,
      expectedVersion: "0.142.5",
      requestTimeoutMs: 1_000
    });
    const initialize = await readFromClient();
    transport.toClient.write(
      `${JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
    await readFromClient();
    const client = await connecting;
    const closes: unknown[] = [];
    client.onClose((error) => closes.push(error));

    transport.toClient.end();

    await expect.poll(() => closes).toHaveLength(1);
    expect(closes[0]).toBeInstanceOf(Error);
    expect((closes[0] as Error).message).toContain(
      "Codex app-server stdout closed"
    );
    await expect(client.close()).resolves.toBeUndefined();
  });
});
