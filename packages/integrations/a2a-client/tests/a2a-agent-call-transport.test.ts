import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  TaskState,
  type Artifact,
  type Task
} from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  TaskNotCancelableError,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../../../../apps/codex-a2a-adapter/src/server.js";
import { A2aAgentCallTransport } from "../src/index.js";

const servers: RunningAdapterServer[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GateExecutor implements AgentExecutor {
  private readonly contexts = new Map<string, string>();

  constructor(private readonly gate: Promise<void>) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { contextId, taskId, userMessage } = requestContext;
    this.contexts.set(taskId, contextId);
    const initial: Task = {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString()
      },
      artifacts: [],
      history: [userMessage],
      metadata: undefined
    };
    eventBus.publish(AgentEvent.task(initial));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );

    await this.gate;

    const artifact: Artifact = {
      artifactId: "code-result-01",
      name: "Code result",
      description: "Controlled Phase 3 result",
      parts: [
        {
          content: { $case: "text", value: "changed src/example.ts" },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain"
        }
      ],
      metadata: undefined,
      extensions: []
    };
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined
      })
    );
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const contextId = this.contexts.get(taskId);
    if (!contextId) {
      throw new TaskNotCancelableError(`Task ${taskId} is not running`);
    }
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );
    eventBus.finished();
  }
}

async function startTransport(executor: AgentExecutor) {
  const server = await startAdapterServer({ executor, port: 0 });
  servers.push(server);
  return new A2aAgentCallTransport({ origin: server.origin });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("A2aAgentCallTransport", () => {
  test("discovers the Codex skill and observes a standard Task to its final Artifact", async () => {
    const completion = deferred();
    const transport = await startTransport(new GateExecutor(completion.promise));

    const capability = await transport.discoverCapability("codex-code-task");
    expect(capability).toMatchObject({
      id: "codex-code-task",
      name: "Codex code task"
    });

    const submitted = await transport.submitTask({
      messageId: "message-phase3-01",
      skillId: capability.id,
      input: "make a focused code change",
      contextId: "session-phase3-01"
    });
    expect(submitted.taskId).not.toBe("");
    expect(["submitted", "working"]).toContain(submitted.state);
    expect(submitted.contextId).toBe("session-phase3-01");

    const iterator = transport
      .watchTask(submitted.taskId, { signal: new AbortController().signal })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(["submitted", "working"]).toContain(first.value?.state);

    completion.resolve();
    const snapshots = first.value ? [first.value] : [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      snapshots.push(next.value);
    }

    expect(snapshots.at(-1)).toMatchObject({
      taskId: submitted.taskId,
      state: "completed",
      artifacts: [
        {
          id: "code-result-01",
          name: "Code result",
          text: "changed src/example.ts"
        }
      ]
    });
  });

  test("reconciles a task that completed before the subscription began", async () => {
    const transport = await startTransport(new GateExecutor(Promise.resolve()));
    const submitted = await transport.submitTask({
      messageId: "message-phase3-fast",
      skillId: "codex-code-task",
      input: "finish immediately"
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshots = [];
    for await (const snapshot of transport.watchTask(submitted.taskId, {
      signal: new AbortController().signal
    })) {
      snapshots.push(snapshot);
    }

    expect(snapshots.at(-1)).toMatchObject({
      state: "completed",
      artifacts: [{ text: "changed src/example.ts" }]
    });
  });

  test("rejects a capability that is absent from the discovered Agent Card", async () => {
    const transport = await startTransport(new GateExecutor(Promise.resolve()));

    await expect(
      transport.discoverCapability("not-a-real-skill")
    ).rejects.toThrow(/not-a-real-skill/);
  });

  test("keeps reconciling when a subscription ends before the terminal snapshot is visible", async () => {
    const getTask = vi
      .fn<() => Promise<Task>>()
      .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_WORKING))
      .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_COMPLETED));
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      async *resubscribeTask() {},
      getTask
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({ origin: "http://127.0.0.1:1" });

    const snapshots = [];
    for await (const snapshot of transport.watchTask("a2a-task-lagging", {
      signal: new AbortController().signal
    })) {
      snapshots.push(snapshot);
    }

    expect(getTask).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([
      expect.objectContaining({
        taskId: "a2a-task-lagging",
        state: "completed"
      })
    ]);
  });

  test("retries Agent Card discovery after an initial connection failure", async () => {
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      getAgentCard: vi.fn(async () => testAgentCard())
    } as unknown as Client;
    const createFromUrl = vi
      .spyOn(ClientFactory.prototype, "createFromUrl")
      .mockRejectedValueOnce(new Error("adapter is still starting"))
      .mockResolvedValueOnce(client);
    const transport = new A2aAgentCallTransport({ origin: "http://127.0.0.1:1" });

    await expect(transport.discoverCapability("codex-code-task")).rejects.toThrow(
      /still starting/
    );
    await expect(
      transport.discoverCapability("codex-code-task")
    ).resolves.toMatchObject({ id: "codex-code-task" });
    expect(createFromUrl).toHaveBeenCalledTimes(2);
  });
});

function remoteTask(state: TaskState): Task {
  return {
    id: "a2a-task-lagging",
    contextId: "a2a-context-lagging",
    status: {
      state,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

function testAgentCard() {
  return AgentCard.fromJSON({
    name: "Test Codex Adapter",
    description: "A2A client recovery test",
    version: "0.0.0",
    supportedInterfaces: [
      {
        url: "http://127.0.0.1:1/a2a/jsonrpc",
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION
      }
    ],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "codex-code-task",
        name: "Codex code task",
        description: "Test skill",
        tags: ["test"]
      }
    ]
  });
}
