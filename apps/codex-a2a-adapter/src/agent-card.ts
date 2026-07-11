import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  type AgentCard as AgentCardValue
} from "@a2a-js/sdk";

export function createAgentCard(origin: string): AgentCardValue {
  return AgentCard.fromJSON({
    name: "HuanLink Codex A2A Adapter",
    description:
      "Phase 1 standards-validation adapter with a fixed task executor.",
    version: "0.1.0",
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
        id: "phase-1-fixed-response",
        name: "Phase 1 fixed response",
        description:
          "Exercises the A2A v1.0 task lifecycle without invoking Codex.",
        tags: ["a2a", "phase-1", "protocol-validation"],
        examples: ["Run the Phase 1 protocol check"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"]
      }
    ]
  });
}
