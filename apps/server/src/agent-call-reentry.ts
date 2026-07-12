import type { AgentCallRecord } from "@huanlink/core";

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
    "Respond with a concise result for the user. Do not submit another AgentCall."
  ].join("\n");
}
