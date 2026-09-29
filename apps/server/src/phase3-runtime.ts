import { randomUUID } from "node:crypto";

import {
  AgentCallService,
  AgentTurnScheduler,
  AsyncToolTaskService,
  NoopRuntimeLogger,
  isAsyncToolTaskTerminalState,
  type AsyncToolTask,
  type AsyncToolTaskStatus,
  type AgentCallBackgroundErrorListener,
  type AgentCallTransport,
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  type AgentRuntimeTrigger,
  type ConversationSessionStore,
  type RunId,
  type RuntimeLogFields,
  type RuntimeLogger,
  type SessionId,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import { A2aAgentCallTransport } from "@huanlink/integration-a2a-client";
import type {
  OpenAiAgentsRunContext,
  OpenAiAgentsRunner,
} from "@huanlink/integration-openai-agents";
import type { Tool } from "@openai/agents";

import {
  buildAsyncToolTaskInputRequiredReentryInput,
  buildAsyncToolTaskReentryInput,
  buildTaskReentrySessionContext,
} from "./agent-call-reentry.js";
import {
  createPhase3MainAgentRuntime,
  type MainAgentModelBinding,
} from "./main-agent-runtime.js";
import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";
import type { CreateChannelReplyToolOptions } from "./channel-reply-tool.js";

export type Phase3ReentryResult = {
  runId: RunId;
  sessionId: SessionId;
  trigger: "agent_call_input_required" | "agent_call_terminal";
  reason: "input-required" | "terminal";
  latestContext: string;
  input: string;
  output: string;
  task: AsyncToolTaskStatus;
};

export type Phase3BeforeReentryInput = Pick<
  Phase3ReentryResult,
  "sessionId" | "trigger" | "reason" | "task"
> & { signal: AbortSignal };

export type Phase3ReentryCleanup = () => Promise<void> | void;

export type CreatePhase3HuanLinkRuntimeOptions = {
  codexA2aOrigin: string;
  codexSkillId?: string;
  /** Stable configured identity persisted only in AgentCall private references. */
  agentId?: string;
  runner?: OpenAiAgentsRunner;
  modelBinding?: MainAgentModelBinding;
  transport?: AgentCallTransport;
  createRunId?: () => RunId;
  getLatestContext?: (sessionId: SessionId) => Promise<string> | string;
  taskService: AsyncToolTaskService;
  sessionStore: ConversationSessionStore;
  beforeReentry?: (
    input: Phase3BeforeReentryInput,
  ) => Promise<Phase3ReentryCleanup | void> | Phase3ReentryCleanup | void;
  onReentry?: (result: Phase3ReentryResult) => Promise<void> | void;
  onBackgroundError?: AgentCallBackgroundErrorListener;
  logger?: RuntimeLogger;
  historyRecorder?: SessionToolHistoryRecorder;
  channelReply?: CreateChannelReplyToolOptions;
  /** Server 组合根提供的平台受控 Tool。 */
  additionalTools?: readonly Tool<OpenAiAgentsRunContext>[];
};

export type Phase3MainAgentInput = Pick<
  AgentRuntimeInput,
  "runId" | "sessionId" | "signal"
> & {
  /** Compatibility seam for isolated callers that have not injected a Context reader. */
  readonly input?: string;
};

export interface Phase3HuanLinkRuntime {
  readonly agentCalls: AgentCallService;
  runMainAgent(input: Phase3MainAgentInput): Promise<AgentRuntimeResult>;
  close(): Promise<void>;
}

export function createPhase3HuanLinkRuntime(
  options: CreatePhase3HuanLinkRuntimeOptions,
): Phase3HuanLinkRuntime {
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger(),
  );
  const transport =
    options.transport ??
    new A2aAgentCallTransport({
      origin: options.codexA2aOrigin,
      logger: logger.child({ source: "a2a.transport" }),
    });
  const agentCalls = new AgentCallService({
    transport,
    taskService: options.taskService,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    logger: logger.child({ source: "agent_call.service" }),
  });
  const mainAgent = createPhase3MainAgentRuntime({
    agentCallInvoker: agentCalls,
    taskStatusReader: options.taskService,
    agentCallContinuator: agentCalls,
    codexSkillId: options.codexSkillId,
    runner: options.runner,
    modelBinding: options.modelBinding,
    historyRecorder: options.historyRecorder,
    ...(options.channelReply === undefined
      ? {}
      : { channelReply: options.channelReply }),
    ...(options.additionalTools === undefined
      ? {}
      : { additionalTools: options.additionalTools }),
    logger: logger.child({ source: "main_agent" }),
  });
  const turns = new AgentTurnScheduler({ runtime: mainAgent });
  const activeReentries = new Map<AbortController, Promise<void>>();
  const createRunId = options.createRunId ?? randomUUID;
  const getLatestContext = options.getLatestContext ?? (() => "");
  const beforeReentry = options.beforeReentry ?? (() => undefined);
  const onReentry = options.onReentry ?? (() => undefined);
  const onBackgroundError =
    options.onBackgroundError ??
    ((error: Error) => {
      logger.error("main_agent.background.failed", {
        errorType: runtimeErrorType(error),
      });
    });

  const unsubscribeBackgroundError =
    agentCalls.onBackgroundError(onBackgroundError);
  let closed = false;
  let closeOperation: Promise<void> | undefined;
  const activeFreshTurns = new Map<
    AbortController,
    Promise<AgentRuntimeResult>
  >();

  const executeMainAgentTurn = async (
    input: AgentRuntimeInput & { readonly trigger: AgentRuntimeTrigger },
  ): Promise<AgentRuntimeResult> => {
    const fields = {
      sessionId: input.sessionId,
      runId: input.runId,
      trigger: input.trigger,
    } satisfies RuntimeLogFields;
    logger.info("main_agent.run.started", fields);
    logger.debug("main_agent.run.input", {
      ...fields,
      inputChars: input.input.length,
    });
    try {
      const result = await mainAgent.run({
        ...input,
        input: input.input ?? "",
      });
      input.signal?.throwIfAborted();
      logger.info("main_agent.run.completed", fields);
      logger.debug("main_agent.run.output", {
        ...fields,
        outputChars: result.output.length,
      });
      return result;
    } catch (error) {
      if (input.signal?.aborted === true) {
        logger.debug("main_agent.run.aborted", fields);
      } else {
        logger.error("main_agent.run.failed", {
          ...fields,
          errorType: runtimeErrorType(error),
        });
      }
      throw error;
    }
  };

  const runTaskReentry = async (
    task: AsyncToolTask,
    trigger: Phase3ReentryResult["trigger"],
    signal: AbortSignal,
  ): Promise<void> => {
    const reason =
      trigger === "agent_call_input_required" ? "input-required" : "terminal";
    const baseFields = taskLogFields(task, trigger);
    logger.info("main_agent.reentry.started", baseFields);
    let runId: RunId | undefined;
    let skipped = false;
    try {
      await turns.runOperation({
        sessionId: task.sessionId,
        signal,
        operation: async () => {
          const status = options.taskService.getStatus(
            task.sessionId,
            task.taskId,
          );
          if (status.status !== "found") {
            throw new Error(
              `Async Tool Task ${task.taskId} was not found in this Session`,
            );
          }
          const triggerMatchesCurrentState =
            trigger === "agent_call_input_required"
              ? status.state === "input-required"
              : isAsyncToolTaskTerminalState(status.state);
          if (!triggerMatchesCurrentState) {
            skipped = true;
            logger.info("main_agent.reentry.skipped", {
              ...baseFields,
              currentState: status.state,
              skipReason: "stale_trigger",
            });
            return;
          }
          const cleanup = await Promise.resolve().then(() =>
            beforeReentry({
              sessionId: task.sessionId,
              trigger,
              reason,
              task: status,
              signal,
            }),
          );
          try {
            signal.throwIfAborted();
            const sourceToolCall = options.sessionStore.getAgentToolCall(
              task.sessionId,
              task.sourceRunId,
              task.sourceToolCallId,
            );
            if (sourceToolCall === undefined) {
              throw new Error(
                `Async Tool Task ${task.taskId} source Tool Call was not found`,
              );
            }
            const window = options.sessionStore.getSessionContextWindow(
              task.sessionId,
            );
            if (window === undefined) {
              throw new Error(
                `Conversation Session ${task.sessionId} does not exist`,
              );
            }
            const latestContext = buildTaskReentrySessionContext(
              window,
              sourceToolCall,
            );
            const currentRunId = createRunId();
            runId = currentRunId;
            const input =
              trigger === "agent_call_input_required"
                ? buildAsyncToolTaskInputRequiredReentryInput(
                    status,
                    latestContext,
                  )
                : buildAsyncToolTaskReentryInput(status, latestContext);
            const reentryFields = { ...baseFields, runId: currentRunId };
            logger.info("main_agent.reentry.context_ready", reentryFields);
            logger.debug("main_agent.reentry.payload", {
              ...reentryFields,
              latestContextChars: latestContext.length,
              inputChars: input.length,
            });
            const result = await executeMainAgentTurn({
              runId: currentRunId,
              sessionId: task.sessionId,
              trigger,
              input,
              signal,
            });
            await Promise.resolve().then(() =>
              onReentry({
                runId: currentRunId,
                sessionId: task.sessionId,
                trigger,
                reason,
                latestContext,
                input,
                output: result.output,
                task: status,
              }),
            );
          } finally {
            if (cleanup !== undefined) {
              await cleanup();
            }
          }
        },
      });
      if (!skipped) {
        logger.info("main_agent.reentry.completed", {
          ...baseFields,
          ...(runId === undefined ? {} : { runId }),
        });
      }
    } catch (error) {
      const failureFields = {
        ...baseFields,
        ...(runId === undefined ? {} : { runId }),
      };
      if (signal.aborted) {
        logger.debug("main_agent.reentry.aborted", failureFields);
      } else {
        logger.error("main_agent.reentry.failed", {
          ...failureFields,
          errorType: runtimeErrorType(error),
        });
      }
      throw error;
    }
  };

  const superviseTaskReentry = (
    task: AsyncToolTask,
    trigger: Phase3ReentryResult["trigger"],
  ): void => {
    if (closed) {
      return;
    }
    const controller = new AbortController();
    const operation = runTaskReentry(task, trigger, controller.signal)
      .catch((error) => {
        if (closed && controller.signal.aborted) {
          return;
        }
        onBackgroundError(normalizeRuntimeError(error), undefined);
      })
      .finally(() => activeReentries.delete(controller));
    activeReentries.set(controller, operation);
  };

  const runFreshMainAgent = (
    input: Phase3MainAgentInput,
  ): Promise<AgentRuntimeResult> => {
    if (closed) {
      return Promise.reject(new Error("Phase 3 runtime is closed"));
    }
    const controller = new AbortController();
    const unlinkCallerSignal = linkAbortSignal(input.signal, controller);
    const operation = turns
      .runOperation({
        sessionId: input.sessionId,
        signal: controller.signal,
        operation: async () => {
          const projectedInput =
            options.getLatestContext === undefined
              ? input.input
              : await Promise.resolve().then(() =>
                  getLatestContext(input.sessionId),
                );
          controller.signal.throwIfAborted();
          if (projectedInput === undefined) {
            throw new Error(
              "Phase 3 requires a Session context reader for fresh turns",
            );
          }
          return await executeMainAgentTurn({
            ...input,
            trigger: "user",
            input: projectedInput,
            signal: controller.signal,
          });
        },
      })
      .finally(() => {
        unlinkCallerSignal();
        activeFreshTurns.delete(controller);
      });
    activeFreshTurns.set(controller, operation);
    return operation;
  };

  const unsubscribeTaskInputRequired = options.taskService.onInputRequired(
    (task) => superviseTaskReentry(task, "agent_call_input_required"),
  );
  const unsubscribeTaskTerminal = options.taskService.onTerminal((task) =>
    superviseTaskReentry(task, "agent_call_terminal"),
  );

  const performClose = async (): Promise<void> => {
    closed = true;
    unsubscribeTaskInputRequired();
    unsubscribeTaskTerminal();
    const closeReason = new Error("Phase 3 runtime closed");
    for (const controller of activeFreshTurns.keys()) {
      controller.abort(closeReason);
    }
    for (const controller of activeReentries.keys()) {
      controller.abort(closeReason);
    }
    const freshTurnDrain = Promise.allSettled([...activeFreshTurns.values()]);
    const reentryDrain = Promise.allSettled([...activeReentries.values()]);
    try {
      await agentCalls.close();
      await Promise.all([freshTurnDrain, reentryDrain]);
    } finally {
      unsubscribeBackgroundError();
    }
  };

  return {
    agentCalls,
    runMainAgent: runFreshMainAgent,
    close() {
      closeOperation ??= performClose();
      return closeOperation;
    },
  };
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) {
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function taskLogFields(
  task: AsyncToolTask,
  trigger: Phase3ReentryResult["trigger"],
): RuntimeLogFields {
  return {
    sessionId: task.sessionId,
    taskId: task.taskId,
    taskKind: task.kind,
    trigger,
  };
}

function runtimeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function normalizeRuntimeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
