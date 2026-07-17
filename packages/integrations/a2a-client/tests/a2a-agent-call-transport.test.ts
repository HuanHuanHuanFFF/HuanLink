import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Message,
  SendMessageRequest,
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
import {
  AgentCallService,
  type AgentCallTaskState,
  type AgentCallTaskSnapshot,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger
} from "@huanlink/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  startAdapterServer,
  type RunningAdapterServer
} from "../../../../apps/codex-a2a-adapter/src/server.js";
import { A2aAgentCallTransport } from "../src/index.js";

const servers: RunningAdapterServer[] = [];

type RecordedLogEntry = {
  level: RuntimeLogLevel;
  message: string;
  fields: RuntimeLogFields;
};

class RecordingLogger implements RuntimeLogger {
  constructor(
    readonly entries: RecordedLogEntry[] = [],
    private readonly bindings: RuntimeLogFields = {}
  ) {}

  debug(message: string, fields?: RuntimeLogFields): void {
    this.record("debug", message, fields);
  }

  info(message: string, fields?: RuntimeLogFields): void {
    this.record("info", message, fields);
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    this.record("warn", message, fields);
  }

  error(message: string, fields?: RuntimeLogFields): void {
    this.record("error", message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new RecordingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  private record(
    level: RuntimeLogLevel,
    message: string,
    fields: RuntimeLogFields = {}
  ): void {
    this.entries.push({
      level,
      message,
      fields: { ...this.bindings, ...fields }
    });
  }
}

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

class PauseThenContinueExecutor implements AgentExecutor {
  private taskId: string | undefined;
  private contextId: string | undefined;

  constructor(private readonly completionGate: Promise<void>) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { contextId, taskId, userMessage } = requestContext;
    if (this.taskId === undefined) {
      this.taskId = taskId;
      this.contextId = contextId;
      eventBus.publish(
        AgentEvent.task({
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
        })
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            message: Message.fromJSON({
              messageId: `${taskId}-input`,
              taskId,
              contextId,
              role: "ROLE_AGENT",
              parts: [
                { text: "Scope: Which files may be changed?" },
                {
                  data: {
                    questions: [
                      {
                        id: "scope",
                        header: "Scope",
                        question: "Which files may be changed?",
                        isOther: false,
                        isSecret: false,
                        options: null
                      }
                    ]
                  }
                }
              ]
            }),
            timestamp: new Date().toISOString()
          },
          metadata: undefined
        })
      );
      return;
    }

    if (taskId !== this.taskId || contextId !== this.contextId) {
      throw new Error("Continuation did not preserve the original task identity");
    }
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
    await this.completionGate;
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: "continued-result",
          name: "Continued result",
          description: "Result from the original resumed task",
          parts: [
            {
              content: {
                $case: "text",
                value: "continued the original task"
              },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain"
            }
          ],
          metadata: undefined,
          extensions: []
        },
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

  async cancelTask(): Promise<void> {
    throw new TaskNotCancelableError("Task is not cancelable in this test");
  }
}

