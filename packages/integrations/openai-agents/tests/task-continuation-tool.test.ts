import { describe, expect, test, vi } from "vitest";

import type {
  AgentCallContinuator,
  AgentCallReader,
  AgentCallRecord
} from "@huanlink/core";
import { Agent, RunContext, ToolTimeoutError } from "@openai/agents";

import {
  createTaskContinuationTool,
  type OpenAiAgentsRunContext
} from "../src/index.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";
import { ThrowingRuntimeLogger } from "./support/throwing-runtime-logger.js";

const pausedRecord: AgentCallRecord = {
  agentCallId: "huanlink-task-01",
  taskId: "a2a-task-01",
  contextId: "session-current",
  runId: "run-submission",
  sessionId: "session-current",
  skillId: "codex-code-task",
  capabilityName: "Codex code task",
  input: "make one focused change",
  executionMode: "async",
  state: "input-required",
  artifacts: [],
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
  statusMessage: "Choose a scope",
  createdAt: "2026-07-13T01:02:03.000Z",
  updatedAt: "2026-07-13T01:03:04.000Z"
};

function runContext(
  trigger: OpenAiAgentsRunContext["trigger"],
  signal?: AbortSignal
) {
  return new RunContext<OpenAiAgentsRunContext>({
    runId: "run-continuation",
    sessionId: "session-current",
    trigger,
    ...(signal === undefined ? {} : { signal })
  });
}

