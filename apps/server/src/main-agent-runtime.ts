import type {
  AgentCallContinuator,
  AgentCallInvoker,
  AgentCallReader,
  RuntimeLogger
} from "@huanlink/core";
import { NoopRuntimeLogger } from "@huanlink/core";
import {
  OpenAiAgentsRuntime,
  createCodexAgentCallTool,
  createTaskContinuationTool,
  createTaskStatusTool,
  type OpenAiAgentsRunContext,
  type OpenAiAgentsRunner
} from "@huanlink/integration-openai-agents";
import { Agent, type Model, type ModelSettings } from "@openai/agents";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

export type MainAgentModelBinding = {
  model: string | Model;
  modelSettings?: ModelSettings;
};

export type CreatePhase3MainAgentRuntimeOptions = {
  invoker: AgentCallInvoker;
  taskReader: AgentCallReader;
  taskContinuator: AgentCallContinuator;
  runner?: OpenAiAgentsRunner;
  codexSkillId?: string;
  modelBinding?: MainAgentModelBinding;
  logger?: RuntimeLogger;
};

export function createPhase3MainAgentRuntime(
  options: CreatePhase3MainAgentRuntimeOptions
): OpenAiAgentsRuntime {
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger()
  );
  const submitTool = createCodexAgentCallTool({
    invoker: options.invoker,
    skillId: options.codexSkillId,
    logger: logger.child({ source: "main_agent.tool.submit" })
  });
  const taskStatusTool = createTaskStatusTool({
    reader: options.taskReader,
    logger: logger.child({ source: "main_agent.tool.status" })
  });
  const taskContinuationTool = createTaskContinuationTool({
    reader: options.taskReader,
    continuator: options.taskContinuator,
    logger: logger.child({ source: "main_agent.tool.continue" })
  });
  const agent = new Agent<OpenAiAgentsRunContext>({
    name: "HuanLink MainAgent",
    instructions: [
      "You are HuanLink's MainAgent.",
      "When the user asks for a concrete code change, delegate it with submit_codex_agent_call.",
      "When the user asks to inspect or report an existing task, use get_task_status with its HuanLink or A2A task ID.",
      "For an existing task status query, never use submit_codex_agent_call.",
      "When an input-required task already has complete and unambiguous answers in the supplied session context, use continue_task for this same task with every pending question answered.",
      "When a material choice is missing or ambiguous, ask the QQ user a concise question, explicitly tell them to reply with /huanlink or @HuanLink, and wait for their answer.",
      "When the user later supplies answers for an existing input-required task, use continue_task for that original task and never submit a replacement AgentCall.",
      "Use executionMode async unless the user explicitly asks to block until completion.",
      "After an async task is accepted, acknowledge its task ID and continue the current turn without waiting.",
      "After a blocking task returns, use its result in the current turn.",
      "When receiving an AgentCall terminal notification, summarize that result and the supplied latest context; do not delegate it again."
    ].join(" "),
    model: options.modelBinding?.model ?? "gpt-5.4-mini",
    ...(options.modelBinding?.modelSettings === undefined
      ? {}
      : { modelSettings: options.modelBinding.modelSettings }),
    tools: [submitTool, taskStatusTool, taskContinuationTool]
  });

  return new OpenAiAgentsRuntime({
    agent,
    ...(options.runner === undefined ? {} : { runner: options.runner })
  });
}
