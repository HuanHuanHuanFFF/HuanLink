import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  type AgentCard as AgentCardValue
} from "@a2a-js/sdk";

export function createAgentCard(origin: string): AgentCardValue {
  return AgentCard.fromJSON({
    name: "HuanLink Codex A2A Adapter",
    description:
      "Runs scoped HuanLink code tasks through the official codex app-server.",
    version: "0.2.0",
    supportedInterfaces: [
      {
        url: `${origin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION
      }
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "codex-code-task",
        name: "Codex code task",
        description:
          "Runs a real coding turn in the configured HuanLink workspace.",
        tags: ["a2a", "codex", "coding"],
        examples: ["Add a focused validation rule and run its tests"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"]
      }
    ]
  });
}