describe("createTaskContinuationTool", () => {
  test("continues a current-session task by its HuanLink ID", async () => {
    const runController = new AbortController();
    const toolController = new AbortController();
    const getByAgentCallId = vi.fn<AgentCallReader["getByAgentCallId"]>(
      (taskId) => (taskId === pausedRecord.agentCallId ? pausedRecord : undefined)
    );
    const getByTaskId = vi.fn<AgentCallReader["getByTaskId"]>(() => undefined);
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => ({ ...pausedRecord, state: "working", questions: undefined })
    );
    const tool = createTaskContinuationTool({
      reader: { getByAgentCallId, getByTaskId },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user", runController.signal),
      JSON.stringify({
        taskId: pausedRecord.agentCallId,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      }),
      { signal: toolController.signal }
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "continued",
      taskId: "huanlink-task-01",
      a2aTaskId: "a2a-task-01",
      state: "working"
    });
    expect(continueTask).toHaveBeenCalledWith(
      "a2a-task-01",
      { scope: ["Adapter only"] },
      expect.any(AbortSignal)
    );
    const combinedSignal = continueTask.mock.calls[0]?.[2];
    expect(combinedSignal).not.toBe(runController.signal);
    expect(combinedSignal).not.toBe(toolController.signal);
    runController.abort();
    expect(combinedSignal?.aborted).toBe(true);
  });

  test("continues a current-session task by its A2A ID", async () => {
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => ({ ...pausedRecord, state: "working", questions: undefined })
    );
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => undefined,
        getByTaskId: (taskId) =>
          taskId === pausedRecord.taskId ? pausedRecord : undefined
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("agent_call_input_required"),
      JSON.stringify({
        taskId: pausedRecord.taskId,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "continued",
      taskId: pausedRecord.agentCallId,
      a2aTaskId: pausedRecord.taskId,
      state: "working"
    });
    expect(continueTask).toHaveBeenCalledTimes(1);
  });

  test("logs continuation metadata without recording secret answer values", async () => {
    const secretAnswer = "user-secret-that-must-not-be-logged";
    const recordWithSecretQuestion: AgentCallRecord = {
      ...pausedRecord,
      questions: [
        ...pausedRecord.questions!,
        {
          id: "credential",
          header: "Credential",
          question: "Provide the temporary credential.",
          isOther: false,
          isSecret: true,
          options: null
        }
      ]
    };
    const logger = new RecordingRuntimeLogger();
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => ({
        ...recordWithSecretQuestion,
        state: "working",
        questions: undefined
      })
    );
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => recordWithSecretQuestion,
        getByTaskId: () => undefined
      },
      continuator: { continueTask },
      logger
    });

    await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: recordWithSecretQuestion.agentCallId,
        answers: [
          { questionId: "scope", answers: ["Adapter only"] },
          { questionId: "credential", answers: [secretAnswer] }
        ]
      })
    );

    expect(JSON.stringify(logger.entries)).not.toContain(secretAnswer);
    expect(JSON.stringify(logger.entries)).not.toContain("Adapter only");
    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "main_agent.tool.started",
        fields: {
          runId: "run-continuation",
          sessionId: "session-current",
          toolName: "continue_task",
          taskId: recordWithSecretQuestion.agentCallId,
          questionIds: ["scope", "credential"]
        }
      },
      {
        level: "info",
        message: "main_agent.tool.completed",
        fields: {
          runId: "run-continuation",
          sessionId: "session-current",
          toolName: "continue_task",
          taskId: recordWithSecretQuestion.agentCallId,
          status: "continued",
          agentCallId: recordWithSecretQuestion.agentCallId,
          a2aTaskId: recordWithSecretQuestion.taskId,
          state: "working"
        }
      }
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain('"answerCount"');
  });

  test.each([
    {
      name: "child binding",
      createLogger: () =>
        new ThrowingRuntimeLogger({ throwOnChild: true })
    },
    {
      name: "started info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.started"
        })
    },
    {
      name: "completed info logging",
      createLogger: () =>
        new ThrowingRuntimeLogger({
          throwWhen: ({ level, message }) =>
            level === "info" && message === "main_agent.tool.completed"
        })
    }
  ])(
    "does not change a continuation result when the logger fails during $name",
    async ({ createLogger }) => {
      const getByAgentCallId = vi.fn<AgentCallReader["getByAgentCallId"]>(
        () => pausedRecord
      );
      const getByTaskId = vi.fn<AgentCallReader["getByTaskId"]>(
        () => undefined
      );
      const continuedRecord = {
        ...pausedRecord,
        state: "working" as const,
        questions: undefined
      };
      const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
        async () => continuedRecord
      );
      const tool = createTaskContinuationTool({
        reader: { getByAgentCallId, getByTaskId },
        continuator: { continueTask },
        logger: createLogger()
      });

      const output = await tool.invoke(
        runContext("user"),
        JSON.stringify({
          taskId: pausedRecord.agentCallId,
          answers: [{ questionId: "scope", answers: ["Adapter only"] }]
        })
      );

      expect(JSON.parse(String(output))).toEqual({
        status: "continued",
        taskId: pausedRecord.agentCallId,
        a2aTaskId: pausedRecord.taskId,
        state: "working"
      });
      expect(getByAgentCallId).toHaveBeenCalledTimes(1);
      expect(getByTaskId).toHaveBeenCalledTimes(1);
      expect(continueTask).toHaveBeenCalledTimes(1);
    }
  );

  test("logs a failed continuation without recording secret answers", async () => {
    const secretAnswer = "s".repeat(137);
    const failure = new Error(secretAnswer);
    const loggerFailure = new Error("Runtime logger error failure");
    const secretRecord: AgentCallRecord = {
      ...pausedRecord,
      questions: [
        {
          ...pausedRecord.questions![0]!,
          id: "credential",
          isSecret: true
        }
      ]
    };
    const logger = new ThrowingRuntimeLogger({
      failure: loggerFailure,
      throwWhen: ({ level }) => level === "error"
    });
    const continueTask = vi.fn(async () => {
      throw failure;
    });
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => secretRecord,
        getByTaskId: () => undefined
      },
      continuator: {
        continueTask
      },
      logger
    });
    const timeoutController = new AbortController();
    timeoutController.abort(
      new ToolTimeoutError({
        toolName: "continue_task",
        timeoutMs: 1
      })
    );

    await expect(
      tool.invoke(
        runContext("user"),
        JSON.stringify({
          taskId: secretRecord.agentCallId,
          answers: [{ questionId: "credential", answers: [secretAnswer] }]
        }),
        { signal: timeoutController.signal }
      )
    ).rejects.toBe(failure);

    const failedLog = logger.attempts.find(
      ({ level, message }) =>
        level === "error" && message === "main_agent.tool.failed"
    );
    expect(failedLog).toEqual({
      level: "error",
      message: "main_agent.tool.failed",
      fields: {
        runId: "run-continuation",
        sessionId: "session-current",
        toolName: "continue_task",
        taskId: secretRecord.agentCallId,
        questionIds: ["credential"],
        errorType: "Error"
      }
    });
    const serializedLogs = JSON.stringify(logger.attempts);
    expect(serializedLogs).not.toContain(secretAnswer);
    expect(serializedLogs).not.toContain(String(secretAnswer.length));
    expect(failedLog?.fields).not.toHaveProperty("error");
    expect(failedLog?.fields).not.toHaveProperty("errorMessageLength");
    expect(failedLog?.fields).not.toHaveProperty("answerCount");
    expect(continueTask).toHaveBeenCalledTimes(1);
  });

  test("accepts a pending question whose ID is __proto__", async () => {
    const recordWithPrototypeQuestion: AgentCallRecord = {
      ...pausedRecord,
      questions: [
        {
          ...pausedRecord.questions![0]!,
          id: "__proto__"
        }
      ]
    };
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => ({
        ...recordWithPrototypeQuestion,
        state: "working",
        questions: undefined
      })
    );
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => recordWithPrototypeQuestion,
        getByTaskId: () => undefined
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: recordWithPrototypeQuestion.agentCallId,
        answers: [{ questionId: "__proto__", answers: ["Approved"] }]
      })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "continued",
      state: "working"
    });
    const submittedAnswers = continueTask.mock.calls[0]?.[1];
    expect(Object.hasOwn(submittedAnswers ?? {}, "__proto__")).toBe(true);
    expect(submittedAnswers?.["__proto__"]).toEqual(["Approved"]);
  });

  test("returns ambiguous when both ID namespaces match different current-session tasks", async () => {
    const query = "colliding-task-id";
    const canonicalRecord: AgentCallRecord = {
      ...pausedRecord,
      agentCallId: query,
      taskId: "a2a-canonical-record"
    };
    const a2aRecord: AgentCallRecord = {
      ...pausedRecord,
      agentCallId: "huanlink-a2a-record",
      taskId: query
    };
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => canonicalRecord,
        getByTaskId: () => a2aRecord
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: query,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      })
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "ambiguous",
      taskId: query
    });
    expect(continueTask).not.toHaveBeenCalled();
  });

  test("uses a current-session A2A match when the canonical collision belongs to another session", async () => {
    const query = "cross-session-collision";
    const currentRecord: AgentCallRecord = {
      ...pausedRecord,
      taskId: query
    };
    const otherSessionRecord: AgentCallRecord = {
      ...pausedRecord,
      agentCallId: query,
      taskId: "a2a-other-session",
      sessionId: "session-other"
    };
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>(
      async () => ({ ...currentRecord, state: "working", questions: undefined })
    );
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => otherSessionRecord,
        getByTaskId: () => currentRecord
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: query,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "continued",
      taskId: currentRecord.agentCallId,
      a2aTaskId: query
    });
    expect(continueTask).toHaveBeenCalledWith(
      query,
      { scope: ["Adapter only"] },
      undefined
    );
  });

  test.each([
    {
      name: "a missing pending question",
      answers: [{ questionId: "scope", answers: ["Adapter only"] }]
    },
    {
      name: "an unknown question",
      answers: [
        { questionId: "scope", answers: ["Adapter only"] },
        { questionId: "approval", answers: ["Approved"] },
        { questionId: "unknown", answers: ["Unexpected"] }
      ]
    },
    {
      name: "a duplicate question",
      answers: [
        { questionId: "scope", answers: ["Adapter only"] },
        { questionId: "scope", answers: ["All files"] },
        { questionId: "approval", answers: ["Approved"] }
      ]
    },
    {
      name: "an empty answer array",
      answers: [
        { questionId: "scope", answers: [] },
        { questionId: "approval", answers: ["Approved"] }
      ]
    },
    {
      name: "a blank answer",
      answers: [
        { questionId: "scope", answers: ["   "] },
        { questionId: "approval", answers: ["Approved"] }
      ]
    }
  ])("rejects $name before continuation", async ({ answers }) => {
    const recordWithTwoQuestions: AgentCallRecord = {
      ...pausedRecord,
      questions: [
        ...pausedRecord.questions!,
        {
          id: "approval",
          header: "Approval",
          question: "Do you approve this action?",
          isOther: false,
          isSecret: false,
          options: null
        }
      ]
    };
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => recordWithTwoQuestions,
        getByTaskId: () => undefined
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({ taskId: recordWithTwoQuestions.agentCallId, answers })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "invalid-answers",
      taskId: recordWithTwoQuestions.agentCallId
    });
    expect(continueTask).not.toHaveBeenCalled();
  });

  test("rejects an input-required task without structured pending questions", async () => {
    const recordWithoutQuestions: AgentCallRecord = {
      ...pausedRecord,
      questions: undefined
    };
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => recordWithoutQuestions,
        getByTaskId: () => undefined
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: recordWithoutQuestions.agentCallId,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      })
    );

    expect(JSON.parse(String(output))).toMatchObject({
      status: "invalid-answers",
      taskId: recordWithoutQuestions.agentCallId
    });
    expect(continueTask).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "an unknown ID",
      byAgentCallId: undefined,
      byTaskId: undefined
    },
    {
      name: "a HuanLink ID from another session",
      byAgentCallId: { ...pausedRecord, sessionId: "session-other" },
      byTaskId: undefined
    },
    {
      name: "an A2A ID from another session",
      byAgentCallId: undefined,
      byTaskId: { ...pausedRecord, sessionId: "session-other" }
    }
  ])("returns the same not-found result for $name", async (scenario) => {
    const query = "unavailable-task";
    const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => scenario.byAgentCallId,
        getByTaskId: () => scenario.byTaskId
      },
      continuator: { continueTask }
    });

    const output = await tool.invoke(
      runContext("user"),
      JSON.stringify({
        taskId: query,
        answers: [{ questionId: "scope", answers: ["Adapter only"] }]
      })
    );

    expect(JSON.parse(String(output))).toEqual({
      status: "not-found",
      taskId: query
    });
    expect(continueTask).not.toHaveBeenCalled();
  });

  test.each(["working", "auth-required", "completed"] as const)(
    "rejects a task in the %s state before continuation",
    async (state) => {
      const unavailableRecord: AgentCallRecord = {
        ...pausedRecord,
        state
      };
      const continueTask = vi.fn<AgentCallContinuator["continueTask"]>();
      const tool = createTaskContinuationTool({
        reader: {
          getByAgentCallId: () => unavailableRecord,
          getByTaskId: () => undefined
        },
        continuator: { continueTask }
      });

      const output = await tool.invoke(
        runContext("user"),
        JSON.stringify({
          taskId: unavailableRecord.agentCallId,
          answers: [{ questionId: "scope", answers: ["Adapter only"] }]
        })
      );

      expect(JSON.parse(String(output))).toEqual({
        status: "invalid-state",
        taskId: unavailableRecord.agentCallId,
        state
      });
      expect(continueTask).not.toHaveBeenCalled();
    }
  );

  test("is enabled for user and input-required runs but disabled for terminal runs", async () => {
    const tool = createTaskContinuationTool({
      reader: {
        getByAgentCallId: () => undefined,
        getByTaskId: () => undefined
      },
      continuator: {
        continueTask: vi.fn()
      }
    });
    const agent = new Agent<OpenAiAgentsRunContext>({
      name: "Continuation availability",
      instructions: "Test tool availability.",
      model: "unused-model"
    });

    await expect(tool.isEnabled(runContext("user"), agent)).resolves.toBe(true);
    await expect(
      tool.isEnabled(runContext("agent_call_input_required"), agent)
    ).resolves.toBe(true);
    await expect(
      tool.isEnabled(runContext("agent_call_terminal"), agent)
    ).resolves.toBe(false);
  });
});
