import {
  type AsyncToolTaskStatusQueryResult,
  type AsyncToolTaskStatusReader,
  type RuntimeLogFields,
  type RuntimeLogger,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  bestEffortRuntimeLogger,
  safeRuntimeErrorType,
} from "./best-effort-runtime-logger.js";
import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";
import { withSessionToolHistory } from "./session-tool-history-tool.js";

export const GET_TASK_STATUS_TOOL_NAME = "get_task_status" as const;

const parameters = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe("The HuanLink task ID to look up in the current session."),
});

export type CreateTaskStatusToolOptions = {
  logger?: RuntimeLogger;
  reader: AsyncToolTaskStatusReader;
  historyRecorder?: SessionToolHistoryRecorder;
};

type TaskStatusToolResult = AsyncToolTaskStatusQueryResult;

export function createTaskStatusTool(options: CreateTaskStatusToolOptions) {
  const logger = bestEffortRuntimeLogger(options.logger);

  const functionTool = tool<typeof parameters, OpenAiAgentsRunContext>({
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
        toolName: GET_TASK_STATUS_TOOL_NAME,
      });
      toolLogger.info("main_agent.tool.started", { taskId });

      const complete = (
        result: TaskStatusToolResult,
        fields: RuntimeLogFields,
      ) => {
        toolLogger.info("main_agent.tool.completed", fields);
        return JSON.stringify(result);
      };

      try {
        const result = options.reader.getStatus(
          runContext.context.sessionId,
          taskId,
        );
        if (result.status === "not-found") {
          return complete(result, { taskId, resolutionStatus: "not-found" });
        }
        return complete(result, {
          taskId,
          resolutionStatus: "found",
          kind: result.kind,
          state: result.state,
        });
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          taskId,
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
