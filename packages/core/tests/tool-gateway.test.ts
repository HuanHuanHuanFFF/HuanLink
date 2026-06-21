import { describe, expect, test } from "vitest";

import {
  AllowPolicyEngine,
  InMemoryEventLog,
  ToolGateway,
  echoTool
} from "../src/index.js";
import type { ToolCall } from "../src/index.js";

describe("ToolGateway", () => {
  test("requires step and records tool events with replay correlation fields", async () => {
    const eventLog = new InMemoryEventLog();
    const toolGateway = new ToolGateway({
      eventWriter: eventLog,
      policyEngine: new AllowPolicyEngine(),
      tools: [echoTool]
    });
    const toolCall: ToolCall = {
      id: "call_direct_gateway_01",
      name: "echo",
      args: { text: "direct gateway" }
    };

    const execution = await toolGateway.execute({
      runId: "run_direct_gateway_01",
      sessionId: "session_direct_gateway_01",
      step: 3,
      toolCall
    });
    const events = eventLog.readByRun("run_direct_gateway_01");

    expect(execution.result).toEqual({
      callId: "call_direct_gateway_01",
      toolName: "echo",
      output: "direct gateway"
    });
    expect(execution.terminalEvent.id).toBe(events[2]?.id);
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "policy.decided",
      "tool.completed"
    ]);
    expect(events.map((event) => event.step)).toEqual([3, 3, 3]);
    expect(events.map((event) => event.toolCallId)).toEqual([
      "call_direct_gateway_01",
      "call_direct_gateway_01",
      "call_direct_gateway_01"
    ]);
  });
});
