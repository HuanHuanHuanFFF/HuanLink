import type { AgentCallSubmitter } from "@huanlink/core";
import {
  OpenAiAgentsRuntime,
  SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
  createCodexAgentCallTool,
  type OpenAiAgentsRunContext,
  type OpenAiAgentsRunner
} from "@huanlink/integration-openai-agents";
import { Agent } from "@openai/agents";

export type CreatePhase3MainAgentRuntimeOptions = {
  submitter: AgentCallSubmitter;
  runner?: OpenAiAgentsRunner;
  codexSkillId?: string;
};

export function createPhase3MainAgentRuntime(
  options: CreatePhase3MainAgentRuntimeOptions
): OpenAiAgentsRuntime {
  const tool = createCodexAgentCallTool({
    submitter: options.submitter,
    skillId: options.codexSkillId
  });
  const agent = new Agent<OpenAiAgentsRunContext>({
    name: "HuanLink MainAgent",
    instructions: [
      "You are HuanLink's MainAgent.",
      "When the user asks for a concrete code change, delegate it with submit_codex_agent_call.",
      "The tool is asynchronous: report its accepted task IDs immediately and never wait for the remote task.",
      "When receiving an AgentCall terminal notification, summarize that result and the supplied latest context; do not delegate it again."
    ].join(" "),
    model: "gpt-5.4-mini",
    tools: [tool],
    toolUseBehavior: {
      stopAtToolNames: [SUBMIT_CODEX_AGENT_CALL_TOOL_NAME]
    }
  });

  return new OpenAiAgentsRuntime({
    agent,
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });
}
