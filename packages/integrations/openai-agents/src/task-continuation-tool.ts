import {
  type AgentCallContinuator,
  type AgentCallInputAnswers,
  type AgentCallInputQuestion,
  type AgentCallReader,
  type RuntimeLogFields,
  type RuntimeLogger
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import { combineAbortSignals } from "./abort-signals.js";
import {
  bestEffortRuntimeLogger,
  safeRuntimeErrorType
} from "./best-effort-runtime-logger.js";
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
  logger?: RuntimeLogger;
};

export function createTaskContinuationTool(
  options: CreateTaskContinuationToolOptions
) {
  const logger = bestEffortRuntimeLogger(options.logger);

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

      const toolLogger = logger.child({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        toolName: CONTINUE_TASK_TOOL_NAME
      });
      const requestFields = {
        taskId,
        questionIds: answers.map((answer) => answer.questionId)
      };
      toolLogger.info("main_agent.tool.started", requestFields);

      const complete = (result: unknown, fields: RuntimeLogFields) => {
        toolLogger.info("main_agent.tool.completed", fields);
        return JSON.stringify(result);
      };

      try {
        const resolution = resolveTaskRecord(
          options.reader,
          taskId,
          runContext.context.sessionId
        );
        if (resolution.status === "not-found") {
          return complete(
            { status: "not-found", taskId },
            { taskId, status: "not-found" }
          );
        }
        if (resolution.status === "ambiguous") {
          return complete(
            { status: "ambiguous", taskId },
            { taskId, status: "ambiguous" }
          );
        }
        const record = resolution.record;
        const taskFields = {
          taskId,
          agentCallId: record.agentCallId,
          a2aTaskId: record.taskId,
          state: record.state
        };
        if (record.state !== "input-required") {
          return complete(
            {
              status: "invalid-state",
              taskId,
              state: record.state
            },
            { ...taskFields, status: "invalid-state" }
          );
        }
        const validatedAnswers = validateAnswers(record.questions, answers);
        if (validatedAnswers === undefined) {
          return complete(
            {
              status: "invalid-answers",
              taskId,
              error:
                "Answers must cover every pending question exactly once with at least one non-blank answer."
            },
            { ...taskFields, status: "invalid-answers" }
          );
        }

        const continued = await options.continuator.continueTask(
          record.taskId,
          validatedAnswers,
          combineAbortSignals(runContext.context.signal, details?.signal)
        );

        return complete(
          {
            status: "continued",
            taskId: continued.agentCallId,
            a2aTaskId: continued.taskId,
            state: continued.state
          },
          {
            taskId,
            status: "continued",
            agentCallId: record.agentCallId,
            a2aTaskId: record.taskId,
            state: continued.state
          }
        );
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          ...requestFields,
          errorType: safeRuntimeErrorType(error)
        });
        throw error;
      }
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
