import { describe, expect, test } from "vitest";

import {
  AllowPolicyEngine,
  InMemoryEventLog,
  ToolGateway,
  echoTool
} from "../src/index.js";
import type {
  AgentEvent,
  AgentEventDraft,
  Tool,
  ToolCall
} from "../src/index.js";

class ThrowOnEventTypeLog extends InMemoryEventLog {
  constructor(
    private readonly failingType: string,
    private readonly failure: Error
  ) {
    super();
  }

  override append(event: AgentEventDraft): AgentEvent {
    if (event.type === this.failingType) {
      throw this.failure;
    }

    return super.append(event);
  }
}

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
    const events = eventLog.readRunEvents("run_direct_gateway_01");

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

  test("surfaces both the tool error and the tool.failed write error instead of masking the root cause", async () => {
    const toolError = new Error("boom");
    const writeError = new Error("event log offline");
    const eventLog = new ThrowOnEventTypeLog("tool.failed", writeError);
    const throwingTool: Tool = {
      name: "explode",
      execute() {
        throw toolError;
      }
    };
    const toolGateway = new ToolGateway({
      eventWriter: eventLog,
      policyEngine: new AllowPolicyEngine(),
      tools: [throwingTool]
    });
    const toolCall: ToolCall = {
      id: "call_explode_write_error_01",
      name: "explode",
      args: {}
    };

    const error = await toolGateway
      .execute({
        runId: "run_explode_write_error_01",
        sessionId: "session_explode_write_error_01",
        step: 0,
        toolCall
      })
      .then(
        () => {
          throw new Error("execute should have rejected");
        },
        (rejection: unknown) => rejection
      );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([toolError, writeError]);
  });
});
