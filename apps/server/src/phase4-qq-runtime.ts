import { randomUUID } from "node:crypto";

import {
  InMemoryConversationStore,
  type AgentCallBackgroundErrorListener,
  type AgentCallRecord,
  type AgentCallService,
  type AgentCallTransport,
  type ChannelAdapter,
  type InboundChannelMessage,
  type RunId,
  type SessionId
} from "@huanlink/core";
import type { OpenAiAgentsRunner } from "@huanlink/integration-openai-agents";

import {
  createPhase3HuanLinkRuntime,
  type Phase3HuanLinkRuntime
} from "./phase3-runtime.js";
import type { MainAgentModelBinding } from "./main-agent-runtime.js";

export type CreatePhase4QqRuntimeOptions = {
  channel: ChannelAdapter;
  targetConversationId: string;
  codexA2aOrigin: string;
  codexSkillId?: string;
  runner?: OpenAiAgentsRunner;
  modelBinding?: MainAgentModelBinding;
  transport?: AgentCallTransport;
  createRunId?: () => RunId;
  store?: InMemoryConversationStore;
  onBackgroundError?: AgentCallBackgroundErrorListener;
};

export interface Phase4QqRuntime {
  readonly agentCalls: AgentCallService;
  readonly conversations: InMemoryConversationStore;
  start(): Promise<void>;
  close(): Promise<void>;
}

type ReceiptGate = {
  promise: Promise<void>;
  resolve: () => void;
};

export function createPhase4QqRuntime(
  options: CreatePhase4QqRuntimeOptions
): Phase4QqRuntime {
  const targetConversationId = options.targetConversationId.trim();
  if (targetConversationId.length === 0) {
    throw new Error("targetConversationId must be non-empty");
  }

  const conversations = options.store ?? new InMemoryConversationStore();
  const createRunId = options.createRunId ?? randomUUID;
  const receiptGates = new Map<RunId, ReceiptGate>();
  const activeOperations = new Set<Promise<void>>();
  const activeControllers = new Set<AbortController>();
  const reportBackgroundError = createBackgroundErrorReporter(
    options.onBackgroundError
  );

  const phase3 = createPhase3HuanLinkRuntime({
    codexA2aOrigin: options.codexA2aOrigin,
    ...(options.codexSkillId === undefined
      ? {}
      : { codexSkillId: options.codexSkillId }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.modelBinding === undefined
      ? {}
      : { modelBinding: options.modelBinding }),
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    createRunId,
    getLatestContext: (sessionId) =>
      conversations.formatLatestContext(sessionId),
    onReentry: async (result) => {
      const gate = receiptGates.get(result.agentCall.runId);
      if (gate !== undefined) {
        await gate.promise;
      }
      const route = conversations.getRoute(result.sessionId);
      if (route === undefined) {
        throw new Error(`No channel route for session ${result.sessionId}`);
      }
      if (route.channel !== options.channel.channel) {
        throw new Error(
          `Session ${result.sessionId} is routed to ${route.channel}, not ${options.channel.channel}`
        );
      }
      await options.channel.sendText(route.conversationId, result.output);
    },
    onBackgroundError: reportBackgroundError
  });

  let unsubscribe: (() => void) | undefined;
  let started = false;
  let closed = false;
  let startOperation: Promise<void> | undefined;
  let closeOperation: Promise<void> | undefined;

  const receive = (message: InboundChannelMessage): void => {
    if (closed || message.conversationId !== targetConversationId) {
      return;
    }

    try {
      const sessionId = sessionIdFor(message);
      const priorContext = conversations.formatLatestContext(sessionId);
      conversations.append(sessionId, message);
      if (message.trigger !== undefined) {
        superviseTrigger(message, sessionId, priorContext);
      }
    } catch (error) {
      reportBackgroundError(normalizeError(error), undefined);
    }
  };

  const superviseTrigger = (
    message: InboundChannelMessage,
    sessionId: SessionId,
    priorContext: string
  ): void => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const operation = handleTrigger(
      message,
      sessionId,
      priorContext,
      controller.signal
    );
    activeOperations.add(operation);
    void operation.then(
      () => finishOperation(operation, controller),
      (error) => {
        finishOperation(operation, controller);
        if (!(closed && controller.signal.aborted)) {
          reportBackgroundError(normalizeError(error), undefined);
        }
      }
    );
  };

  const handleTrigger = async (
    message: InboundChannelMessage,
    sessionId: SessionId,
    priorContext: string,
    signal: AbortSignal
  ): Promise<void> => {
    const runId = createRunId();
    const gate = createReceiptGate();
    receiptGates.set(runId, gate);
    try {
      const result = await phase3.runMainAgent({
        runId,
        sessionId,
        input: buildInitialInput(message, priorContext),
        signal
      });
      const agentCalls = phase3.agentCalls.listByRunId(runId);
      const reply = appendTaskIds(result.output, agentCalls);
      await options.channel.sendText(message.conversationId, reply);
    } finally {
      gate.resolve();
      if (receiptGates.get(runId) === gate) {
        receiptGates.delete(runId);
      }
    }
  };

  const finishOperation = (
    operation: Promise<void>,
    controller: AbortController
  ): void => {
    activeOperations.delete(operation);
    activeControllers.delete(controller);
  };

  const performStart = async (): Promise<void> => {
    if (closed) {
      throw new Error("Phase 4 QQ runtime is closed");
    }
    if (started) {
      return;
    }

    unsubscribe = options.channel.onMessage(receive);
    try {
      await options.channel.start();
      if (closed) {
        await options.channel.close();
        throw new Error("Phase 4 QQ runtime closed while starting");
      }
      started = true;
    } catch (error) {
      unsubscribe?.();
      unsubscribe = undefined;
      throw error;
    }
  };

  const performClose = async (): Promise<void> => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const controller of activeControllers) {
      controller.abort(new Error("Phase 4 QQ runtime closed"));
    }

    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => options.channel.close()),
      Promise.resolve().then(() => phase3.close()),
      Promise.allSettled([...activeOperations])
    ]);
    started = false;

    const failures = cleanup
      .slice(0, 2)
      .flatMap((result) =>
        result?.status === "rejected" ? [normalizeError(result.reason)] : []
      );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Phase 4 QQ runtime close failed");
    }
  };

  return {
    agentCalls: phase3.agentCalls,
    conversations,
    start() {
      if (closed) {
        return Promise.reject(new Error("Phase 4 QQ runtime is closed"));
      }
      if (startOperation !== undefined) {
        return startOperation;
      }
      const operation = performStart();
      startOperation = operation;
      void operation.then(
        () => {
          if (startOperation === operation) {
            startOperation = undefined;
          }
        },
        () => {
          if (startOperation === operation) {
            startOperation = undefined;
          }
        }
      );
      return operation;
    },
    close() {
      if (closeOperation !== undefined) {
        return closeOperation;
      }
      closeOperation = performClose();
      return closeOperation;
    }
  };
}

