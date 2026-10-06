import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  type AgentCard as AgentCardValue,
} from "@a2a-js/sdk";

export function createAgentCard(
  origin: string,
  experimentalDelegation = false,
): AgentCardValue {
  return AgentCard.fromJSON({
    name: "HuanLink Codex A2A Adapter",
    description:
      "Runs HuanLink code tasks through the official codex app-server, treating the configured workspace folder as the working focus rather than a hard modification boundary.",
    version: "0.2.0",
    supportedInterfaces: [
      {
        url: `${origin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      ...(experimentalDelegation
        ? {
            extensions: [
              {
                uri: "urn:huanlink:delegation:v1",
                description:
                  "Task-scoped context packets, monotonic context receipt and one-shot permission control via Message Data Parts",
                required: false,
              },
            ],
          }
        : {}),
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "codex-code-task",
        name: "Codex code task",
        description:
          "Runs a coding turn in a registered project. Requires task text plus a huanlink.codex-task.v1 data part with projectId; modelId and reasoningEffort are optional overrides.",
        tags: ["a2a", "codex", "coding"],
        examples: ["Add a focused validation rule and run its tests"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain"],
      },
    ],
  });
}
