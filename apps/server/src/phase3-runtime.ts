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

import {
  buildAgentCallPausedPayload,
  buildAgentCallPausedReentryInput,
  buildAgentCallReentryInput,
  type AgentCallPausedPayload
} from "./agent-call-reentry.js";
import {
  createPhase3MainAgentRuntime,
  type MainAgentModelBinding
} from "./main-agent-runtime.js";

export type Phase3ReentryResult = {
  runId: RunId;
  sessionId: SessionId;
  trigger: "agent_call_input_required" | "agent_call_terminal";
  reason: "input-required" | "terminal";
  latestContext: string;
  input: string;
  output: string;
  agentCall: AgentCallRecord;
  paused?: AgentCallPausedPayload;
};

export type Phase3BeforeReentryInput = Pick<
  Phase3ReentryResult,
  "sessionId" | "trigger" | "reason" | "agentCall"
> & { signal: AbortSignal };

export type Phase3ReentryCleanup = () => Promise<void> | void;

export type CreatePhase3HuanLinkRuntimeOptions = {
  codexA2aOrigin: string;
  codexSkillId?: string;
  runner?: OpenAiAgentsRunner;
  modelBinding?: MainAgentModelBinding;
  transport?: AgentCallTransport;
  createRunId?: () => RunId;
  getLatestContext?: (sessionId: SessionId) => Promise<string> | string;
  beforeReentry?: (
    input: Phase3BeforeReentryInput
  ) => Promise<Phase3ReentryCleanup | void> | Phase3ReentryCleanup | void;
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
    taskReader: agentCalls,
    taskContinuator: agentCalls,
    codexSkillId: options.codexSkillId,
    runner: options.runner,
    modelBinding: options.modelBinding
  });
  const turns = new AgentTurnScheduler({ runtime: mainAgent });
  const activeReentries = new Map<AbortController, Promise<void>>();
  const createRunId = options.createRunId ?? randomUUID;
  const getLatestContext = options.getLatestContext ?? (() => "");
  const beforeReentry = options.beforeReentry ?? (() => undefined);
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
  let closed = false;
  let closeOperation: Promise<void> | undefined;

  const runReentry = async (
    agentCall: AgentCallRecord,
    trigger: Phase3ReentryResult["trigger"],
    signal: AbortSignal
  ): Promise<void> => {
    const reason =
      trigger === "agent_call_input_required" ? "input-required" : "terminal";
    const cleanup = await waitWithSignal(
      Promise.resolve().then(() =>
        beforeReentry({
          sessionId: agentCall.sessionId,
          trigger,
          reason,
          agentCall,
          signal
        })
      ),
      signal
    );
    try {
      signal.throwIfAborted();
      const latestContext = await waitWithSignal(
        Promise.resolve().then(() => getLatestContext(agentCall.sessionId)),
        signal
      );
      const runId = createRunId();
      const paused =
        trigger === "agent_call_input_required"
          ? buildAgentCallPausedPayload(agentCall, latestContext)
          : undefined;
      const input =
        paused === undefined
          ? buildAgentCallReentryInput(agentCall, latestContext)
          : buildAgentCallPausedReentryInput(paused);
      const result = await waitWithSignal(
        turns.run({
          runId,
          sessionId: agentCall.sessionId,
          trigger,
          input,
          signal
        }),
        signal
      );
      await waitWithSignal(
        Promise.resolve().then(() =>
          onReentry({
            runId,
            sessionId: agentCall.sessionId,
            trigger,
            reason,
            latestContext,
            input,
            output: result.output,
            agentCall,
            ...(paused === undefined ? {} : { paused })
          })
        ),
        signal
      );
    } finally {
      if (cleanup !== undefined) {
        await cleanup();
      }
    }
  };

  const superviseReentry = (
    agentCall: AgentCallRecord,
    trigger: Phase3ReentryResult["trigger"]
  ): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    const operation = runReentry(agentCall, trigger, controller.signal)
      .catch((error) => {
        if (closed && controller.signal.aborted) {
          return;
        }
        throw error;
      })
      .finally(() => activeReentries.delete(controller));
    activeReentries.set(controller, operation);
    return operation;
  };

  const unsubscribePaused = agentCalls.onPaused((agentCall) =>
    superviseReentry(agentCall, "agent_call_input_required")
  );
  const unsubscribeTerminal = agentCalls.onTerminal((agentCall) =>
    superviseReentry(agentCall, "agent_call_terminal")
  );

  const performClose = async (): Promise<void> => {
    closed = true;
    unsubscribePaused();
    unsubscribeTerminal();
    const closeReason = new Error("Phase 3 runtime closed");
    for (const controller of activeReentries.keys()) {
      controller.abort(closeReason);
    }
    const reentryDrain = Promise.allSettled([...activeReentries.values()]);
    try {
      await agentCalls.close();
      await reentryDrain;
    } finally {
      unsubscribeBackgroundError();
    }
  };

  return {
    agentCalls,
    runMainAgent: (input) =>
      turns.run({
        ...input,
        trigger: "user"
      }),
    close() {
      closeOperation ??= performClose();
      return closeOperation;
    }
  };
}

function waitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Phase 3 re-entry aborted");
}
