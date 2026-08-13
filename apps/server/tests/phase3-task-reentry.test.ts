import { describe, expect, test, vi } from "vitest";

import {
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
  type OpenAiAgentsRunner,
} from "@huanlink/integration-openai-agents";
import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AsyncToolTaskService,
  ConversationSessionStoreToolHistoryRecorder,
  InMemoryConversationSessionStore,
  type AgentCallTransport,
  type AsyncToolTaskKindDefinition,
  type ChannelAdapter,
} from "@huanlink/core";
import {
  Runner,
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";

import {
  CHANNEL_REPLY_TOOL_NAME,
  createPhase3HuanLinkRuntime,
} from "../src/index.js";

const delayedToolKind: AsyncToolTaskKindDefinition = {
  kind: "fake-delayed-tool",
  quotaPool: "async-tool",
  validatePayload: () => ({
    artifacts: [{ name: "result.txt", text: "parser updated" }],
  }),
  projectPublicStatus: ({ payload }) => ({ payload }),
};

describe("Phase 3 Task re-entry", () => {
  test("queues one terminal Task re-entry and reads its source Call plus the latest Window only after obtaining the Session slot", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-task-reentry",
      inboundMessage("message-initial", "Start the parser update."),
    );
    sessions.appendAgentToolCall("session-task-reentry", {
      runId: "run-source-private",
      toolCallId: "sdk-call-private",
      toolName: "start_fake_delayed_work",
      arguments: { task: "update the parser" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [delayedToolKind],
      createTaskId: () => "huanlink-task-1",
    });
    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();
    const observedInputs: string[] = [];
    const runner: OpenAiAgentsRunner = {
      run: async (_agent, input) => {
        observedInputs.push(input);
        if (observedInputs.length === 1) {
          firstTurnStarted.resolve();
          await releaseFirstTurn.promise;
        }
        return { finalOutput: "done" };
      },
    };
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner,
      taskService,
      sessionStore: sessions,
    });

    try {
      const activeTurn = runtime.runMainAgent({
        runId: "run-active",
        sessionId: "session-task-reentry",
        input: "active turn",
      });
      await firstTurnStarted.promise;

      const reserved = taskService.reserve({
        sessionId: "session-task-reentry",
        sourceRunId: "run-source-private",
        sourceToolCallId: "sdk-call-private",
        toolName: "start_fake_delayed_work",
        kind: "fake-delayed-tool",
        payload: {},
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve a Task");
      }
      taskService.accept("session-task-reentry", reserved.task.taskId, {
        state: "working",
      });
      taskService.updateAccepted("session-task-reentry", reserved.task.taskId, {
        state: "completed",
        statusMessage: "work completed",
      });
      sessions.appendChannelMessage(
        "session-task-reentry",
        inboundMessage("message-latest", "Keep the newly reported behavior."),
      );

      expect(observedInputs).toEqual(["active turn"]);
      releaseFirstTurn.resolve();
      await activeTurn;
      await vi.waitFor(() => expect(observedInputs).toHaveLength(2));

      expect(observedInputs[1]).toContain("Keep the newly reported behavior.");
      expect(observedInputs[1]?.match(/update the parser/g)).toHaveLength(1);
      expect(observedInputs[1]).toContain("huanlink-task-1");
      expect(observedInputs[1]).toContain("sdk-call-private");
      expect(observedInputs[1]).not.toMatch(/agentCallId|a2aTaskId/);
    } finally {
      releaseFirstTurn.resolve();
      await runtime.close();
    }
  });

  test("serializes re-entry with the same Session while another Session proceeds independently", async () => {
    const sessions = new InMemoryConversationSessionStore();
    for (const suffix of ["a", "b"] as const) {
      sessions.appendChannelMessage(
        `session-parallel-${suffix}`,
        inboundMessage(`message-parallel-${suffix}`, `Start task ${suffix}.`),
      );
      sessions.appendAgentToolCall(`session-parallel-${suffix}`, {
        runId: `run-parallel-${suffix}`,
        toolCallId: `call-parallel-${suffix}`,
        toolName: "start_fake_delayed_work",
        arguments: { task: `task ${suffix}` },
      });
    }
    const taskIds = ["huanlink-parallel-a", "huanlink-parallel-b"];
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [delayedToolKind],
      createTaskId: () => taskIds.shift()!,
    });
    const activeAStarted = deferred();
    const releaseActiveA = deferred();
    const observedInputs: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async (_agent, input) => {
          observedInputs.push(input);
          if (input === "active A") {
            activeAStarted.resolve();
            await releaseActiveA.promise;
          }
          return { finalOutput: "done" };
        },
      },
      taskService,
      sessionStore: sessions,
    });

    try {
      const activeA = runtime.runMainAgent({
        runId: "run-active-parallel-a",
        sessionId: "session-parallel-a",
        input: "active A",
      });
      await activeAStarted.promise;

      for (const suffix of ["a", "b"] as const) {
        const reserved = taskService.reserve({
          sessionId: `session-parallel-${suffix}`,
          sourceRunId: `run-parallel-${suffix}`,
          sourceToolCallId: `call-parallel-${suffix}`,
          toolName: "start_fake_delayed_work",
          kind: "fake-delayed-tool",
          payload: {},
        });
        if (reserved.status !== "reserved") {
          throw new Error(`Test setup must reserve Task ${suffix}`);
        }
        taskService.accept(`session-parallel-${suffix}`, reserved.task.taskId, {
          state: "working",
        });
        taskService.updateAccepted(
          `session-parallel-${suffix}`,
          reserved.task.taskId,
          { state: "completed" },
        );
      }

      await vi.waitFor(() =>
        expect(
          observedInputs.some((input) => input.includes("huanlink-parallel-b")),
        ).toBe(true),
      );
      expect(
        observedInputs.some((input) => input.includes("huanlink-parallel-a")),
      ).toBe(false);

      releaseActiveA.resolve();
      await activeA;
      await vi.waitFor(() =>
        expect(
          observedInputs.some((input) => input.includes("huanlink-parallel-a")),
        ).toBe(true),
      );
    } finally {
      releaseActiveA.resolve();
      await runtime.close();
    }
  });

  test("starts one re-entry when AgentCall and Task terminal signals describe the same outcome", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-task-owner",
      inboundMessage("message-owner", "Delegate this work."),
    );
    sessions.appendAgentToolCall("session-task-owner", {
      runId: "run-legacy-agent-call",
      toolCallId: "sdk-owner-call",
      toolName: "submit_codex_agent_call",
      arguments: { task: "legacy AgentCall terminal event" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION, delayedToolKind],
    });
    const observedInputs: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: immediatelyCompletedAgentCallTransport(),
      runner: {
        run: async (_agent, input) => {
          observedInputs.push(input);
          return { finalOutput: "unexpected legacy re-entry" };
        },
      },
      taskService,
      sessionStore: sessions,
    });

    try {
      await runtime.agentCalls.invoke({
        runId: "run-legacy-agent-call",
        sessionId: "session-task-owner",
        skillId: "codex-code-task",
        input: "legacy AgentCall terminal event",
        executionMode: "async",
        toolName: "submit_codex_agent_call",
        sourceToolCallId: "sdk-owner-call",
      });
      await runtime.agentCalls.waitForIdle();

      expect(observedInputs).toHaveLength(1);
      expect(observedInputs[0]).toContain("legacy result");
      expect(observedInputs[0]).toContain("sdk-owner-call");
      expect(observedInputs[0]).not.toMatch(
        /a2a-private-task|agentCallId|a2aTaskId/,
      );
    } finally {
      await runtime.close();
    }
  });

  test("keeps a blocking AgentCall in the current operation without creating a Task re-entry", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-blocking-call",
      inboundMessage("message-blocking-call", "Wait for the result."),
    );
    const createTaskId = vi.fn(() => "must-not-create-task");
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId,
    });
    const onReentry = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: immediatelyCompletedAgentCallTransport(),
      runner: {
        run: async () => ({ finalOutput: "must not re-enter" }),
      },
      taskService,
      sessionStore: sessions,
      onReentry,
    });

    try {
      await expect(
        runtime.agentCalls.invoke({
          runId: "run-blocking-call",
          sessionId: "session-blocking-call",
          skillId: "codex-code-task",
          input: "wait for completion",
          executionMode: "blocking",
          toolName: "submit_codex_agent_call",
          sourceToolCallId: "call-blocking-completed",
        }),
      ).resolves.toMatchObject({
        status: "result",
        executionMode: "blocking",
        state: "completed",
      });
      expect(createTaskId).not.toHaveBeenCalled();
      expect(onReentry).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  test("returns a blocking input-required result without emitting a Task re-entry", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-blocking-input",
      inboundMessage(
        "message-blocking-input",
        "Wait until a choice is needed.",
      ),
    );
    const createTaskId = vi.fn(() => "must-not-create-paused-task");
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId,
    });
    const onReentry = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: resumableAgentCallTransport().transport,
      runner: { run: async () => ({ finalOutput: "must not re-enter" }) },
      taskService,
      sessionStore: sessions,
      onReentry,
    });

    try {
      await expect(
        runtime.agentCalls.invoke({
          runId: "run-blocking-input",
          sessionId: "session-blocking-input",
          skillId: "codex-code-task",
          input: "pause for one choice",
          executionMode: "blocking",
          toolName: "submit_codex_agent_call",
          sourceToolCallId: "call-blocking-input-required",
        }),
      ).resolves.toMatchObject({
        status: "blocking-interrupted",
        executionMode: "blocking",
        state: "input-required",
      });
      expect(createTaskId).not.toHaveBeenCalled();
      expect(onReentry).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  test("re-enters from the generic input-required Task event with the source Call and no internal IDs", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-input-required",
      inboundMessage("message-input", "Use the safe option if asked."),
    );
    sessions.appendAgentToolCall("session-input-required", {
      runId: "run-input-source",
      toolCallId: "sdk-input-private",
      toolName: "submit_codex_agent_call",
      arguments: { task: "update parser behavior" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => "huanlink-input-task",
    });
    const observedInputs: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async (_agent, input) => {
          observedInputs.push(input);
          return { finalOutput: "asked the user" };
        },
      },
      taskService,
      sessionStore: sessions,
    });

    try {
      const reserved = taskService.reserve({
        sessionId: "session-input-required",
        sourceRunId: "run-input-source",
        sourceToolCallId: "sdk-input-private",
        toolName: "submit_codex_agent_call",
        kind: "agent-call",
        payload: { artifacts: [] },
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve an input-required Task");
      }
      taskService.accept("session-input-required", reserved.task.taskId, {
        state: "input-required",
        payload: {
          artifacts: [],
          questions: [
            {
              header: "Parser mode",
              id: "parser-mode",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Which parser mode should be used?",
            },
          ],
        },
        statusMessage: "User choice required",
      });

      await vi.waitFor(() => expect(observedInputs).toHaveLength(1));
      expect(observedInputs[0]).toContain("Which parser mode should be used?");
      expect(observedInputs[0]).toContain("huanlink-input-task");
      expect(observedInputs[0]).toContain("update parser behavior");
      expect(observedInputs[0]).toContain("sdk-input-private");
      expect(observedInputs[0]).not.toMatch(/agentCallId|a2aTaskId/);
    } finally {
      await runtime.close();
    }
  });

  test("does not re-enter twice for one input-required episode but allows a later episode", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-repeat-input",
      inboundMessage("message-repeat-input", "Use the safe answer."),
    );
    sessions.appendAgentToolCall("session-repeat-input", {
      runId: "run-repeat-input",
      toolCallId: "call-repeat-input",
      toolName: "submit_codex_agent_call",
      arguments: { task: "choose a parser mode" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    });
    const observedInputs: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async (_agent, input) => {
          observedInputs.push(input);
          return { finalOutput: "handled" };
        },
      },
      taskService,
      sessionStore: sessions,
    });

    try {
      const reserved = taskService.reserve({
        sessionId: "session-repeat-input",
        sourceRunId: "run-repeat-input",
        sourceToolCallId: "call-repeat-input",
        toolName: "submit_codex_agent_call",
        kind: "agent-call",
        payload: { artifacts: [] },
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve a repeat-input Task");
      }
      const inputRequired = {
        state: "input-required" as const,
        payload: {
          artifacts: [],
          questions: [
            {
              header: "Mode",
              id: "mode",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Which mode?",
            },
          ],
        },
      };

      taskService.accept(
        "session-repeat-input",
        reserved.task.taskId,
        inputRequired,
      );
      await vi.waitFor(() => expect(observedInputs).toHaveLength(1));
      taskService.updateAccepted(
        "session-repeat-input",
        reserved.task.taskId,
        inputRequired,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observedInputs).toHaveLength(1);

      taskService.updateAccepted("session-repeat-input", reserved.task.taskId, {
        state: "working",
      });
      taskService.updateAccepted(
        "session-repeat-input",
        reserved.task.taskId,
        inputRequired,
      );
      await vi.waitFor(() => expect(observedInputs).toHaveLength(2));
    } finally {
      await runtime.close();
    }
  });

  test("skips a queued input-required re-entry after the Task advances to terminal", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-stale-input",
      inboundMessage("message-stale-input", "Start and continue the task."),
    );
    sessions.appendAgentToolCall("session-stale-input", {
      runId: "run-stale-input",
      toolCallId: "call-stale-input",
      toolName: "submit_codex_agent_call",
      arguments: { task: "finish without stale questions" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    });
    const activeTurnStarted = deferred();
    const releaseActiveTurn = deferred();
    const observedInputs: string[] = [];
    const triggers: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async (_agent, input) => {
          observedInputs.push(input);
          if (input === "active turn") {
            activeTurnStarted.resolve();
            await releaseActiveTurn.promise;
          }
          return { finalOutput: "handled" };
        },
      },
      taskService,
      sessionStore: sessions,
      onReentry: ({ trigger }) => {
        triggers.push(trigger);
      },
    });

    try {
      const activeTurn = runtime.runMainAgent({
        runId: "run-active-stale-input",
        sessionId: "session-stale-input",
        input: "active turn",
      });
      await activeTurnStarted.promise;
      const reserved = taskService.reserve({
        sessionId: "session-stale-input",
        sourceRunId: "run-stale-input",
        sourceToolCallId: "call-stale-input",
        toolName: "submit_codex_agent_call",
        kind: "agent-call",
        payload: { artifacts: [] },
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve a stale-input Task");
      }
      taskService.accept("session-stale-input", reserved.task.taskId, {
        state: "input-required",
        payload: {
          artifacts: [],
          questions: [
            {
              header: "Mode",
              id: "mode",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Which mode?",
            },
          ],
        },
      });
      taskService.updateAccepted("session-stale-input", reserved.task.taskId, {
        state: "working",
      });
      taskService.updateAccepted("session-stale-input", reserved.task.taskId, {
        state: "completed",
        payload: { artifacts: [{ id: "artifact-1", text: "done" }] },
      });

      releaseActiveTurn.resolve();
      await activeTurn;
      await vi.waitFor(() => expect(triggers).toEqual(["agent_call_terminal"]));
      expect(observedInputs).toHaveLength(2);
      expect(observedInputs[1]).toContain("reached a terminal state");
      expect(observedInputs[1]).not.toContain("requires user input");
    } finally {
      releaseActiveTurn.resolve();
      await runtime.close();
    }
  });

  test("re-enters for input-required and then the terminal outcome after continuing the same HuanLink Task", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-continue-task",
      inboundMessage("message-continue-task", "Use the safe approach."),
    );
    sessions.appendAgentToolCall("session-continue-task", {
      runId: "run-continue-task",
      toolCallId: "call-continue-task",
      toolName: "submit_codex_agent_call",
      arguments: { task: "finish after one choice" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => "huanlink-continue-task",
    });
    const { transport, continueTask } = resumableAgentCallTransport();
    const triggers: string[] = [];
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: { run: async () => ({ finalOutput: "handled" }) },
      taskService,
      sessionStore: sessions,
      onReentry: ({ trigger }) => {
        triggers.push(trigger);
      },
    });

    try {
      const accepted = await runtime.agentCalls.invoke({
        runId: "run-continue-task",
        sessionId: "session-continue-task",
        skillId: "codex-code-task",
        input: "finish after one choice",
        executionMode: "async",
        toolName: "submit_codex_agent_call",
        sourceToolCallId: "call-continue-task",
      });
      if (accepted.status !== "accepted") {
        throw new Error("Test setup must accept the resumable Task");
      }
      await vi.waitFor(() =>
        expect(triggers).toEqual(["agent_call_input_required"]),
      );

      await expect(
        runtime.agentCalls.continueTask({
          sessionId: "session-continue-task",
          taskId: accepted.taskId,
          answers: { approach: ["Safe"] },
        }),
      ).resolves.toMatchObject({
        status: "continued",
        taskId: "huanlink-continue-task",
      });
      await vi.waitFor(() =>
        expect(triggers).toEqual([
          "agent_call_input_required",
          "agent_call_terminal",
        ]),
      );
      expect(continueTask).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  test("fails closed when the Task source Call is missing while keeping the terminal Task queryable", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-missing-source",
      inboundMessage("message-missing-source", "Start delayed work."),
    );
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [delayedToolKind],
      createTaskId: () => "huanlink-missing-source",
    });
    const run = vi.fn(async () => ({ finalOutput: "must not run" }));
    const backgroundError = deferred<Error>();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: { run },
      taskService,
      sessionStore: sessions,
      onBackgroundError: (error) => backgroundError.resolve(error),
    });

    try {
      const reserved = taskService.reserve({
        sessionId: "session-missing-source",
        sourceRunId: "run-not-recorded",
        sourceToolCallId: "call-not-recorded",
        toolName: "start_fake_delayed_work",
        kind: "fake-delayed-tool",
        payload: {},
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve a Task without a source Call");
      }
      taskService.accept("session-missing-source", reserved.task.taskId, {
        state: "working",
      });
      taskService.updateAccepted(
        "session-missing-source",
        reserved.task.taskId,
        { state: "completed", statusMessage: "work still completed" },
      );

      await expect(backgroundError.promise).resolves.toMatchObject({
        message: expect.stringContaining("source Tool Call was not found"),
      });
      expect(run).not.toHaveBeenCalled();
      expect(
        taskService.getStatus("session-missing-source", reserved.task.taskId),
      ).toMatchObject({
        status: "found",
        taskId: "huanlink-missing-source",
        state: "completed",
      });
    } finally {
      await runtime.close();
    }
  });

  test("reports a re-entry model failure and releases its preparation exactly once", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-model-failure",
      inboundMessage("message-model-failure", "Start delayed work."),
    );
    sessions.appendAgentToolCall("session-model-failure", {
      runId: "run-model-failure",
      toolCallId: "call-model-failure",
      toolName: "start_fake_delayed_work",
      arguments: { task: "fail during re-entry" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [delayedToolKind],
    });
    const cleanup = vi.fn();
    const backgroundError = deferred<Error>();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async () => {
          throw new Error("re-entry model failed");
        },
      },
      taskService,
      sessionStore: sessions,
      beforeReentry: () => cleanup,
      onBackgroundError: (error) => backgroundError.resolve(error),
    });

    try {
      const reserved = taskService.reserve({
        sessionId: "session-model-failure",
        sourceRunId: "run-model-failure",
        sourceToolCallId: "call-model-failure",
        toolName: "start_fake_delayed_work",
        kind: "fake-delayed-tool",
        payload: {},
      });
      if (reserved.status !== "reserved") {
        throw new Error("Test setup must reserve a model-failure Task");
      }
      taskService.accept("session-model-failure", reserved.task.taskId, {
        state: "working",
      });
      taskService.updateAccepted(
        "session-model-failure",
        reserved.task.taskId,
        { state: "completed" },
      );

      await expect(backgroundError.promise).resolves.toMatchObject({
        message: "re-entry model failed",
      });
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  test("aborts and drains a hanging terminal re-entry on close without reporting a shutdown failure", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-close-reentry",
      inboundMessage("message-close-reentry", "Start delayed work."),
    );
    sessions.appendAgentToolCall("session-close-reentry", {
      runId: "run-close-reentry",
      toolCallId: "call-close-reentry",
      toolName: "start_fake_delayed_work",
      arguments: { task: "wait until shutdown" },
    });
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [delayedToolKind],
    });
    const reentryStarted = deferred<AbortSignal>();
    const onBackgroundError = vi.fn();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: unusedTransport(),
      runner: {
        run: async (_agent, _input, options) => {
          const signal = options?.signal;
          if (signal === undefined) {
            throw new Error("Expected a re-entry AbortSignal");
          }
          reentryStarted.resolve(signal);
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          throw new Error("Unreachable after re-entry abort");
        },
      },
      taskService,
      sessionStore: sessions,
      onBackgroundError,
    });

    const reserved = taskService.reserve({
      sessionId: "session-close-reentry",
      sourceRunId: "run-close-reentry",
      sourceToolCallId: "call-close-reentry",
      toolName: "start_fake_delayed_work",
      kind: "fake-delayed-tool",
      payload: {},
    });
    if (reserved.status !== "reserved") {
      throw new Error("Test setup must reserve a close-reentry Task");
    }
    taskService.accept("session-close-reentry", reserved.task.taskId, {
      state: "working",
    });
    taskService.updateAccepted("session-close-reentry", reserved.task.taskId, {
      state: "completed",
    });

    const signal = await reentryStarted.promise;
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(onBackgroundError).not.toHaveBeenCalled();
  });

  test("uses the real reply Tool for both the accepted turn and terminal Task re-entry", async () => {
    const sessions = new InMemoryConversationSessionStore();
    sessions.appendChannelMessage(
      "session-reply-composition",
      inboundMessage("message-reply-composition", "Delegate this parser fix."),
    );
    const taskService = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
      createTaskId: () => "huanlink-reply-task",
    });
    const adapter = replyRecordingAdapter();
    const model = new SubmitReplyThenTerminalReplyModel();
    const terminalReentry = deferred();
    const runtime = createPhase3HuanLinkRuntime({
      codexA2aOrigin: "http://127.0.0.1:1",
      transport: immediatelyCompletedAgentCallTransport(),
      runner: new Runner({
        modelProvider: new SingleModelProvider(model),
        tracingDisabled: true,
      }),
      taskService,
      sessionStore: sessions,
      historyRecorder: new ConversationSessionStoreToolHistoryRecorder(
        sessions,
      ),
      channelReply: {
        sessions,
        resolveAdapter: () => adapter,
      },
      onReentry: () => terminalReentry.resolve(),
    });

    try {
      await runtime.runMainAgent({
        runId: "run-reply-composition",
        sessionId: "session-reply-composition",
        input: "delegate the parser fix",
      });
      await terminalReentry.promise;
      await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledTimes(2));

      expect(adapter.send.mock.calls.map(([message]) => message.parts)).toEqual(
        [
          [{ type: "text", text: "Task huanlink-reply-task was accepted." }],
          [{ type: "text", text: "Task huanlink-reply-task completed." }],
        ],
      );
      expect(model.requests).toHaveLength(5);
      expect(model.requests[3]?.input).not.toContain("a2a-private-task");
    } finally {
      await runtime.close();
    }
  });
});

