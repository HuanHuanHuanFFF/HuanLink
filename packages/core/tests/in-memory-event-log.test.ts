import { describe, expect, test } from "vitest";

import { CORE_SCHEMA_VERSION, InMemoryEventLog } from "../src/index.js";
import type { RunId, SessionId } from "../src/index.js";

describe("InMemoryEventLog", () => {
  test("completes outer event drafts and reads one run in append order", () => {
    const eventLog = new InMemoryEventLog();
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";

    const first = eventLog.append({
      type: "channel.message.received",
      runId: runA,
      sessionId,
      data: {
        channel: "onebot11",
        conversationId: "group_01",
        messageId: "message_01",
        senderId: "user_01",
        senderName: "User One",
        text: "@bot start",
        trigger: { kind: "mention", text: "@bot" }
      }
    });
    const otherRun = eventLog.append({
      type: "main_agent.run.started",
      runId: runB,
      sessionId,
      data: { trigger: "user" }
    });
    const second = eventLog.append({
      type: "main_agent.run.completed",
      runId: runA,
      sessionId,
      data: { output: "done" }
    });

    expect(eventLog.readRunEvents(runA)).toEqual([first, second]);
    expect(eventLog.readRunEvents(runB)).toEqual([otherRun]);
    expect(first).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      seq: 1,
      type: "channel.message.received",
      runId: runA,
      sessionId,
      data: { text: "@bot start" }
    });
    expect(Object.keys(first).sort()).toEqual([
      "data",
      "id",
      "runId",
      "schemaVersion",
      "seq",
      "sessionId",
      "timestamp",
      "type"
    ]);
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
      type: "main_agent.run.started",
      runId,
      sessionId,
      data: { trigger: "user" }
    });
    eventLog.append({
      type: "agent_call.created",
      runId,
      sessionId,
      data: {
        agentCallId: "agent_call_seq",
        taskId: "task_seq",
        skillId: "coding",
        executionMode: "async",
        state: "submitted"
      }
    });
    eventLog.append({
      type: "main_agent.run.completed",
      runId,
      sessionId,
      data: { output: "done" }
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
