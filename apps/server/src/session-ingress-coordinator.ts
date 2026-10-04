import { randomUUID } from "node:crypto";

import type {
  ConversationSessionStore,
  RunId,
  SessionId,
} from "@huanlink/core";

import type { ChannelRuntimeMessage } from "./channel-runtime.js";

/** The replaceable fresh-turn boundary used by Channel ingress. */
export type SessionIngressMainAgentInput = {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly signal: AbortSignal;
};

/** The runtime owns execution, error reporting, cancellation, and drain. */
export interface SessionIngressMainAgentRunner {
  enqueueMainAgent(input: SessionIngressMainAgentInput): void;
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
 * Registers a turn without blocking subsequent facts behind its execution.
 * Session scheduling and latest-context projection belong to the runtime.
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

      options.runner.enqueueMainAgent({
        runId: createRunId(),
        sessionId,
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
