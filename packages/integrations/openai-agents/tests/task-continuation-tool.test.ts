import { describe, expect, test, vi } from "vitest";

import type {
  AgentCallContinuator,
  AgentCallReader,
  AgentCallRecord
} from "@huanlink/core";
import { Agent, RunContext } from "@openai/agents";

import {
  createTaskContinuationTool,
  type OpenAiAgentsRunContext
} from "../src/index.js";

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
