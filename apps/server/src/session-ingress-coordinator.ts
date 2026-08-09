import { randomUUID } from "node:crypto";

import type {
  AgentRuntimeResult,
  ConversationSessionStore,
  RunId,
  SessionId,
} from "@huanlink/core";

import type { ChannelRuntimeMessage } from "./channel-runtime.js";

/** The replaceable fresh-turn boundary used by Channel ingress. */
export type SessionIngressMainAgentInput = {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly input: string;
  readonly signal: AbortSignal;
};

/** Structurally compatible with Phase3HuanLinkRuntime's `runMainAgent`. */
export interface SessionIngressMainAgentRunner {
  runMainAgent(
    input: SessionIngressMainAgentInput,
  ): Promise<AgentRuntimeResult>;
}

export type CreateSessionIngressCoordinatorOptions = {
  readonly sessionStore: ConversationSessionStore;
  readonly runner: SessionIngressMainAgentRunner;
  readonly createRunId?: () => RunId;
};

export interface SessionIngressCoordinator {
  handle(input: ChannelRuntimeMessage): Promise<void>;
}

/**
 * Persists Channel facts before applying the temporary fresh-turn policy.
 * Queueing, gating, and Session-context projection remain downstream work.
 */
export function createSessionIngressCoordinator(
  options: CreateSessionIngressCoordinatorOptions,
): SessionIngressCoordinator {
  const createRunId = options.createRunId ?? randomUUID;

  return {
    async handle({ sessionId, message, signal }): Promise<void> {
      const appended = options.sessionStore.appendChannelMessage(
        sessionId,
        message,
      );
      if (
        appended !== "appended" ||
        message.sender.isSelf ||
        !isCurrentTrigger(message.trigger?.kind) ||
        signal.aborted
      ) {
        return;
      }

      await options.runner.runMainAgent({
        runId: createRunId(),
        sessionId,
        input: message.content,
        signal,
      });
    },
  };
}

function isCurrentTrigger(
  trigger: "mention" | "command" | undefined,
): trigger is "mention" | "command" {
  return trigger === "mention" || trigger === "command";
}
