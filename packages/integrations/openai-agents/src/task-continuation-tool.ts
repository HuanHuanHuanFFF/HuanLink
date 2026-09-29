import {
  type AgentCallContinuator,
  type AgentCallInputAnswers,
  type RuntimeLogFields,
  type RuntimeLogger,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import { combineAbortSignals } from "./abort-signals.js";
import {
  bestEffortRuntimeLogger,
  safeRuntimeErrorType,
} from "./best-effort-runtime-logger.js";
import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";
import { withSessionToolHistory } from "./session-tool-history-tool.js";

export const CONTINUE_TASK_TOOL_NAME = "continue_task" as const;

const parameters = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe("The HuanLink task ID to continue in the current session."),
  answers: z.array(
    z.object({
      questionId: z.string().trim().min(1),
      answers: z.array(z.string()),
    }),
  ),
});

export type CreateTaskContinuationToolOptions = {
  continuator: AgentCallContinuator;
  logger?: RuntimeLogger;
  historyRecorder?: SessionToolHistoryRecorder;
};

export function createTaskContinuationTool(
  options: CreateTaskContinuationToolOptions,
) {
  const logger = bestEffortRuntimeLogger(options.logger);

  const functionTool = tool<typeof parameters, OpenAiAgentsRunContext>({
    name: CONTINUE_TASK_TOOL_NAME,
    description:
      "Continue an input-required task in this session with answers to every pending question.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger === "user" ||
      runContext.context.trigger === "agent_call_input_required",
    execute: async ({ taskId, answers }, runContext, details) => {
      if (!runContext) {
        throw new Error(
          "Task continuation tool requires a HuanLink RunContext",
        );
      }

      const toolLogger = logger.child({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        toolName: CONTINUE_TASK_TOOL_NAME,
      });
      const requestFields = {
        taskId,
        questionIds: answers.map((answer) => answer.questionId),
      };
      toolLogger.info("main_agent.tool.started", requestFields);

      const complete = (result: unknown, fields: RuntimeLogFields) => {
        toolLogger.info("main_agent.tool.completed", fields);
        return JSON.stringify(result);
      };

      try {
        const validatedAnswers = answersToRecord(answers);
        if (validatedAnswers === undefined) {
          return complete(
            {
              status: "invalid-answers",
              taskId,
              error: "Each question ID must appear at most once.",
            },
            { taskId, status: "invalid-answers" },
          );
        }
        const signal = combineAbortSignals(
          runContext.context.signal,
          details?.signal,
        );
        const result = await options.continuator.continueTask({
          sessionId: runContext.context.sessionId,
          taskId,
          answers: validatedAnswers,
          ...(signal === undefined ? {} : { signal }),
        });

        return complete(result, {
          taskId,
          status: result.status,
          ...("state" in result ? { state: result.state } : {}),
        });
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          ...requestFields,
          errorType: safeRuntimeErrorType(error),
        });
        throw error;
      }
    },
  });
  return withSessionToolHistory(
    functionTool,
    options.historyRecorder,
    logger,
    (rawArguments) => parameters.parse(JSON.parse(rawArguments)),
  );
}

function answersToRecord(
  answers: Array<{ questionId: string; answers: string[] }>,
): AgentCallInputAnswers | undefined {
  const answersByQuestionId = new Map<string, string[]>();
  for (const answer of answers) {
    if (answersByQuestionId.has(answer.questionId)) {
      return undefined;
    }
    answersByQuestionId.set(answer.questionId, [...answer.answers]);
  }

  return Object.fromEntries(answersByQuestionId);
}