function inboundMessage(messageId: string, content: string) {
  return {
    messageId,
    route: {
      channelId: "qq-main",
      conversationKind: "group" as const,
      conversationId: "group-42",
    },
    sender: { id: "user-1", username: "alice", isSelf: false },
    receivedAt: "2026-08-12T00:00:00.000Z",
    content,
    contentFormat: "plain_text",
  };
}

function unusedTransport(): AgentCallTransport {
  const unexpected = async () => {
    throw new Error("AgentCall transport must not be used in this test");
  };
  return {
    discoverCapability: unexpected,
    submitTask: unexpected,
    continueTask: unexpected,
    watchTask: () => {
      throw new Error("AgentCall transport must not be used in this test");
    },
    cancelTask: unexpected,
  };
}

function immediatelyCompletedAgentCallTransport(): AgentCallTransport {
  return {
    discoverCapability: async () => ({
      id: "codex-code-task",
      name: "Codex code task",
    }),
    submitTask: async () => ({
      outcome: "accepted",
      snapshot: {
        taskId: "a2a-private-task",
        state: "submitted",
        artifacts: [],
      },
    }),
    continueTask: async () => {
      throw new Error("Unexpected continuation");
    },
    watchTask: async function* () {
      yield {
        taskId: "a2a-private-task",
        state: "completed",
        artifacts: [{ id: "artifact-1", text: "legacy result" }],
      };
    },
    cancelTask: async () => ({
      taskId: "a2a-private-task",
      state: "canceled",
      artifacts: [],
    }),
  };
}

