import type {
  AgentCallArtifact,
  AgentCallInputQuestion,
  AgentCallRecord
} from "@huanlink/core";

export type AgentCallPausedPayload = {
  taskId: string;
  a2aTaskId: string;
  contextId?: string;
  state: "input-required";
  statusMessage?: string;
  questions: AgentCallInputQuestion[];
  artifacts: AgentCallArtifact[];
  latestContext: string;
};

export function buildAgentCallReentryInput(
  agentCall: AgentCallRecord,
  latestContext: string
): string {
  const artifacts = agentCall.artifacts
    .map((artifact) => {
      const label = artifact.name ?? artifact.id;
      return `- ${label}: ${artifact.text ?? "(no text payload)"}`;
    })
    .join("\n");

  return [
    "A previously accepted remote AgentCall reached a terminal state.",
    `AgentCall ID: ${agentCall.agentCallId}`,
    `A2A task ID: ${agentCall.taskId}`,
    `State: ${agentCall.state}`,
    agentCall.statusMessage
      ? `Status message: ${agentCall.statusMessage}`
      : "Status message: (none)",
    "Artifacts:",
    artifacts || "- (none)",
    "Latest conversation context at completion:",
    latestContext || "(none)",
    "Respond with a concise result for the user.",
    "If the latest conversation context contains an explicit, unambiguous follow-up that the user already authorized and no confirmation is required, submit that next task as a new async AgentCall in this same session.",
    "Never repeat the completed task or invent a follow-up; a task already accepted or completed in the supplied result or context is not pending and must not be submitted again.",
    "Include the completed result and any newly accepted task ID in the response. If an authorized follow-up needs a material choice, ask the user instead."
  ].join("\n");
}

export function buildAgentCallPausedPayload(
  agentCall: AgentCallRecord,
  latestContext: string
): AgentCallPausedPayload {
  if (agentCall.state !== "input-required") {
    throw new Error(
      `AgentCall ${agentCall.agentCallId} must be input-required before paused re-entry`
    );
  }

  return {
    taskId: agentCall.agentCallId,
    a2aTaskId: agentCall.taskId,
    ...(agentCall.contextId === undefined
      ? {}
      : { contextId: agentCall.contextId }),
    state: agentCall.state,
    ...(agentCall.statusMessage === undefined
      ? {}
      : { statusMessage: agentCall.statusMessage }),
    questions: cloneQuestions(agentCall.questions ?? []),
    artifacts: agentCall.artifacts.map((artifact) => ({ ...artifact })),
    latestContext
  };
}

export function buildAgentCallPausedReentryInput(
  paused: AgentCallPausedPayload
): string {
  return [
    "A previously accepted remote AgentCall requires user input before it can continue.",
    "Paused task payload:",
    JSON.stringify(paused, null, 2),
    "Use get_task_status if the current state needs confirmation.",
    "If the available conversation context already supplies complete answers to every pending question, call continue_task for this same task.",
    "If a material choice is missing or ambiguous, ask the QQ user a concise question and wait for their answer.",
    "Never submit a replacement AgentCall for this paused task."
  ].join("\n");
}

function cloneQuestions(
  questions: AgentCallInputQuestion[]
): AgentCallInputQuestion[] {
  return questions.map((question) => ({
    ...question,
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({ ...option }))
  }));
}
