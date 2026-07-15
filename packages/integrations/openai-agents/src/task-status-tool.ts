import {
  type AgentCallInputQuestion,
  type AgentCallReader,
  type AgentCallRecord,
  type RuntimeLogFields,
  type RuntimeLogger
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  bestEffortRuntimeLogger,
  safeRuntimeErrorType
} from "./best-effort-runtime-logger.js";
import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";
import { resolveTaskRecord } from "./task-record-resolution.js";

export const GET_TASK_STATUS_TOOL_NAME = "get_task_status" as const;

const parameters = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe("A HuanLink task ID or external A2A task ID to look up.")
});

export type CreateTaskStatusToolOptions = {
  logger?: RuntimeLogger;
  reader: AgentCallReader;
};

type TaskStatusToolResult =
  | { status: "not-found" | "ambiguous"; taskId: string }
  | { status: "found"; task: ReturnType<typeof publicTaskStatus> };

export function createTaskStatusTool(options: CreateTaskStatusToolOptions) {
  const logger = bestEffortRuntimeLogger(options.logger);

  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: GET_TASK_STATUS_TOOL_NAME,
    description:
      "Read the current status of an existing HuanLink task in this session without creating or changing any task.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger === "user" ||
      runContext.context.trigger === "agent_call_input_required",
    execute: ({ taskId }, runContext) => {
      if (!runContext) {
        throw new Error("Task status tool requires a HuanLink RunContext");
      }

      const toolLogger = logger.child({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        toolName: GET_TASK_STATUS_TOOL_NAME
      });
      toolLogger.info("main_agent.tool.started", { taskId });

      const complete = (
        result: TaskStatusToolResult,
        fields: RuntimeLogFields
      ) => {
        toolLogger.info("main_agent.tool.completed", fields);
        toolLogger.debug("main_agent.tool.completed", {
          ...fields,
          result: taskStatusLogProjection(result)
        });
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
            { taskId, resolutionStatus: "not-found" }
          );
        }
        if (resolution.status === "ambiguous") {
          return complete(
            { status: "ambiguous", taskId },
            { taskId, resolutionStatus: "ambiguous" }
          );
        }

        const result: TaskStatusToolResult = {
          status: "found",
          task: publicTaskStatus(resolution.record)
        };
        return complete(result, {
          taskId,
          resolutionStatus: "found",
          agentCallId: resolution.record.agentCallId,
          a2aTaskId: resolution.record.taskId,
          state: resolution.record.state
        });
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          taskId,
          errorType: safeRuntimeErrorType(error)
        });
        throw error;
      }
    }
  });
}

function taskStatusLogProjection(result: TaskStatusToolResult): unknown {
  if (result.status !== "found") {
    return { ...result };
  }

  const { artifacts, questions, ...taskFields } = result.task;
  return {
    status: "found",
    task: {
      ...taskFields,
      ...(questions === undefined
        ? {}
        : { questions: questions.map(questionLogProjection) }),
      artifacts: artifacts.map((artifact) => ({ ...artifact }))
    }
  };
}

function questionLogProjection(question: AgentCallInputQuestion): unknown {
  if (question.isSecret) {
    return {
      id: question.id,
      isOther: question.isOther,
      isSecret: true
    };
  }

  return {
    ...question,
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({ ...option }))
  };
}

function publicTaskStatus(record: AgentCallRecord) {
  return {
    taskId: record.agentCallId,
    a2aTaskId: record.taskId,
    state: record.state,
    executionMode: record.executionMode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.statusMessage === undefined
      ? {}
      : { statusMessage: record.statusMessage }),
    ...(record.terminalNotificationError === undefined
      ? {}
      : { notificationError: record.terminalNotificationError }),
    ...(record.questions === undefined
      ? {}
      : {
          questions: record.questions.map((question) => ({
            ...question,
            options:
              question.options === null
                ? null
                : question.options.map((option) => ({ ...option }))
          }))
        }),
    artifacts: record.artifacts.map((artifact) => ({ ...artifact }))
  };
}
