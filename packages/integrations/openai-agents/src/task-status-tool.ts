import type { AgentCallReader, AgentCallRecord } from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";

export const GET_TASK_STATUS_TOOL_NAME = "get_task_status" as const;

const parameters = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe("A HuanLink task ID or external A2A task ID to look up.")
});

export type CreateTaskStatusToolOptions = {
  reader: AgentCallReader;
};

export function createTaskStatusTool(options: CreateTaskStatusToolOptions) {
  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: GET_TASK_STATUS_TOOL_NAME,
    description:
      "Read the current status of an existing HuanLink task in this session without creating or changing any task.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger !== "agent_call_terminal",
    execute: ({ taskId }, runContext) => {
      if (!runContext) {
        throw new Error("Task status tool requires a HuanLink RunContext");
      }

      const candidates = [
        options.reader.getByAgentCallId(taskId),
        options.reader.getByTaskId(taskId)
      ].filter(
        (candidate): candidate is AgentCallRecord =>
          candidate !== undefined &&
          candidate.sessionId === runContext.context.sessionId
      );
      const recordsByAgentCallId = new Map(
        candidates.map((candidate) => [candidate.agentCallId, candidate])
      );
      if (recordsByAgentCallId.size === 0) {
        return JSON.stringify({ status: "not-found", taskId });
      }
      if (recordsByAgentCallId.size > 1) {
        return JSON.stringify({ status: "ambiguous", taskId });
      }

      const record = recordsByAgentCallId.values().next().value!;

      return JSON.stringify({
        status: "found",
        task: publicTaskStatus(record)
      });
    }
  });
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
    artifacts: record.artifacts.map((artifact) => ({ ...artifact }))
  };
}
