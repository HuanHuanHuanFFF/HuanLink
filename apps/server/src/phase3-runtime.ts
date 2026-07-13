import { randomUUID } from "node:crypto";

import {
  AgentCallService,
  AgentTurnScheduler,
  type AgentCallBackgroundErrorListener,
  type AgentCallRecord,
  type AgentCallTransport,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type RunId,
  type SessionId
} from "@huanlink/core";
import { A2aAgentCallTransport } from "@huanlink/integration-a2a-client";
import type { OpenAiAgentsRunner } from "@huanlink/integration-openai-agents";

import { buildAgentCallReentryInput } from "./agent-call-reentry.js";
import {
  createPhase3MainAgentRuntime,
  type MainAgentModelBinding
} from "./main-agent-runtime.js";

export type Phase3ReentryResult = {
  runId: RunId;
  sessionId: SessionId;
  latestContext: string;
  input: string;
  output: string;
  agentCall: AgentCallRecord;
};

export type CreatePhase3HuanLinkRuntimeOptions = {
  codexA2aOrigin: string;
  codexSkillId?: string;
  runner?: OpenAiAgentsRunner;
  modelBinding?: MainAgentModelBinding;
  transport?: AgentCallTransport;
  createRunId?: () => RunId;
  getLatestContext?: (sessionId: SessionId) => Promise<string> | string;
  onReentry?: (result: Phase3ReentryResult) => Promise<void> | void;
  onBackgroundError?: AgentCallBackgroundErrorListener;
};

export type Phase3MainAgentInput = Pick<
  AgentRuntimeInput,
  "runId" | "sessionId" | "input" | "signal"
>;

export interface Phase3HuanLinkRuntime {
  readonly agentCalls: AgentCallService;
  runMainAgent(input: Phase3MainAgentInput): Promise<AgentRuntimeResult>;
  close(): Promise<void>;
}

export function createPhase3HuanLinkRuntime(
  options: CreatePhase3HuanLinkRuntimeOptions
): Phase3HuanLinkRuntime {
  const transport =
    options.transport ??
    new A2aAgentCallTransport({ origin: options.codexA2aOrigin });
  const agentCalls = new AgentCallService({ transport });
  const mainAgent = createPhase3MainAgentRuntime({
    invoker: agentCalls,
    codexSkillId: options.codexSkillId,
    runner: options.runner,
    modelBinding: options.modelBinding
  });
  const turns = new AgentTurnScheduler({ runtime: mainAgent });
  const createRunId = options.createRunId ?? randomUUID;
  const getLatestContext = options.getLatestContext ?? (() => "");
  const onReentry = options.onReentry ?? (() => undefined);
  const onBackgroundError =
    options.onBackgroundError ??
    ((error: Error, record: AgentCallRecord | undefined) => {
      console.error(
        `Phase 3 AgentCall background failure${
          record === undefined ? "" : ` for ${record.agentCallId}/${record.taskId}`
        }`,
        error
      );
    });

  const unsubscribeBackgroundError =
    agentCalls.onBackgroundError(onBackgroundError);

  const unsubscribe = agentCalls.onTerminal(async (agentCall) => {
    const latestContext = await getLatestContext(agentCall.sessionId);
    const runId = createRunId();
    const input = buildAgentCallReentryInput(agentCall, latestContext);
    const result = await turns.run({
      runId,
      sessionId: agentCall.sessionId,
      trigger: "agent_call_terminal",
      input
    });
    await onReentry({
      runId,
      sessionId: agentCall.sessionId,
      latestContext,
      input,
      output: result.output,
      agentCall
    });
  });

  return {
    agentCalls,
    runMainAgent: (input) =>
      turns.run({
        ...input,
        trigger: "user"
      }),
    async close() {
      unsubscribe();
      await agentCalls.close();
      unsubscribeBackgroundError();
    }
  };
}
