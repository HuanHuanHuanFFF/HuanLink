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

import type {
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexRuntimeClient,
  InterruptCodexTurnOptions,
  StartCodexThreadOptions,
  StartCodexTurnOptions
} from "../src/codex-app-server-client.js";
import { CodexTaskExecutor } from "../src/codex-task-executor.js";
import {
  startAdapterServer,
  type RunningAdapterServer
} from "../src/server.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

class ControlledCodexRuntime implements CodexRuntimeClient {
  closeCalls = 0;
  readonly discardedServerRequests: Array<string | number> = [];
  readonly interruptCalls: InterruptCodexTurnOptions[] = [];
  readonly serverResponses: Array<{
    id: string | number;
    result: unknown;
  }> = [];
  readonly startThreadCalls: StartCodexThreadOptions[] = [];
  readonly startTurnCalls: StartCodexTurnOptions[] = [];
  onStartTurn?: () => void;
  onInterrupt?: () => void;
  onRespondToServerRequest?: () => void;
  respondToServerRequestError?: Error;
  startTurnGate?: Promise<void>;
  private readonly listeners = new Set<
    (notification: CodexAppServerNotification) => void
  >();
  private readonly serverRequestListeners = new Set<
    (request: CodexAppServerRequest) => void
  >();
  private readonly closeListeners = new Set<(error: unknown) => void>();

  onClose(listener: (error: unknown) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  discardServerRequest(id: string | number): void {
    this.discardedServerRequests.push(id);
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onServerRequest(
    listener: (request: CodexAppServerRequest) => void
  ): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  async respondToServerRequest(
    id: string | number,
    result: unknown
  ): Promise<void> {
    this.serverResponses.push({ id, result });
    this.onRespondToServerRequest?.();
    if (this.respondToServerRequestError) {
      throw this.respondToServerRequestError;
    }
  }

  async startThread(
    options: StartCodexThreadOptions
  ): Promise<{ threadId: string }> {
    this.startThreadCalls.push(options);
    return { threadId: "thread-1" };
  }

  async startTurn(options: StartCodexTurnOptions): Promise<{ turnId: string }> {
    this.startTurnCalls.push(options);
    this.onStartTurn?.();
    await this.startTurnGate;
    return { turnId: "turn-1" };
  }

  async interruptTurn(options: InterruptCodexTurnOptions): Promise<void> {
    this.interruptCalls.push(options);
    this.onInterrupt?.();
  }

  emit(notification: CodexAppServerNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }

  emitServerRequest(request: CodexAppServerRequest): void {
    for (const listener of this.serverRequestListeners) {
      listener(request);
    }
  }

  emitClose(error: unknown): void {
    for (const listener of this.closeListeners) {
      listener(error);
    }
  }
}

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

function createContinuationRequest(
  task: Task,
  answers: Record<string, string[]>
) {
  return SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
      role: "ROLE_USER",
      parts: [{ data: { answers } }]
    },
    configuration: { returnImmediately: true }
  });
}

function userInputRequest(
  overrides: Partial<{ id: string; threadId: string; turnId: string }> = {}
): CodexAppServerRequest {
  return {
    id: overrides.id ?? randomUUID(),
    method: "item/tool/requestUserInput",
    params: {
      threadId: overrides.threadId ?? "thread-1",
      turnId: overrides.turnId ?? "turn-1",
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
  };
}

function scheduleInputRequest(
  runtime: ControlledCodexRuntime,
  request: CodexAppServerRequest = userInputRequest()
): void {
  runtime.onStartTurn = () => {
    setTimeout(() => {
      runtime.emit({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] }
        }
      });
      runtime.emitServerRequest(request);
    }, 0);
  };
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
  runtime: ControlledCodexRuntime,
  options: {
    cancelTimeoutMs?: number;
    logger?: RecordingRuntimeLogger;
    validateWorkspace?: () => Promise<{
      branch: string;
      workspace: string;
    }>;
  } = {}
): Promise<{ client: Client; executor: CodexTaskExecutor }> {
  const executor = new CodexTaskExecutor({
    client: runtime,
    workspace: "D:/CodingProject/HuanLink",
    expectedBranch: "spike/demo-v0",
    model: "gpt-5.4-mini",
    cancelTimeoutMs: options.cancelTimeoutMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    validateWorkspace:
      options.validateWorkspace ??
      (async () => ({
        branch: "spike/demo-v0",
        workspace: "D:/CodingProject/HuanLink"
      }))
  });
  const server = await startAdapterServer({ executor, port: 0 });
  runningServers.push(server);
  return {
    client: await new ClientFactory().createFromUrl(server.origin),
    executor
  };
}

