// 验证 Milestone 2 的 mock agent run 可以完整跑通。

import { describe, expect, test } from "vitest";

import {
  AgentLoop,
  AllowPolicyEngine,
  FakeModelClient,
  InMemoryEventLog,
  ToolGateway,
  echoTool
} from "../src/index.js";

describe("mock agent run", () => {
  // 覆盖 fake model、policy、tool gateway、event writer 的 happy path。
  test("runs a fake model through policy, echo tool, events, and final answer", async () => {
    const eventLog = new InMemoryEventLog();
    const toolGateway = new ToolGateway({
      eventWriter: eventLog,
      policyEngine: new AllowPolicyEngine(),
      tools: [echoTool]
    });
    const loop = new AgentLoop({
      eventWriter: eventLog,
      modelClient: new FakeModelClient(),
      toolGateway
    });

    const result = await loop.run({
      runId: "run_mock_01",
      sessionId: "session_mock_01",
      userMessage: "Echo the fake input"
    });

    const runEvents = eventLog.readByRun("run_mock_01");

    expect(result.finalAnswer).toBe("Final answer: hello from fake model");
    expect(result.toolResults).toEqual([
      {
        callId: "call_echo_01",
        output: "hello from fake model"
      }
    ]);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.created",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
  });
});
