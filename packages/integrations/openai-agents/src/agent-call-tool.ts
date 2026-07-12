import {
  TASK_EXECUTION_MODES,
  type AgentCallInvoker
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

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
    .describe("Use background unless the user explicitly asks to wait.")
});

export type CreateCodexAgentCallToolOptions = {
  invoker: AgentCallInvoker;
  skillId?: string;
};

export function createCodexAgentCallTool(
  options: CreateCodexAgentCallToolOptions
) {
  const skillId = options.skillId ?? "codex-code-task";

  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    description:
      "Submit a coding task to the remote Codex agent. Background mode returns an accepted task ID; wait mode returns the observed task outcome.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger !== "agent_call_terminal",
    execute: async (
      { task, executionMode = "background" },
      runContext,
      details
    ) => {
      if (!runContext) {
        throw new Error("Codex AgentCall tool requires a HuanLink RunContext");
      }

      const signal = combineAbortSignals(
        runContext.context.signal,
        details?.signal
      );

      return JSON.stringify(
        await options.invoker.invoke({
          runId: runContext.context.runId,
          sessionId: runContext.context.sessionId,
          contextId: runContext.context.sessionId,
          skillId,
          input: task,
          executionMode,
          ...(signal === undefined ? {} : { signal })
        })
      );
    }
  });
}

function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const available = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (available.length === 0) {
    return undefined;
  }
  if (available.length === 1) {
    return available[0];
  }
  return AbortSignal.any(available);
}