async function waitForTaskState(
  client: Client,
  taskId: string,
  expected: TaskState
): Promise<Task> {
  await expect
    .poll(async () => {
      const task = await client.getTask(GetTaskRequest.fromJSON({ id: taskId }));
      return task.status?.state;
    })
    .toBe(expected);
  return client.getTask(GetTaskRequest.fromJSON({ id: taskId }));
}

function scheduleCompletedTurn(
  runtime: ControlledCodexRuntime,
  items: Record<string, unknown>[],
  diff?: string
): void {
  runtime.onStartTurn = () => {
    setTimeout(() => {
      runtime.emit({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] }
        }
      });
      for (const item of items) {
        runtime.emit({
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "turn-1", item }
        });
      }
      if (diff !== undefined) {
        runtime.emit({
          method: "turn/diff/updated",
          params: { threadId: "thread-1", turnId: "turn-1", diff }
        });
      }
      runtime.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] }
        }
      });
    }, 0);
  };
}

function artifactText(task: Task): string {
  const content = task.artifacts[0]?.parts[0]?.content;
  if (content?.$case !== "text") {
    throw new Error("Expected a textual Codex result Artifact");
  }
  return content.value;
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
});

describe("CodexTaskExecutor", () => {
  it("returns a submitted Task before workspace validation finishes", async () => {
    const runtime = new ControlledCodexRuntime();
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const { client } = await startClient(runtime, {
      validateWorkspace: async () => {
        await validationGate;
        return {
          branch: "spike/demo-v0",
          workspace: "D:/CodingProject/HuanLink"
        };
      }
    });

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Return immediately", true))
    );

    expect(submitted.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(runtime.startThreadCalls).toEqual([]);
    runtime.emitClose(new Error("test cleanup"));
    releaseValidation();
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_FAILED);
  });

  it("maps a real Codex turn event stream to A2A status and Artifact events", async () => {
    const runtime = new ControlledCodexRuntime();
    const logger = new RecordingRuntimeLogger();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
        runtime.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "message-1",
              text: "Implemented the focused change."
            }
          }
        });
        runtime.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "change-1",
              status: "completed",
              changes: [
                {
                  path: "apps/codex-a2a-adapter/src/example.ts",
                  diff: "+export const real = true;"
                }
              ]
            }
          }
        });
        runtime.emit({
          method: "turn/diff/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            diff: "diff --git a/example.ts b/example.ts"
          }
        });
        runtime.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items: [] }
          }
        });
      }, 0);
    };
    const { client } = await startClient(runtime, { logger });
    const events: StreamResponse[] = [];

    for await (const event of client.sendMessageStream(
      createSendRequest("Implement the focused task", false)
    )) {
      events.push(event);
    }

    expect(events.map(taskStateFrom).filter(Boolean)).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED
    ]);
    expect(runtime.startThreadCalls).toEqual([
      expect.objectContaining({
        cwd: "D:/CodingProject/HuanLink",
        model: "gpt-5.4-mini"
      })
    ]);
    expect(runtime.startTurnCalls).toEqual([
      {
        threadId: "thread-1",
        prompt: "Implement the focused task"
      }
    ]);

    const artifact = events.find(
      (event) => event.payload?.$case === "artifactUpdate"
    );
    expect(artifact?.payload?.$case).toBe("artifactUpdate");
    if (artifact?.payload?.$case !== "artifactUpdate") {
      throw new Error("Expected Codex Artifact update");
    }
    const resultArtifact = artifact.payload.value.artifact;
    expect(resultArtifact).toBeDefined();
    if (!resultArtifact) {
      throw new Error("Expected Artifact payload");
    }
    expect(resultArtifact.parts[0]?.content).toEqual({
      $case: "text",
      value: expect.stringContaining("Implemented the focused change.")
    });
    expect(resultArtifact.parts[0]?.content).toEqual({
      $case: "text",
      value: expect.stringContaining(
        "apps/codex-a2a-adapter/src/example.ts"
      )
    });
    expect(resultArtifact.parts[0]?.content).toEqual({
      $case: "text",
      value: expect.stringContaining("diff --git a/example.ts b/example.ts")
    });
    const taskEvent = events.find((event) => event.payload?.$case === "task");
    expect(taskEvent?.payload?.$case).toBe("task");
    if (taskEvent?.payload?.$case !== "task") {
      throw new Error("Expected initial task event");
    }
    const taskFields = {
      a2aTaskId: taskEvent.payload.value.id,
      contextId: taskEvent.payload.value.contextId
    };
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "adapter.task.received",
          fields: expect.objectContaining(taskFields)
        }),
        expect.objectContaining({
          level: "info",
          message: "codex.thread.ready",
          fields: expect.objectContaining({ ...taskFields, threadId: "thread-1" })
        }),
        expect.objectContaining({
          level: "info",
          message: "codex.turn.started",
          fields: expect.objectContaining({ ...taskFields, turnId: "turn-1" })
        }),
        expect.objectContaining({
          level: "info",
          message: "adapter.artifact.published",
          fields: expect.objectContaining({ ...taskFields, changedFileCount: 1 })
        }),
        expect.objectContaining({
          level: "info",
          message: "adapter.task.terminal",
          fields: expect.objectContaining({
            ...taskFields,
            state: TaskState.TASK_STATE_COMPLETED
          })
        })
      ])
    );
  });

  it("pauses for user input and continues the original A2A task and Codex turn", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
        runtime.emitServerRequest({
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
        });
      }, 0);
    };
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Ask when blocked", true))
    );
    const paused = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    expect(paused.status?.message?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: {
            $case: "text",
            value: expect.stringContaining("Which files may be changed?")
          }
        }),
        expect.objectContaining({
          content: {
            $case: "data",
            value: {
              questions: [
                expect.objectContaining({
                  id: "scope",
                  question: "Which files may be changed?"
                })
              ]
            }
          }
        })
      ])
    );
    expect(runtime.startThreadCalls).toHaveLength(1);
    expect(runtime.startTurnCalls).toHaveLength(1);

    const continued = requireTask(
      await client.sendMessage(
        createContinuationRequest(paused, { scope: ["Adapter only"] })
      )
    );
    expect(continued.id).toBe(submitted.id);
    expect(continued.contextId).toBe(submitted.contextId);
    expect(continued.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(runtime.serverResponses).toEqual([
      {
        id: "input-1",
        result: {
          answers: { scope: { answers: ["Adapter only"] } }
        }
      }
    ]);
    expect(runtime.startThreadCalls).toHaveLength(1);
    expect(runtime.startTurnCalls).toHaveLength(1);

    runtime.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: "Continued after receiving the requested scope."
        }
      }
    });
    runtime.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      }
    });

    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );
    expect(artifactText(completed)).toContain(
      "Continued after receiving the requested scope."
    );
  });

  it("does not lose a terminal turn emitted synchronously while answering user input", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleInputRequest(runtime, userInputRequest({ id: "input-race" }));
    runtime.onRespondToServerRequest = () => {
      runtime.emit({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Completed synchronously with the reverse response."
          }
        }
      });
      runtime.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] }
        }
      });
    };
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Answer without a race", true))
    );
    const paused = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    await client.sendMessage(
      createContinuationRequest(paused, { scope: ["Adapter only"] })
    );

    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );
    expect(artifactText(completed)).toContain(
      "Completed synchronously with the reverse response."
    );
  });

  it("fails and releases the original execution when answering Codex fails", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleInputRequest(runtime, userInputRequest({ id: "input-write-failure" }));
    runtime.respondToServerRequestError = new Error("response pipe closed");
    const { client, executor } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Handle response failure", true))
    );
    const paused = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    await client.sendMessage(
      createContinuationRequest(paused, { scope: ["Adapter only"] })
    );

    const failed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_FAILED
    );
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: expect.stringContaining("response pipe closed")
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await executor.close(1_000);
    expect(runtime.interruptCalls).toEqual([]);
  });

  it("discards both reverse requests when Codex asks again before the first answer", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleInputRequest(runtime, userInputRequest({ id: "input-first" }));
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Reject duplicate input", true))
    );
    await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    runtime.emitServerRequest(userInputRequest({ id: "input-second" }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.discardedServerRequests).toHaveLength(2);
    expect(new Set(runtime.discardedServerRequests)).toEqual(
      new Set(["input-first", "input-second"])
    );
    runtime.emitClose(new Error("test cleanup"));
  });

  it("does not treat turn/completed as terminal while user input is unresolved", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleInputRequest(runtime);
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Wait for my scope", true))
    );
    const paused = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    runtime.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      }
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    await expect(
      client.getTask(GetTaskRequest.fromJSON({ id: submitted.id }))
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }
    });

    const continued = requireTask(
      await client.sendMessage(
        createContinuationRequest(paused, { scope: ["Adapter only"] })
      )
    );
    expect(continued.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(runtime.startTurnCalls).toHaveLength(1);
    expect(runtime.serverResponses).toHaveLength(1);

    runtime.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: "Completed after the real continuation."
        }
      }
    });
    runtime.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      }
    });
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_COMPLETED);
  });

  it("ignores user-input requests that do not match both the active thread and turn", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
      }, 0);
    };
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Keep request routing strict", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    runtime.emitServerRequest(
      userInputRequest({ turnId: "turn-other" })
    );
    runtime.emitServerRequest(
      userInputRequest({ threadId: "thread-other" })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(
      client.getTask(GetTaskRequest.fromJSON({ id: submitted.id }))
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_WORKING }
    });
    runtime.emitClose(new Error("test cleanup"));
  });

  it("keeps the task input-required when continuation answer ids are invalid", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleInputRequest(runtime);
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Validate my response", true))
    );
    const paused = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_INPUT_REQUIRED
    );

    const firstRequest = createContinuationRequest(paused, {
      unknown: ["not allowed"]
    });
    const firstRejected = requireTask(
      await client.sendMessage(
        firstRequest
      )
    );
    const secondRejected = requireTask(
      await client.sendMessage(
        createContinuationRequest(paused, { unknown: ["still not allowed"] })
      )
    );

    expect(firstRejected.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(secondRejected.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(firstRejected.status?.message?.messageId).not.toBe(
      secondRejected.status?.message?.messageId
    );
    expect(runtime.serverResponses).toEqual([]);
    expect(runtime.startThreadCalls).toHaveLength(1);
    expect(runtime.startTurnCalls).toHaveLength(1);
    runtime.emitClose(new Error("test cleanup"));
  });

  it.each([
    ["failed", TaskState.TASK_STATE_FAILED],
    ["interrupted", TaskState.TASK_STATE_CANCELED]
  ] as const)(
    "honors a real %s turn terminal while user input is pending",
    async (turnStatus, expectedState) => {
      const runtime = new ControlledCodexRuntime();
      scheduleInputRequest(runtime);
      const { client } = await startClient(runtime);
      const submitted = requireTask(
        await client.sendMessage(createSendRequest("Observe the real terminal", true))
      );
      await waitForTaskState(
        client,
        submitted.id,
        TaskState.TASK_STATE_INPUT_REQUIRED
      );
      const controller = new AbortController();
      const iterator = client
        .resubscribeTask(
          SubscribeToTaskRequest.fromJSON({ id: submitted.id }),
          { signal: controller.signal }
        )
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          payload: {
            $case: "task",
            value: { status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } }
          }
        }
      });
      const nextEvent = iterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));

      runtime.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: turnStatus,
            error:
              turnStatus === "failed"
                ? { message: "Codex turn failed while awaiting input" }
                : undefined,
            items: []
          }
        }
      });
      try {
        await expect(nextEvent).resolves.toMatchObject({
          done: false,
          value: {
            payload: {
              $case: "statusUpdate",
              value: { status: { state: expectedState } }
            }
          }
        });
      } finally {
        controller.abort();
        runtime.emitClose(new Error("test cleanup"));
      }
    }
  );

  it.each(["cancel", "close"] as const)(
    "discards pending app-server input when the task ends through %s",
    async (mode) => {
      const runtime = new ControlledCodexRuntime();
      scheduleInputRequest(runtime);
      runtime.onInterrupt = () => {
        setTimeout(() => {
          runtime.emit({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "interrupted", items: [] }
            }
          });
        }, 0);
      };
      const { client, executor } = await startClient(runtime);
      const submitted = requireTask(
        await client.sendMessage(createSendRequest("Clean up pending input", true))
      );
      await waitForTaskState(
        client,
        submitted.id,
        TaskState.TASK_STATE_INPUT_REQUIRED
      );
      const controller = new AbortController();
      const iterator = client
        .resubscribeTask(
          SubscribeToTaskRequest.fromJSON({ id: submitted.id }),
          { signal: controller.signal }
        )
        [Symbol.asyncIterator]();
      await iterator.next();
      const terminalEvent = iterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));

      try {
        if (mode === "cancel") {
          await client.cancelTask(
            CancelTaskRequest.fromJSON({ id: submitted.id })
          );
        } else {
          await executor.close(1_000);
        }

        expect(runtime.discardedServerRequests).toHaveLength(1);
        await expect(terminalEvent).resolves.toMatchObject({
          done: false,
          value: {
            payload: {
              $case: "statusUpdate",
              value: { status: { state: TaskState.TASK_STATE_CANCELED } }
            }
          }
        });
      } finally {
        controller.abort();
      }
    }
  );

  it("uses the non-empty final answer and never lets empty agent messages overwrite it", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleCompletedTurn(runtime, [
      {
        type: "agentMessage",
        phase: "commentary",
        text: "Working through the edge case."
      },
      { type: "agentMessage", phase: "commentary", text: "   " },
      {
        type: "agentMessage",
        phase: "final_answer",
        text: "Implemented the focused change."
      },
      { type: "agentMessage", phase: "final_answer", text: "" }
    ]);
    const { client } = await startClient(runtime);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Complete without edits", true))
    );
    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );

    expect(artifactText(completed)).toContain(
      "Summary:\nImplemented the focused change."
    );
    expect(artifactText(completed)).toContain(
      "Last commentary:\nWorking through the edge case."
    );
    expect(runtime.startThreadCalls[0]?.developerInstructions).toContain(
      "Make minor implementation or wording choices yourself instead of pausing to ask."
    );
    expect(runtime.startThreadCalls[0]?.developerInstructions).toContain(
      "When genuinely blocked by missing user input, use request_user_input."
    );
  });

  it("keeps phase-less agent messages compatible and ignores a later empty message", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleCompletedTurn(runtime, [
      { type: "agentMessage", text: "Legacy app-server final answer." },
      { type: "agentMessage", text: "  " }
    ]);
    const { client } = await startClient(runtime);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Use legacy messages", true))
    );
    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );

    expect(artifactText(completed)).toContain(
      "Summary:\nLegacy app-server final answer."
    );
  });

  it("treats a null agent message phase as a legacy final answer", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleCompletedTurn(runtime, [
      {
        type: "agentMessage",
        phase: null,
        text: "Null-phase app-server final answer."
      }
    ]);
    const { client } = await startClient(runtime);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Use a null message phase", true))
    );
    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );

    expect(artifactText(completed)).toContain(
      "Summary:\nNull-phase app-server final answer."
    );
  });

  it("ignores unknown agent message phases without replacing or creating a result", async () => {
    const runtimeWithFinal = new ControlledCodexRuntime();
    scheduleCompletedTurn(runtimeWithFinal, [
      {
        type: "agentMessage",
        phase: "final_answer",
        text: "Known final answer."
      },
      {
        type: "agentMessage",
        phase: "unknown_phase",
        text: "Unknown phase must be ignored."
      }
    ]);
    const { client: clientWithFinal } = await startClient(runtimeWithFinal);

    const submittedWithFinal = requireTask(
      await clientWithFinal.sendMessage(
        createSendRequest("Keep the known final answer", true)
      )
    );
    const completed = await waitForTaskState(
      clientWithFinal,
      submittedWithFinal.id,
      TaskState.TASK_STATE_COMPLETED
    );

    expect(artifactText(completed)).toContain("Summary:\nKnown final answer.");
    expect(artifactText(completed)).not.toContain(
      "Unknown phase must be ignored."
    );

    const unknownOnlyRuntime = new ControlledCodexRuntime();
    scheduleCompletedTurn(unknownOnlyRuntime, [
      {
        type: "agentMessage",
        phase: "unknown_phase",
        text: "Unknown phase is not a meaningful result."
      }
    ]);
    const { client: unknownOnlyClient } = await startClient(unknownOnlyRuntime);

    const unknownOnlySubmitted = requireTask(
      await unknownOnlyClient.sendMessage(
        createSendRequest("Return only an unknown phase", true)
      )
    );
    const failed = await waitForTaskState(
      unknownOnlyClient,
      unknownOnlySubmitted.id,
      TaskState.TASK_STATE_FAILED
    );

    expect(failed.artifacts).toEqual([]);
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Codex turn completed without a final answer or any reported changes."
    });
  });

  it("completes with reported changes even when Codex emits no final answer", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleCompletedTurn(
      runtime,
      [
        {
          type: "agentMessage",
          phase: "commentary",
          text: "Applied the requested edit."
        },
        { type: "agentMessage", phase: "final_answer", text: " " },
        {
          type: "fileChange",
          status: "completed",
          changes: [{ path: "apps/codex-a2a-adapter/src/example.ts" }]
        }
      ],
      "diff --git a/example.ts b/example.ts"
    );
    const { client } = await startClient(runtime);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Edit the example", true))
    );
    const completed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_COMPLETED
    );
    const result = artifactText(completed);

    expect(result).toContain(
      "Summary:\nCodex completed without a final answer."
    );
    expect(result).toContain(
      "Last commentary:\nApplied the requested edit."
    );
    expect(result).toContain("apps/codex-a2a-adapter/src/example.ts");
    expect(result).toContain("diff --git a/example.ts b/example.ts");
  });

  it("fails without an Artifact when Codex returns commentary but no answer or changes", async () => {
    const runtime = new ControlledCodexRuntime();
    scheduleCompletedTurn(runtime, [
      {
        type: "agentMessage",
        phase: "commentary",
        text: "Investigated the request but produced no result."
      },
      { type: "agentMessage", phase: "commentary", text: "" },
      { type: "agentMessage", phase: "final_answer", text: "   " }
    ]);
    const { client } = await startClient(runtime);

    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Return an honest result", true))
    );
    const failed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_FAILED
    );

    expect(failed.artifacts).toEqual([]);
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value:
        "Codex turn completed without a final answer or any reported changes. Last commentary: Investigated the request but produced no result."
    });
  });

  it("keeps the active thread mapping when a conflicting task is rejected", async () => {
    const runtime = new ControlledCodexRuntime();
    let releaseFirstTurn!: () => void;
    runtime.startTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const { client } = await startClient(runtime);
    const first = requireTask(
      await client.sendMessage(createSendRequest("First active task", true))
    );
    await expect.poll(() => runtime.startTurnCalls).toHaveLength(1);

    const conflicting = requireTask(
      await client.sendMessage(createSendRequest("Conflicting task", true))
    );
    const rejected = await waitForTaskState(
      client,
      conflicting.id,
      TaskState.TASK_STATE_FAILED
    );
    expect(rejected.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Codex thread thread-1 already has an active task"
    });

    runtime.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-before-start-response",
          text: "The first task retained its early notification."
        }
      }
    });
    releaseFirstTurn();
    await waitForTaskState(client, first.id, TaskState.TASK_STATE_WORKING);
    runtime.emit({
      method: "turn/diff/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "diff --git a/first.ts b/first.ts"
      }
    });
    runtime.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      }
    });

    const completed = await waitForTaskState(
      client,
      first.id,
      TaskState.TASK_STATE_COMPLETED
    );
    expect(completed.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "text",
      value: expect.stringContaining(
        "The first task retained its early notification."
      )
    });
  });

  it("waits for Codex interrupted before publishing A2A canceled", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
      }, 0);
    };
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Cancel the real turn", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    const canceling = client.cancelTask(
      CancelTaskRequest.fromJSON({ id: submitted.id })
    );
    await expect.poll(() => runtime.interruptCalls).toEqual([
      { threadId: "thread-1", turnId: "turn-1" }
    ]);
    expect(
      (await client.getTask(GetTaskRequest.fromJSON({ id: submitted.id }))).status
        ?.state
    ).toBe(TaskState.TASK_STATE_WORKING);

    runtime.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted", items: [] }
      }
    });

    await expect(canceling).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
  });

  it("fails an active A2A task when the app-server connection closes", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
      }, 0);
    };
    const { client } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Observe app-server exit", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    runtime.emitClose(new Error("app-server exited with code 1"));

    const failed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_FAILED
    );
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value:
        "Codex app-server connection closed: app-server exited with code 1"
    });
  });

  it("interrupts active turns and waits for their terminal event on shutdown", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
      }, 0);
    };
    runtime.onInterrupt = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted", items: [] }
          }
        });
      }, 0);
    };
    const { client, executor } = await startClient(runtime);
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Shutdown active turn", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    await executor.close(1_000);

    expect(runtime.interruptCalls).toEqual([
      { threadId: "thread-1", turnId: "turn-1" }
    ]);
    await expect(
      client.getTask(GetTaskRequest.fromJSON({ id: submitted.id }))
    ).resolves.toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
  });

  it("fails cancellation deterministically when interrupted never arrives", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
      }, 0);
    };
    const { client } = await startClient(runtime, { cancelTimeoutMs: 25 });
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Timeout cancellation", true))
    );
    await waitForTaskState(client, submitted.id, TaskState.TASK_STATE_WORKING);

    await expect(
      client.cancelTask(CancelTaskRequest.fromJSON({ id: submitted.id }))
    ).rejects.toThrow("Task not cancelable");

    const failed = await client.getTask(
      GetTaskRequest.fromJSON({ id: submitted.id })
    );
    expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Timed out waiting for Codex interrupted terminal status"
    });
    expect(runtime.closeCalls).toBe(1);
  });

  it("revalidates the branch before publishing a completed task", async () => {
    const runtime = new ControlledCodexRuntime();
    runtime.onStartTurn = () => {
      setTimeout(() => {
        runtime.emit({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress", items: [] }
          }
        });
        runtime.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items: [] }
          }
        });
      }, 0);
    };
    let validations = 0;
    const { client } = await startClient(runtime, {
      validateWorkspace: async () => {
        validations += 1;
        if (validations === 2) {
          throw new Error("Expected branch spike/demo-v0, found main");
        }
        return {
          branch: "spike/demo-v0",
          workspace: "D:/CodingProject/HuanLink"
        };
      }
    });
    const submitted = requireTask(
      await client.sendMessage(createSendRequest("Guard completion", true))
    );

    const failed = await waitForTaskState(
      client,
      submitted.id,
      TaskState.TASK_STATE_FAILED
    );
    expect(validations).toBe(2);
    expect(failed.artifacts).toEqual([]);
    expect(failed.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value:
        "Workspace changed before Codex completion: Expected branch spike/demo-v0, found main"
    });
  });
});
