// 控制台 demo：跑一次 fake agent loop，并打印结果和事件链。

import {
  AgentLoop,
  AllowPolicyEngine,
  FakeModelClient,
  InMemoryEventLog,
  ToolGateway,
  echoTool
} from "../index.js";

async function main(): Promise<void> {
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
  const input = {
    runId: "run_demo_01",
    sessionId: "session_demo_01",
    userMessage: "Echo the fake input"
  };

  console.log("== fake agent loop demo ==");
  console.log(`input: ${input.userMessage}`);

  const result = await loop.run(input);
  const events = eventLog.readByRun(input.runId);

  console.log(`finalAnswer: ${result.finalAnswer}`);
  console.log("toolResults:");
  for (const toolResult of result.toolResults) {
    console.log(`- ${toolResult.callId}: ${toolResult.output}`);
  }

  console.log("events:");
  for (const [index, event] of events.entries()) {
    const eventData = JSON.stringify(event.data ?? {});
    const eventIndex = String(index + 1).padStart(2, "0");
    console.log(`${eventIndex}. ${event.type} ${eventData}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