function resumableAgentCallTransport() {
  let watchCount = 0;
  const continueTask = vi.fn<AgentCallTransport["continueTask"]>(
    async (request) => ({
      taskId: request.taskId,
      contextId: request.contextId,
      state: "working",
      artifacts: [],
    }),
  );
  const transport: AgentCallTransport = {
    discoverCapability: async () => ({
      id: "codex-code-task",
      name: "Codex code task",
    }),
    submitTask: async (request) => ({
      outcome: "accepted",
      snapshot: {
        taskId: "a2a-resumable-private",
        contextId: request.contextId,
        state: "working",
        artifacts: [],
      },
    }),
    async *watchTask(taskId) {
      watchCount += 1;
      if (watchCount === 1) {
        yield {
          taskId,
          contextId: "a2a-context-private",
          state: "input-required",
          statusMessage: "Choose an approach",
          questions: [
            {
              header: "Approach",
              id: "approach",
              isOther: false,
              isSecret: false,
              options: null,
              question: "Which approach?",
            },
          ],
          artifacts: [],
        };
        return;
      }
      yield {
        taskId,
        contextId: "a2a-context-private",
        state: "completed",
        artifacts: [{ id: "artifact-resumed", text: "completed safely" }],
      };
    },
    continueTask,
    cancelTask: async (taskId) => ({
      taskId,
      state: "canceled",
      artifacts: [],
    }),
  };
  return { transport, continueTask };
}

class SubmitReplyThenTerminalReplyModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    switch (this.requests.length) {
      case 1:
        return toolCallResponse(
          "call-submit-reply-composition",
          SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          { task: "update the parser", executionMode: "async" },
        );
      case 2:
        return toolCallResponse(
          "call-reply-accepted",
          CHANNEL_REPLY_TOOL_NAME,
          {
            parts: [
              {
                type: "text",
                text: "Task huanlink-reply-task was accepted.",
              },
            ],
          },
        );
      case 3:
        return assistantResponse("Accepted reply sent.");
      case 4:
        return toolCallResponse(
          "call-reply-terminal",
          CHANNEL_REPLY_TOOL_NAME,
          {
            parts: [
              {
                type: "text",
                text: "Task huanlink-reply-task completed.",
              },
            ],
          },
        );
      case 5:
        return assistantResponse("Terminal reply sent.");
      default:
        throw new Error("Unexpected extra model request");
    }
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    throw new Error("Streaming is not used in this test");
  }
}

class SingleModelProvider implements ModelProvider {
  constructor(private readonly model: Model) {}

  getModel(): Model {
    return this.model;
  }
}

function toolCallResponse(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ModelResponse {
  return {
    usage: new Usage(),
    output: [
      {
        type: "function_call",
        callId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
  };
}

function assistantResponse(text: string): ModelResponse {
  return {
    usage: new Usage(),
    output: [
      {
        id: `message-${text}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            providerData: { annotations: [] },
          },
        ],
      },
    ],
  };
}

function replyRecordingAdapter(): ChannelAdapter & {
  send: ReturnType<typeof vi.fn<ChannelAdapter["send"]>>;
} {
  const send = vi.fn<ChannelAdapter["send"]>(async () => ({
    channelId: "qq-main",
    messageId: "outbound-message",
  }));
  return {
    descriptor: {
      channelId: "qq-main",
      platform: "test",
      capabilities: {
        conversationKinds: ["group"],
        threads: false,
        inboundContentFormats: ["plain_text"],
        outboundPartTypes: ["text"],
        reply: true,
        edit: false,
        retract: false,
        reaction: false,
        typing: false,
        streaming: false,
      },
    },
    start: async () => undefined,
    close: async () => undefined,
    onMessage: () => () => undefined,
    send,
    retract: async () => undefined,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
