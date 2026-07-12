import type { AgentCallSubmitter } from "@huanlink/core";
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
    .describe("The concrete coding task that Codex should perform.")
});

export type CreateCodexAgentCallToolOptions = {
  submitter: AgentCallSubmitter;
  skillId?: string;
};

export function createCodexAgentCallTool(
  options: CreateCodexAgentCallToolOptions
) {
  const skillId = options.skillId ?? "codex-code-task";

  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    description:
      "Submit a coding task to the remote Codex agent. The call is asynchronous and returns an accepted task ID immediately.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger !== "agent_call_terminal",
    execute: async ({ task }, runContext) => {
      if (!runContext) {
        throw new Error("Codex AgentCall tool requires a HuanLink RunContext");
      }

      const receipt = await options.submitter.submit({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        contextId: runContext.context.sessionId,
        skillId,
        input: task
      });

      return JSON.stringify(receipt);
    }
  });
}
