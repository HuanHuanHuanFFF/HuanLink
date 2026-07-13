import type {
  AgentCallContinuator,
  AgentCallInputAnswers,
  AgentCallInputQuestion,
  AgentCallReader
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import { combineAbortSignals } from "./abort-signals.js";
import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";
import { resolveTaskRecord } from "./task-record-resolution.js";

export const CONTINUE_TASK_TOOL_NAME = "continue_task" as const;

const parameters = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe("A HuanLink task ID or external A2A task ID to continue."),
  answers: z.array(
    z.object({
      questionId: z.string().trim().min(1),
      answers: z.array(z.string())
    })
  )
});

export type CreateTaskContinuationToolOptions = {
  reader: AgentCallReader;
  continuator: AgentCallContinuator;
};

export function createTaskContinuationTool(
  options: CreateTaskContinuationToolOptions
) {
  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: CONTINUE_TASK_TOOL_NAME,
    description:
      "Continue an input-required task in this session with answers to every pending question.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger === "user" ||
      runContext.context.trigger === "agent_call_input_required",
    execute: async ({ taskId, answers }, runContext, details) => {
      if (!runContext) {
        throw new Error("Task continuation tool requires a HuanLink RunContext");
      }

      const resolution = resolveTaskRecord(
        options.reader,
        taskId,
        runContext.context.sessionId
      );
      if (resolution.status === "not-found") {
        return JSON.stringify({ status: "not-found", taskId });
      }
      if (resolution.status === "ambiguous") {
        return JSON.stringify({ status: "ambiguous", taskId });
      }
      const record = resolution.record;
      if (record.state !== "input-required") {
        return JSON.stringify({
          status: "invalid-state",
          taskId,
          state: record.state
        });
      }
      const validatedAnswers = validateAnswers(record.questions, answers);
      if (validatedAnswers === undefined) {
        return JSON.stringify({
          status: "invalid-answers",
          taskId,
          error:
            "Answers must cover every pending question exactly once with at least one non-blank answer."
        });
      }

      const continued = await options.continuator.continueTask(
        record.taskId,
        validatedAnswers,
        combineAbortSignals(runContext.context.signal, details?.signal)
      );

      return JSON.stringify({
        status: "continued",
        taskId: continued.agentCallId,
        a2aTaskId: continued.taskId,
        state: continued.state
      });
    }
  });
}

function validateAnswers(
  questions: AgentCallInputQuestion[] | undefined,
  answers: Array<{ questionId: string; answers: string[] }>
): AgentCallInputAnswers | undefined {
  if (questions === undefined || questions.length === 0) {
    return undefined;
  }
  const pendingQuestionIds = new Set(questions.map((question) => question.id));
  if (pendingQuestionIds.size !== questions.length) {
    return undefined;
  }

  const answersByQuestionId = new Map<string, string[]>();
  for (const answer of answers) {
    if (
      !pendingQuestionIds.has(answer.questionId) ||
      answersByQuestionId.has(answer.questionId) ||
      answer.answers.length === 0 ||
      answer.answers.some((value) => value.trim().length === 0)
    ) {
      return undefined;
    }
    answersByQuestionId.set(answer.questionId, [...answer.answers]);
  }

  return answersByQuestionId.size === pendingQuestionIds.size
    ? Object.fromEntries(answersByQuestionId)
    : undefined;
}