function sessionIdFor(message: InboundChannelMessage): SessionId {
  return `${message.channel}:group:${message.conversationId}`;
}

function buildInitialInput(
  message: InboundChannelMessage,
  priorContext: string
): string {
  const request = message.trigger?.text ?? message.text;
  if (priorContext.length === 0) {
    return request;
  }
  return [
    "Latest group context:",
    priorContext,
    "",
    "Current explicit request:",
    request
  ].join("\n");
}

function appendTaskIds(output: string, agentCalls: AgentCallRecord[]): string {
  if (agentCalls.length === 0) {
    return output;
  }

  const taskIds = agentCalls.flatMap((agentCall) => [
    `HuanLink taskId: ${agentCall.agentCallId}`,
    `A2A taskId: ${agentCall.taskId}`
  ]);
  return `${output}\n\n${taskIds.join("\n")}`;
}

function createReceiptGate(): ReceiptGate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createBackgroundErrorReporter(
  observer: AgentCallBackgroundErrorListener | undefined
): AgentCallBackgroundErrorListener {
  const listener =
    observer ??
    ((error: Error, record: AgentCallRecord | undefined) => {
      console.error(
        `Phase 4 QQ background failure${
          record === undefined
            ? ""
            : ` for ${record.agentCallId}/${record.taskId}`
        }`,
        error
      );
    });

  return (error, record) => {
    try {
      void Promise.resolve(listener(error, record)).catch(() => undefined);
    } catch {
      // Error observers must not create another unhandled background failure.
    }
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
