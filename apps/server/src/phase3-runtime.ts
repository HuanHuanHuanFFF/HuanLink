import { randomUUID } from "node:crypto";

import {
  AgentCallService,
  AgentTurnScheduler,
  NoopRuntimeLogger,
  type AgentCallBackgroundErrorListener,
  type AgentCallRecord,
  type AgentCallTransport,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type AgentRuntimeTrigger,
  type RunId,
  type RuntimeLogFields,
  type RuntimeLogger,
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
import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

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
  logger?: RuntimeLogger;
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
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger()
  );
  const transport =
    options.transport ??
    new A2aAgentCallTransport({
      origin: options.codexA2aOrigin,
      logger: logger.child({ source: "a2a.transport" })
    });
  const agentCalls = new AgentCallService({
    transport,
    logger: logger.child({ source: "agent_call.service" })
  });
  const mainAgent = createPhase3MainAgentRuntime({
    invoker: agentCalls,
    taskReader: agentCalls,
    taskContinuator: agentCalls,
    codexSkillId: options.codexSkillId,
    runner: options.runner,
    modelBinding: options.modelBinding,
    logger: logger.child({ source: "main_agent" })
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

  const runMainAgentTurn = async (
    input: Phase3MainAgentInput & { trigger: AgentRuntimeTrigger }
  ): Promise<AgentRuntimeResult> => {
    const fields = {
      sessionId: input.sessionId,
      runId: input.runId,
      trigger: input.trigger
    } satisfies RuntimeLogFields;
    logger.info("main_agent.run.started", fields);
    logger.debug("main_agent.run.input", {
      ...fields,
      payload: { input: input.input }
    });
    try {
      const result = await turns.run(input);
      logger.info("main_agent.run.completed", fields);
      logger.debug("main_agent.run.output", {
        ...fields,
        payload: { output: result.output }
      });
      return result;
    } catch (error) {
      if (input.signal?.aborted === true) {
        logger.debug("main_agent.run.aborted", fields);
      } else {
        logger.error("main_agent.run.failed", { ...fields, error });
      }
      throw error;
    }
  };

  const runReentry = async (
    agentCall: AgentCallRecord,
    trigger: Phase3ReentryResult["trigger"],
    signal: AbortSignal
  ): Promise<void> => {
    const reason =
      trigger === "agent_call_input_required" ? "input-required" : "terminal";
    const baseFields = agentCallLogFields(agentCall, trigger);
    logger.info("main_agent.reentry.started", baseFields);
    let cleanup: Phase3ReentryCleanup | void = undefined;
    let runId: RunId | undefined;
    try {
      cleanup = await waitWithSignal(
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
      signal.throwIfAborted();
      const latestContext = await waitWithSignal(
        Promise.resolve().then(() => getLatestContext(agentCall.sessionId)),
        signal
      );
      const currentRunId = createRunId();
      runId = currentRunId;
      const paused =
        trigger === "agent_call_input_required"
          ? buildAgentCallPausedPayload(agentCall, latestContext)
          : undefined;
      const input =
        paused === undefined
          ? buildAgentCallReentryInput(agentCall, latestContext)
          : buildAgentCallPausedReentryInput(paused);
      const reentryFields = { ...baseFields, runId: currentRunId };
      logger.info("main_agent.reentry.context_ready", reentryFields);
      logger.debug("main_agent.reentry.payload", {
        ...reentryFields,
        payload: { latestContext, input }
      });
      const result = await waitWithSignal(
        runMainAgentTurn({
          runId: currentRunId,
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
            runId: currentRunId,
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
      logger.info("main_agent.reentry.completed", reentryFields);
    } catch (error) {
      const failureFields = {
        ...baseFields,
        ...(runId === undefined ? {} : { runId })
      };
      if (signal.aborted) {
        logger.debug("main_agent.reentry.aborted", failureFields);
      } else {
        logger.error("main_agent.reentry.failed", {
          ...failureFields,
          error
        });
      }
      throw error;
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
      runMainAgentTurn({
        ...input,
        trigger: "user"
      }),
    close() {
      closeOperation ??= performClose();
      return closeOperation;
    }
  };
}

function agentCallLogFields(
  agentCall: AgentCallRecord,
  trigger: Phase3ReentryResult["trigger"]
): RuntimeLogFields {
  return {
    sessionId: agentCall.sessionId,
    agentCallId: agentCall.agentCallId,
    a2aTaskId: agentCall.taskId,
    ...(agentCall.contextId === undefined
      ? {}
      : { contextId: agentCall.contextId }),
    trigger
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
