// 控制台 demo：跑一次 fake agent loop，并打印结果和事件链。
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AgentLoop,
  AllowPolicyEngine,
  FakeModelClient,
  JsonlEventLog,
  ToolGateway,
  echoTool
} from "../index.js";
import type { AgentEvent, AgentRunResult } from "../index.js";
import { getEventFilePath } from "../events/event-file-paths.js";

type DemoInput = {
  eventLogBaseDir?: string;
  log?: (line: string) => void;
};

type DemoResult = {
  eventLogBaseDir: string;
  result: AgentRunResult;
  events: AgentEvent[];
};

// 跑一次 fake agent loop，并把事件写入当前工作目录的 .huanlink。
export async function runMockAgentDemo(
  input: DemoInput = {}
): Promise<DemoResult> {
  const log = input.log ?? console.log;
  const eventLogBaseDir = resolveEventLogBaseDir(input.eventLogBaseDir);
  const eventLog = new JsonlEventLog({ baseDir: eventLogBaseDir });
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
  const runSuffix = createDemoRunSuffix();
  const runInput = {
    runId: `run_demo_${runSuffix}`,
    sessionId: `session_demo_${runSuffix}`,
    userMessage: "Echo the fake input"
  };

  log("== fake agent loop demo ==");
  log(`input: ${runInput.userMessage}`);

  const result = await loop.run(runInput);
  const events = await eventLog.readRunEvents(runInput.runId);

  log(`finalAnswer: ${result.finalAnswer}`);
  log("toolResults:");
  for (const toolResult of result.toolResults) {
    log(`- ${toolResult.callId}: ${toolResult.output}`);
  }

  log("events:");
  for (const [index, event] of events.entries()) {
    const eventData = JSON.stringify(event.data ?? {});
    const eventIndex = String(index + 1).padStart(2, "0");
    log(`${eventIndex}. ${event.type} ${eventData}`);
  }

  log(`eventLog: ${getEventFilePath(eventLogBaseDir, runInput.runId)}`);

  return {
    eventLogBaseDir,
    result,
    events
  };
}

// 只有直接作为命令行 demo 执行时才启动，避免测试 import 时产生副作用。
if (isDirectRun()) {
  runMockAgentDemo().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function isDirectRun(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

function resolveEventLogBaseDir(inputBaseDir?: string): string {
  if (inputBaseDir !== undefined) {
    return path.resolve(inputBaseDir);
  }

  return path.resolve(process.env.INIT_CWD ?? process.cwd(), ".huanlink");
}

function createDemoRunSuffix(): string {
  return randomUUID();
}
