import { describe, expect, test } from "vitest";

import { CORE_SCHEMA_VERSION, InMemoryEventLog } from "../src/index.js";
import type { RunId, SessionId } from "../src/index.js";

describe("InMemoryEventLog", () => {
  test("completes event drafts and reads events for one run in append order", () => {
    const eventLog = new InMemoryEventLog();
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";

    const first = eventLog.append({
      type: "run.created",
      runId: runA,
      sessionId,
      source: "agent_loop",
      data: { userMessage: "first" }
    });
    const otherRun = eventLog.append({
      type: "run.created",
      runId: runB,
      sessionId,
      source: "agent_loop",
      data: { userMessage: "other" }
    });
    const second = eventLog.append({
      type: "run.completed",
      runId: runA,
      sessionId,
      source: "agent_loop",
      data: { finalAnswer: "done" }
    });

    expect(eventLog.readRunEvents(runA)).toEqual([first, second]);
    expect(eventLog.readRunEvents(runB)).toEqual([otherRun]);
    expect(first).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      seq: 1,
      type: "run.created",
      runId: runA,
      sessionId,
      source: "agent_loop",
      data: { userMessage: "first" }
    });
    expect(second.seq).toBe(2);
    expect(otherRun.seq).toBe(1);
    expect(first.id).toEqual(expect.any(String));
    expect(first.timestamp).toEqual(expect.any(String));
  });

  test("assigns contiguous seq values per run", () => {
    const eventLog = new InMemoryEventLog();
    const runId: RunId = "run_seq";
    const sessionId: SessionId = "session_seq";

    eventLog.append({
      type: "run.created",
      runId,
      sessionId,
      source: "agent_loop",
      data: { userMessage: "start" }
    });
    eventLog.append({
      type: "model.requested",
      runId,
      sessionId,
      source: "agent_loop",
      data: { step: 0 }
    });
    eventLog.append({
      type: "run.completed",
      runId,
      sessionId,
      source: "agent_loop",
      data: { finalAnswer: "done" }
    });

    expect(eventLog.readRunEvents(runId).map((event) => event.seq)).toEqual([
      1,
      2,
      3
    ]);
  });

  test("returns an empty array for unknown run", () => {
    const eventLog = new InMemoryEventLog();

    expect(eventLog.readRunEvents("missing_run")).toEqual([]);
  });
});
