import type { AgentCallInvoker } from "@huanlink/core";
import {
  OpenAiAgentsRuntime,
  createCodexAgentCallTool,
  type OpenAiAgentsRunContext,
  type OpenAiAgentsRunner
} from "@huanlink/integration-openai-agents";
import { Agent } from "@openai/agents";

export type CreatePhase3MainAgentRuntimeOptions = {
  invoker: AgentCallInvoker;
  runner?: OpenAiAgentsRunner;
  codexSkillId?: string;
};

export function createPhase3MainAgentRuntime(
  options: CreatePhase3MainAgentRuntimeOptions
): OpenAiAgentsRuntime {
  const tool = createCodexAgentCallTool({
    invoker: options.invoker,
    skillId: options.codexSkillId
  });
  const agent = new Agent<OpenAiAgentsRunContext>({
    name: "HuanLink MainAgent",
    instructions: [
      "You are HuanLink's MainAgent.",
      "When the user asks for a concrete code change, delegate it with submit_codex_agent_call.",
      "Use executionMode async unless the user explicitly asks to block until completion.",
      "After an async task is accepted, acknowledge its task ID and continue the current turn without waiting.",
      "After a blocking task returns, use its result in the current turn.",
      "When receiving an AgentCall terminal notification, summarize that result and the supplied latest context; do not delegate it again."
    ].join(" "),
    model: "gpt-5.4-mini",
    tools: [tool]
  });

  return new OpenAiAgentsRuntime({
    agent,
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });
}
