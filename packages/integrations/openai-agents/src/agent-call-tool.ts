import {
  TASK_EXECUTION_MODES,
  type AgentCallInvoker,
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

export const SUBMIT_CODEX_AGENT_CALL_TOOL_NAME =
  "submit_codex_agent_call" as const;

const parameters = z.object({
  task: z
    .string()
    .trim()
    .min(1)
    .describe("The concrete coding task that Codex should perform."),
  executionMode: z
    .enum(TASK_EXECUTION_MODES)
    .optional()
    .describe("Use async unless the user explicitly asks to block until completion.")
});

export type CreateCodexAgentCallToolOptions = {
  invoker: AgentCallInvoker;
  logger?: RuntimeLogger;
  skillId?: string;
};

export function createCodexAgentCallTool(
  options: CreateCodexAgentCallToolOptions
) {
  const logger = bestEffortRuntimeLogger(options.logger);
  const skillId = options.skillId ?? "codex-code-task";

  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    description:
      "Submit a coding task to the remote Codex agent. Async mode returns an accepted task ID; blocking mode returns the observed task outcome. Terminal re-entry follow-ups always run asynchronously.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger === "user" ||
      runContext.context.trigger === "agent_call_terminal",
    execute: async (
      { task, executionMode = "async" },
      runContext,
      details
    ) => {
      if (!runContext) {
        throw new Error("Codex AgentCall tool requires a HuanLink RunContext");
      }

      const effectiveExecutionMode =
        runContext.context.trigger === "agent_call_terminal"
          ? "async"
          : executionMode;

      const toolLogger = logger.child({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME
      });
      const inputFields = {
        executionMode: effectiveExecutionMode,
        inputLength: task.length
      };
      toolLogger.info("main_agent.tool.started", inputFields);
      toolLogger.debug("main_agent.tool.started", {
        ...inputFields,
        task
      });

      const signal = combineAbortSignals(
        runContext.context.signal,
        details?.signal
      );

      try {
        const result = await options.invoker.invoke({
          runId: runContext.context.runId,
          sessionId: runContext.context.sessionId,
          contextId: runContext.context.sessionId,
          skillId,
          input: task,
          executionMode: effectiveExecutionMode,
          ...(signal === undefined ? {} : { signal })
        });
        toolLogger.info("main_agent.tool.completed", {
          status: result.status,
          executionMode: result.executionMode,
          agentCallId: result.agentCallId,
          a2aTaskId: result.taskId,
          state: result.state
        });
        return JSON.stringify(result);
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          ...inputFields,
          errorType: safeRuntimeErrorType(error)
        });
        throw error;
      }
    }
  });
}
