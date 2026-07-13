import type { AgentCallInvoker, AgentCallReader } from "@huanlink/core";
import {
  OpenAiAgentsRuntime,
  createCodexAgentCallTool,
  createTaskStatusTool,
  type OpenAiAgentsRunContext,
  type OpenAiAgentsRunner
} from "@huanlink/integration-openai-agents";
import { Agent, type Model, type ModelSettings } from "@openai/agents";

export type MainAgentModelBinding = {
  model: string | Model;
  modelSettings?: ModelSettings;
};

export type CreatePhase3MainAgentRuntimeOptions = {
  invoker: AgentCallInvoker;
  taskReader: AgentCallReader;
  runner?: OpenAiAgentsRunner;
  codexSkillId?: string;
  modelBinding?: MainAgentModelBinding;
};

export function createPhase3MainAgentRuntime(
  options: CreatePhase3MainAgentRuntimeOptions
): OpenAiAgentsRuntime {
  const submitTool = createCodexAgentCallTool({
    invoker: options.invoker,
    skillId: options.codexSkillId
  });
  const taskStatusTool = createTaskStatusTool({ reader: options.taskReader });
  const agent = new Agent<OpenAiAgentsRunContext>({
    name: "HuanLink MainAgent",
    instructions: [
      "You are HuanLink's MainAgent.",
      "When the user asks for a concrete code change, delegate it with submit_codex_agent_call.",
      "When the user asks to inspect or report an existing task, use get_task_status with its HuanLink or A2A task ID.",
      "For an existing task status query, never use submit_codex_agent_call.",
      "Use executionMode async unless the user explicitly asks to block until completion.",
      "After an async task is accepted, acknowledge its task ID and continue the current turn without waiting.",
      "After a blocking task returns, use its result in the current turn.",
      "When receiving an AgentCall terminal notification, summarize that result and the supplied latest context; do not delegate it again."
    ].join(" "),
    model: options.modelBinding?.model ?? "gpt-5.4-mini",
    ...(options.modelBinding?.modelSettings === undefined
      ? {}
      : { modelSettings: options.modelBinding.modelSettings }),
    tools: [submitTool, taskStatusTool]
  });

  return new OpenAiAgentsRuntime({
    agent,
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });
}