async function startTransport(executor: AgentExecutor, logger?: RuntimeLogger) {
  const server = await startAdapterServer({ executor, port: 0 });
  servers.push(server);
  return new A2aAgentCallTransport({ origin: server.origin, logger });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("A2aAgentCallTransport", () => {
  test("discovers the Codex skill and observes a standard Task to its final Artifact", async () => {
    const completion = deferred();
    const logger = new RecordingLogger();
    const input = "make a focused code change";
    const transport = await startTransport(
      new GateExecutor(completion.promise),
      logger
    );

    const capability = await transport.discoverCapability("codex-code-task");
    expect(capability).toMatchObject({
      id: "codex-code-task",
      name: "Codex code task"
    });

    const submitted = await transport.submitTask({
      messageId: "message-phase3-01",
      skillId: capability.id,
      input,
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
    expect(logger.entries.map(({ message }) => message).sort()).toEqual(
      expect.arrayContaining([
        "a2a.discover.started",
        "a2a.discover.completed",
        "a2a.submit.started",
        "a2a.submit.completed",
        "a2a.watch.started",
        "a2a.watch.snapshot",
        "a2a.watch.reconciled",
        "a2a.watch.ended"
      ])
    );
    const allowedFields = new Set([
      "messageId",
      "contextId",
      "skillId",
      "a2aTaskId",
      "state",
      "attempt",
      "count",
      "questionIds"
    ]);
    for (const entry of logger.entries) {
      expect(Object.keys(entry.fields).every((key) => allowedFields.has(key))).toBe(true);
    }
    const serializedLogs = JSON.stringify(logger.entries);
    expect(serializedLogs).not.toContain(input);
    expect(serializedLogs).not.toContain("changed src/example.ts");
    expect(serializedLogs).not.toContain("agentCallId");
  });

  test.each(
    [
      {
        name: "input-required",
        remoteState: TaskState.TASK_STATE_INPUT_REQUIRED,
        expectedState: "input-required"
      },
      {
        name: "terminal",
        remoteState: TaskState.TASK_STATE_COMPLETED,
        expectedState: "completed"
      }
    ] satisfies Array<{
      name: string;
      remoteState: TaskState;
      expectedState: AgentCallTaskState;
    }>
  )(
    "logs watch.ended when AgentCallService stops consuming after a $name snapshot",
    async ({ remoteState, expectedState }) => {
      const logger = new RecordingLogger();
      const outcome = remoteTask(remoteState);
      const client = {
        protocolVersion: A2A_PROTOCOL_VERSION,
        getAgentCard: vi.fn(async () => testAgentCard()),
        sendMessage: vi.fn(async () =>
          remoteTask(TaskState.TASK_STATE_SUBMITTED)
        ),
        async *resubscribeTask() {
          yield { payload: { $case: "task", value: outcome } };
        },
        getTask: vi.fn(async () => outcome)
      } as unknown as Client;
      vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
      const transport = new A2aAgentCallTransport({
        origin: "http://127.0.0.1:1",
        logger
      });
      const service = new AgentCallService({
        transport,
        createId: () => `agent-call-consumer-${expectedState}`
      });

      const receipt = await service.submit({
        runId: "run-consumer-return",
        sessionId: "session-consumer-return",
        skillId: "codex-code-task",
        input: "exercise the real AgentCallService consumer",
        executionMode: "async"
      });
      await service.waitForIdle();
      await service.close();

      expect(service.getByAgentCallId(receipt.agentCallId)?.state).toBe(
        expectedState
      );
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: "info",
          message: "a2a.watch.ended",
          fields: { a2aTaskId: "a2a-task-lagging" }
        })
      );
      expect(logger.entries.map(({ message }) => message)).not.toContain(
        "a2a.watch.failed"
      );
    }
  );

  test("logs watch.aborted instead of watch.failed when AgentCallService closes", async () => {
    const logger = new RecordingLogger();
    const watchStarted = deferred();
    const abortError = new Error("subscription aborted by close");
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      getAgentCard: vi.fn(async () => testAgentCard()),
      sendMessage: vi.fn(async () =>
        remoteTask(TaskState.TASK_STATE_SUBMITTED)
      ),
      async *resubscribeTask(
        _request: unknown,
        options: { signal: AbortSignal }
      ) {
        watchStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(abortError),
            { once: true }
          );
        });
      }
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });
    const service = new AgentCallService({
      transport,
      createId: () => "agent-call-close-abort"
    });

    await service.submit({
      runId: "run-close-abort",
      sessionId: "session-close-abort",
      skillId: "codex-code-task",
      input: "close while the remote watch is pending",
      executionMode: "async"
    });
    await watchStarted.promise;
    await service.close();

    expect(logger.entries).toContainEqual({
      level: "debug",
      message: "a2a.watch.aborted",
      fields: expect.objectContaining({
        a2aTaskId: "a2a-task-lagging",
        errorCategory: "abort",
        errorType: "Error",
        errorMessageLength: abortError.message.length
      })
    });
    expect(logger.entries.map(({ message }) => message)).not.toContain(
      "a2a.watch.failed"
    );
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
    const logger = new RecordingLogger();
    const transport = await startTransport(
      new GateExecutor(Promise.resolve()),
      logger
    );

    await expect(
      transport.discoverCapability("not-a-real-skill")
    ).rejects.toThrow(/not-a-real-skill/);
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "a2a.discover.failed",
      fields: expect.objectContaining({
        skillId: "not-a-real-skill",
        errorCategory: "protocol",
        errorType: "Error",
        errorMessageLength:
          "A2A Agent Card does not declare skill not-a-real-skill".length
      })
    });
  });

  test("keeps reconciling when a subscription ends before the terminal snapshot is visible", async () => {
    const logger = new RecordingLogger();
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
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });

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
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "a2a.watch.retry",
          fields: expect.objectContaining({
            a2aTaskId: "a2a-task-lagging",
            state: "working",
            attempt: 1
          })
        }),
        expect.objectContaining({
          message: "a2a.watch.reconciled",
          fields: expect.objectContaining({ state: "completed", attempt: 2 })
        }),
        expect.objectContaining({ message: "a2a.watch.ended" })
      ])
    );
  });

  test("keeps watching beyond three interrupted subscriptions until GetTask reports completion", async () => {
    vi.useFakeTimers();
    try {
      const logger = new RecordingLogger();
      const completed = remoteTask(TaskState.TASK_STATE_COMPLETED);
      completed.artifacts = [
        {
          artifactId: "recovered-result",
          name: "Recovered result",
          description: "Result observed after reconnecting",
          parts: [
            {
              content: { $case: "text", value: "completed after reconnects" },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain"
            }
          ],
          metadata: undefined,
          extensions: []
        }
      ];
      const getTask = vi
        .fn<() => Promise<Task>>()
        .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_WORKING))
        .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_WORKING))
        .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_WORKING))
        .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_WORKING))
        .mockResolvedValueOnce(completed);
      let subscriptionAttempts = 0;
      const client = {
        protocolVersion: A2A_PROTOCOL_VERSION,
        async *resubscribeTask() {
          subscriptionAttempts += 1;
          throw new TypeError("terminated");
        },
        getTask
      } as unknown as Client;
      vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
      const transport = new A2aAgentCallTransport({
        origin: "http://127.0.0.1:1",
        logger
      });
      const snapshots: AgentCallTaskSnapshot[] = [];

      const watching = (async () => {
        for await (const snapshot of transport.watchTask("a2a-task-lagging", {
          signal: new AbortController().signal
        })) {
          snapshots.push(snapshot);
        }
      })();
      const outcome = watching.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({ status: "fulfilled" });
      expect(subscriptionAttempts).toBe(5);
      expect(getTask).toHaveBeenCalledTimes(5);
      expect(snapshots.at(-1)).toMatchObject({
        taskId: "a2a-task-lagging",
        state: "completed",
        artifacts: [
          { id: "recovered-result", text: "completed after reconnects" }
        ]
      });
      expect(logger.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "a2a.watch.retry",
            fields: expect.objectContaining({ attempt: 4, state: "working" })
          }),
          expect.objectContaining({ message: "a2a.watch.ended" })
        ])
      );
      expect(logger.entries.map(({ message }) => message)).not.toContain(
        "a2a.watch.failed"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps watching when GetTask temporarily fails more than once after interrupted subscriptions", async () => {
    vi.useFakeTimers();
    try {
      const logger = new RecordingLogger();
      const completed = remoteTask(TaskState.TASK_STATE_COMPLETED);
      completed.artifacts = [
        {
          artifactId: "reconciled-result",
          name: "Reconciled result",
          description: "Result observed after GetTask recovered",
          parts: [
            {
              content: { $case: "text", value: "completed after reconciliation" },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain"
            }
          ],
          metadata: undefined,
          extensions: []
        }
      ];
      const getTask = vi
        .fn<() => Promise<Task>>()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("terminated"))
        .mockResolvedValueOnce(completed);
      let subscriptionAttempts = 0;
      const client = {
        protocolVersion: A2A_PROTOCOL_VERSION,
        async *resubscribeTask() {
          subscriptionAttempts += 1;
          throw new TypeError("terminated");
        },
        getTask
      } as unknown as Client;
      vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
      const transport = new A2aAgentCallTransport({
        origin: "http://127.0.0.1:1",
        logger
      });
      const snapshots: AgentCallTaskSnapshot[] = [];

      const watching = (async () => {
        for await (const snapshot of transport.watchTask("a2a-task-lagging", {
          signal: new AbortController().signal
        })) {
          snapshots.push(snapshot);
        }
      })();
      const outcome = watching.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({ status: "fulfilled" });
      expect(subscriptionAttempts).toBe(3);
      expect(getTask).toHaveBeenCalledTimes(3);
      expect(snapshots.at(-1)).toMatchObject({
        taskId: "a2a-task-lagging",
        state: "completed",
        artifacts: [
          {
            id: "reconciled-result",
            text: "completed after reconciliation"
          }
        ]
      });
      expect(logger.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warn",
            message: "a2a.watch.reconcile_failed",
            fields: expect.objectContaining({
              a2aTaskId: "a2a-task-lagging",
              attempt: 1,
              errorCategory: "network"
            })
          }),
          expect.objectContaining({ message: "a2a.watch.ended" })
        ])
      );
      expect(logger.entries.map(({ message }) => message)).not.toContain(
        "a2a.watch.failed"
      );
      expect(
        logger.entries.filter(
          ({ message }) => message === "a2a.watch.reconcile_failed"
        )
      ).toHaveLength(2);
      expect(JSON.stringify(logger.entries)).not.toContain("fetch failed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry a non-network TypeError from GetTask", async () => {
    vi.useFakeTimers();
    try {
      const logger = new RecordingLogger();
      const controller = new AbortController();
      const programmingError = new TypeError("invalid task payload");
      let subscriptionAttempts = 0;
      const client = {
        protocolVersion: A2A_PROTOCOL_VERSION,
        async *resubscribeTask() {
          subscriptionAttempts += 1;
          if (subscriptionAttempts > 1) {
            controller.abort(new Error("unexpected retry"));
          }
          throw new TypeError("terminated");
        },
        getTask: vi.fn(async () => Promise.reject(programmingError))
      } as unknown as Client;
      vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
      const transport = new A2aAgentCallTransport({
        origin: "http://127.0.0.1:1",
        logger
      });

      const watching = (async () => {
        for await (const _snapshot of transport.watchTask("a2a-task-invalid", {
          signal: controller.signal
        })) {
          // This task never produces a valid snapshot.
        }
      })();
      const outcome = watching.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
      await vi.runAllTimersAsync();

      await expect(outcome).resolves.toEqual({
        status: "rejected",
        error: programmingError
      });
      expect(subscriptionAttempts).toBe(1);
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "a2a.watch.failed"
        })
      );
      expect(logger.entries.map(({ message }) => message)).not.toContain(
        "a2a.watch.reconcile_failed"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts immediately while waiting to retry a failed reconciliation", async () => {
    const logger = new RecordingLogger();
    const reconcileFailed = deferred();
    const originalWarn = logger.warn.bind(logger);
    vi.spyOn(logger, "warn").mockImplementation((message, fields) => {
      originalWarn(message, fields);
      if (message === "a2a.watch.reconcile_failed") {
        reconcileFailed.resolve();
      }
    });
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      async *resubscribeTask() {
        throw new TypeError("terminated");
      },
      getTask: vi.fn(async () => Promise.reject(new TypeError("fetch failed")))
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });
    const controller = new AbortController();
    const abortError = new Error("stop observing");

    const watching = (async () => {
      for await (const _snapshot of transport.watchTask("a2a-task-aborted", {
        signal: controller.signal
      })) {
        // This task is aborted during reconciliation backoff.
      }
    })();
    const outcome = watching.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await reconcileFailed.promise;
    controller.abort(abortError);

    await expect(outcome).resolves.toEqual({
      status: "rejected",
      error: abortError
    });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: "debug",
        message: "a2a.watch.aborted"
      })
    );
    expect(logger.entries.map(({ message }) => message)).not.toContain(
      "a2a.watch.failed"
    );
  });

  test("preserves structured questions from an input-required status message", async () => {
    const paused = remoteInputRequiredTask();
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      async *resubscribeTask() {
        yield { payload: { $case: "task", value: paused } };
      },
      getTask: vi.fn(async () => paused)
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({ origin: "http://127.0.0.1:1" });

    const snapshots = [];
    for await (const snapshot of transport.watchTask("a2a-task-input", {
      signal: new AbortController().signal
    })) {
      snapshots.push(snapshot);
    }

    expect(snapshots.at(-1)).toMatchObject({
      taskId: "a2a-task-input",
      state: "input-required",
      statusMessage: "Scope: Which files may be changed?",
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
      ]
    });
  });

  test("ends the watcher at input-required even when the remote stream stays open", async () => {
    const paused = remoteInputRequiredTask();
    const streamGate = deferred();
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      async *resubscribeTask() {
        yield { payload: { $case: "task", value: paused } };
        await streamGate.promise;
      },
      getTask: vi.fn(async () => paused)
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({ origin: "http://127.0.0.1:1" });
    const iterator = transport
      .watchTask("a2a-task-input", {
        signal: new AbortController().signal
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { state: "input-required" }
    });
    const completion = iterator.next();
    const outcome = await Promise.race([
      completion.then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) =>
        setImmediate(() => resolve({ settled: false }))
      )
    ]);
    streamGate.resolve();
    await completion;

    expect(outcome).toEqual({
      settled: true,
      result: { done: true, value: undefined }
    });
    expect(client.getTask).not.toHaveBeenCalled();
  });

  test("observes paused continuation completion through the real HTTP transport", async () => {
    const completion = deferred();
    const transport = await startTransport(
      new PauseThenContinueExecutor(completion.promise)
    );
    const submitted = await transport.submitTask({
      skillId: "codex-code-task",
      input: "Pause and continue the same task",
      messageId: "message-initial"
    });
    const pausedSnapshots = [];
    for await (const snapshot of transport.watchTask(submitted.taskId, {
      signal: new AbortController().signal
    })) {
      pausedSnapshots.push(snapshot);
    }
    const paused = pausedSnapshots.at(-1);
    expect(paused).toMatchObject({
      taskId: submitted.taskId,
      state: "input-required",
      questions: [{ id: "scope" }]
    });

    await expect(
      transport.continueTask({
        taskId: submitted.taskId,
        contextId: paused?.contextId,
        messageId: "message-continuation",
        answers: { scope: ["Adapter only"] }
      })
    ).resolves.toMatchObject({
      taskId: submitted.taskId,
      contextId: paused?.contextId,
      state: "working"
    });

    const resumedSnapshots: AgentCallTaskSnapshot[] = [];
    const watchCompletion = (async () => {
      for await (const snapshot of transport.watchTask(submitted.taskId, {
        signal: new AbortController().signal
      })) {
        resumedSnapshots.push(snapshot);
      }
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    completion.resolve();
    await watchCompletion;

    expect(resumedSnapshots.at(-1)).toMatchObject({
      taskId: submitted.taskId,
      contextId: paused?.contextId,
      state: "completed",
      artifacts: [{ id: "continued-result", text: "continued the original task" }]
    });
  });

  test("continues an existing task with a standard A2A user Message containing structured answers", async () => {
    const logger = new RecordingLogger();
    const sendMessage = vi.fn(
      async (
        _request: SendMessageRequest,
        _options?: { signal?: AbortSignal }
      ) => ({
        ...remoteTask(TaskState.TASK_STATE_WORKING),
        id: "a2a-task-input",
        contextId: "a2a-context-input"
      })
    );
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      sendMessage
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });
    const controller = new AbortController();

    await expect(
      transport.continueTask({
        taskId: "a2a-task-input",
        contextId: "a2a-context-input",
        messageId: "message-input-response",
        answers: { scope: ["Adapter only"] },
        signal: controller.signal
      })
    ).resolves.toMatchObject({
      taskId: "a2a-task-input",
      contextId: "a2a-context-input",
      state: "working"
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = sendMessage.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(SendMessageRequest.toJSON(request!)).toMatchObject({
      message: {
        messageId: "message-input-response",
        taskId: "a2a-task-input",
        contextId: "a2a-context-input",
        role: "ROLE_USER",
        parts: [{ data: { answers: { scope: ["Adapter only"] } } }]
      },
      configuration: { returnImmediately: true }
    });
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      signal: controller.signal
    });
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "a2a.continue.started",
          fields: {
            messageId: "message-input-response",
            a2aTaskId: "a2a-task-input",
            contextId: "a2a-context-input",
            questionIds: ["scope"],
            count: 1
          }
        }),
        expect.objectContaining({
          level: "info",
          message: "a2a.continue.completed",
          fields: expect.objectContaining({
            a2aTaskId: "a2a-task-input",
            state: "working"
          })
        })
      ])
    );
    expect(JSON.stringify(logger.entries)).not.toContain("Adapter only");
  });

  test("logs failed A2A operations without raw SDK payloads or answers", async () => {
    const logger = new RecordingLogger();
    const sdkError = Object.assign(
      new Error("raw SDK response must stay private"),
      { code: "PRIVATE_SDK_CODE" }
    );
    const input = "private submit input";
    const answer = "private continuation answer";
    const cancelTask = vi
      .fn()
      .mockResolvedValueOnce(remoteTask(TaskState.TASK_STATE_CANCELED))
      .mockRejectedValueOnce(sdkError);
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      getAgentCard: vi.fn(async () => testAgentCard()),
      sendMessage: vi.fn(async () => {
        throw sdkError;
      }),
      async *resubscribeTask() {
        throw sdkError;
      },
      getTask: vi.fn(async () => {
        throw sdkError;
      }),
      cancelTask
    } as unknown as Client;
    vi.spyOn(ClientFactory.prototype, "createFromUrl").mockResolvedValue(client);
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });

    await expect(
      transport.submitTask({
        messageId: "message-failed-submit",
        skillId: "codex-code-task",
        input
      })
    ).rejects.toBe(sdkError);
    await expect(
      transport.continueTask({
        messageId: "message-failed-continuation",
        taskId: "a2a-task-lagging",
        contextId: "a2a-context-lagging",
        answers: { passphrase: [answer] }
      })
    ).rejects.toBe(sdkError);
    await expect(
      (async () => {
        for await (const _snapshot of transport.watchTask("a2a-task-lagging", {
          signal: new AbortController().signal
        })) {
          // The mocked stream never yields.
        }
      })()
    ).rejects.toBe(sdkError);
    await expect(transport.cancelTask("a2a-task-lagging")).resolves.toMatchObject({
      state: "canceled"
    });
    await expect(transport.cancelTask("a2a-task-lagging")).rejects.toBe(sdkError);

    expect(logger.entries.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        "a2a.submit.failed",
        "a2a.continue.failed",
        "a2a.watch.failed",
        "a2a.cancel.completed",
        "a2a.cancel.failed"
      ])
    );
    const failedEntries = logger.entries.filter(({ message }) =>
      message.endsWith(".failed")
    );
    expect(failedEntries).toHaveLength(4);
    for (const entry of failedEntries) {
      expect(entry.fields).toEqual(
        expect.objectContaining({
          errorCategory: "unknown",
          errorType: "Error",
          errorMessageLength: sdkError.message.length
        })
      );
      expect(entry.fields).not.toHaveProperty("errorCode");
    }
    const serializedLogs = JSON.stringify(logger.entries);
    expect(serializedLogs).not.toContain(input);
    expect(serializedLogs).not.toContain(answer);
    expect(serializedLogs).not.toContain(sdkError.message);
    expect(serializedLogs).not.toContain(sdkError.code);
    expect(serializedLogs).not.toContain("agentCallId");
  });

  test("retries Agent Card discovery after an initial connection failure", async () => {
    const logger = new RecordingLogger();
    const connectionError = Object.assign(
      new Error("adapter is still starting"),
      { code: "ECONNREFUSED" }
    );
    const client = {
      protocolVersion: A2A_PROTOCOL_VERSION,
      getAgentCard: vi.fn(async () => testAgentCard())
    } as unknown as Client;
    const createFromUrl = vi
      .spyOn(ClientFactory.prototype, "createFromUrl")
      .mockRejectedValueOnce(connectionError)
      .mockResolvedValueOnce(client);
    const transport = new A2aAgentCallTransport({
      origin: "http://127.0.0.1:1",
      logger
    });

    await expect(transport.discoverCapability("codex-code-task")).rejects.toThrow(
      /still starting/
    );
    await expect(
      transport.discoverCapability("codex-code-task")
    ).resolves.toMatchObject({ id: "codex-code-task" });
    expect(createFromUrl).toHaveBeenCalledTimes(2);
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: "a2a.client.create_failed",
          fields: {
            attempt: 1,
            errorCategory: "network",
            errorType: "Error",
            errorMessageLength: connectionError.message.length,
            errorCode: "ECONNREFUSED"
          }
        }),
        expect.objectContaining({
          level: "error",
          message: "a2a.discover.failed",
          fields: {
            skillId: "codex-code-task",
            errorCategory: "network",
            errorType: "Error",
            errorMessageLength: connectionError.message.length,
            errorCode: "ECONNREFUSED"
          }
        }),
        expect.objectContaining({
          level: "info",
          message: "a2a.discover.completed",
          fields: { skillId: "codex-code-task" }
        })
      ])
    );
    expect(JSON.stringify(logger.entries)).not.toContain("still starting");
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

function remoteInputRequiredTask(): Task {
  return {
    id: "a2a-task-input",
    contextId: "a2a-context-input",
    status: {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: Message.fromJSON({
        messageId: "a2a-task-input-request",
        taskId: "a2a-task-input",
        contextId: "a2a-context-input",
        role: "ROLE_AGENT",
        parts: [
          { text: "Scope: Which files may be changed?" },
          {
            data: {
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
              ]
            }
          }
        ]
      }),
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
