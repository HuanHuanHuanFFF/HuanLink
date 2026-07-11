import { randomUUID } from "node:crypto";

import {
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState,
  type SendMessageResult,
  type StreamResponse,
  type Task
} from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../src/server.js";
import {
  CONTROLLED_RESPONSE,
  ControlledTaskExecutor
} from "./support/controlled-task-executor.js";

const runningServers: RunningAdapterServer[] = [];

function createSendRequest(text: string, returnImmediately: boolean) {
  return SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }]
    },
    configuration: { returnImmediately }
  });
}

function requireTask(result: SendMessageResult): Task {
  if (!("status" in result)) {
    throw new Error("Expected the A2A server to create a Task");
  }
  return result;
}

function taskStateFrom(event: StreamResponse): TaskState | undefined {
  if (event.payload?.$case === "task") {
    return event.payload.value.status?.state;
  }
  if (event.payload?.$case === "statusUpdate") {
    return event.payload.value.status?.state;
  }
  return undefined;
}

async function startClient(
  executor = new ControlledTaskExecutor()
): Promise<{ client: Client; server: RunningAdapterServer }> {
  const server = await startAdapterServer({ executor, port: 0 });
  runningServers.push(server);
  const client = await new ClientFactory().createFromUrl(server.origin);
  return { client, server };
}

async function waitForTaskState(
  client: Client,
  taskId: string,
  expected: TaskState
): Promise<Task> {
  const deadline = Date.now() + 2_000;
  do {
    const task = await client.getTask(GetTaskRequest.fromJSON({ id: taskId }));
    if (task.status?.state === expected) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error(`Task ${taskId} did not reach state ${expected}`);
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("Codex A2A adapter task lifecycle", () => {
  it("streams submitted -> working -> completed and persists the artifact", async () => {
    const { client } = await startClient();
    const events: StreamResponse[] = [];

    for await (const event of client.sendMessageStream(
      createSendRequest("run the Phase 1 fixed task", false)
    )) {
      events.push(event);
    }

    expect(events.map(taskStateFrom).filter((state) => state !== undefined)).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED
    ]);

    const taskEvent = events.find((event) => event.payload?.$case === "task");
    expect(taskEvent?.payload?.$case).toBe("task");
    if (taskEvent?.payload?.$case !== "task") {
      throw new Error("Expected an initial Task event");
    }

    const artifactEvent = events.find(
      (event) => event.payload?.$case === "artifactUpdate"
    );
    expect(artifactEvent?.payload?.$case).toBe("artifactUpdate");

    const persisted = await client.getTask(
      GetTaskRequest.fromJSON({ id: taskEvent.payload.value.id })
    );
    expect(persisted.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(persisted.artifacts).toHaveLength(1);
    expect(persisted.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "text",
      value: CONTROLLED_RESPONSE
    });
  });

  it("subscribes to a working task and observes its terminal update", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new ControlledTaskExecutor({
      waitBeforeComplete: async () => gate
    });
    const { client } = await startClient(executor);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("wait for subscription", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    const subscription = client.resubscribeTask(
      SubscribeToTaskRequest.fromJSON({ id: submitted.id })
    );
    const first = await subscription.next();

    expect(first.done).toBe(false);
    expect(first.value?.payload?.$case).toBe("task");
    if (first.value?.payload?.$case !== "task") {
      throw new Error("Expected subscription to begin with the full Task");
    }
    expect(first.value.payload.value.status?.state).toBe(
      TaskState.TASK_STATE_WORKING
    );

    release();
    const remaining: StreamResponse[] = [];
    for await (const event of subscription) {
      remaining.push(event);
    }

    expect(remaining.some((event) => event.payload?.$case === "artifactUpdate")).toBe(
      true
    );
    expect(remaining.map(taskStateFrom)).toContain(
      TaskState.TASK_STATE_COMPLETED
    );
  });

  it("cancels a default task with the standard canceled state", async () => {
    const { client } = await startClient();

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("cancel this task", true))
    );
    expect(submitted.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);

    const canceled = await client.cancelTask(
      CancelTaskRequest.fromJSON({ id: submitted.id })
    );

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const persisted = await client.getTask(
      GetTaskRequest.fromJSON({ id: submitted.id })
    );
    expect(persisted.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(persisted.artifacts).toEqual([]);
  });

  it("does not complete after a controlled cancellation", async () => {
    const executor = new ControlledTaskExecutor({
      waitBeforeComplete: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        })
    });
    const { client } = await startClient(executor);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("hold until canceled", true))
    );
    const canceled = await client.cancelTask(
      CancelTaskRequest.fromJSON({ id: submitted.id })
    );

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const persisted = await client.getTask(
      GetTaskRequest.fromJSON({ id: submitted.id })
    );
    expect(persisted.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(persisted.artifacts).toEqual([]);
  });
});
