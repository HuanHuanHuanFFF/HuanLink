// 验证内存 EventLog 的 append/readByRun 行为。

import { describe, expect, test } from "vitest";

import {
  CORE_SCHEMA_VERSION,
  InMemoryEventLog
} from "../src/index.js";
import type { AgentEvent, RunId, SessionId } from "../src/index.js";

describe("InMemoryEventLog", () => {
  // 覆盖 Step 2 要求的 runId 过滤和顺序稳定。
  test("reads events for one run in append order", () => {
    const eventLog = new InMemoryEventLog();
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";

    const first = createEvent({
      runId: runA,
      sessionId,
      type: "run.created"
    });
    const otherRun = createEvent({
      runId: runB,
      sessionId,
      type: "run.created"
    });
    const second = createEvent({
      runId: runA,
      sessionId,
      type: "run.completed"
    });

    eventLog.append(first);
    eventLog.append(otherRun);
    eventLog.append(second);

    expect(eventLog.readByRun(runA)).toEqual([first, second]);
    expect(eventLog.readByRun(runB)).toEqual([otherRun]);
  });

  // 未写入的 run 应返回空数组，方便调用方直接遍历。
  test("returns an empty array for unknown run", () => {
    const eventLog = new InMemoryEventLog();

    expect(eventLog.readByRun("missing_run")).toEqual([]);
  });
});

function createEvent(input: {
  runId: RunId;
  sessionId: SessionId;
  type: string;
}): AgentEvent {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    type: input.type,
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: "2026-06-16T00:00:00.000Z"
  };
}
