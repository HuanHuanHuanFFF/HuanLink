// 验证 replay 只折叠 HuanLink 外层编排事件。
import { describe, expect, test } from "vitest";

import {
  EventLogRunViewReader,
  InMemoryEventLog,
  createRunView
} from "../src/index.js";
import type { AgentEvent, AgentEventDraft } from "../src/index.js";

function appendEvents(
  eventLog: InMemoryEventLog,
  events: AgentEventDraft[]
): void {
  for (const event of events) {
    eventLog.append(event);
  }
}

describe("replay reducer", () => {
  test("restores a completed run with aggregated AgentCall and sent reply", () => {
    const eventLog = new InMemoryEventLog();
    appendEvents(eventLog, [
      channelMessage("run_success", "session_success"),
      {
        type: "main_agent.run.started",
        runId: "run_success",
        sessionId: "session_success",
        data: { trigger: "user" }
      },
      {
        type: "agent_call.created",
        runId: "run_success",
        sessionId: "session_success",
        data: {
          agentCallId: "agent_call_01",
          taskId: "task_01",
          skillId: "coding",
          executionMode: "async",
          state: "submitted"
        }
      },
      {
        type: "agent_call.state.changed",
        runId: "run_success",
        sessionId: "session_success",
        data: {
          agentCallId: "agent_call_01",
          taskId: "task_01",
          state: "working"
        }
      },
      {
        type: "agent_call.state.changed",
        runId: "run_success",
        sessionId: "session_success",
        data: {
          agentCallId: "agent_call_01",
          taskId: "task_01",
          state: "completed"
        }
      },
      {
        type: "main_agent.run.completed",
        runId: "run_success",
        sessionId: "session_success",
        data: { output: "MainAgent finished" }
      },
      {
        type: "channel.reply.sent",
        runId: "run_success",
        sessionId: "session_success",
        data: {
          conversationId: "group_01",
          text: "MainAgent finished"
        }
      }
    ]);

    const view = createRunView(eventLog.readRunEvents("run_success"));

    expect(view).toMatchObject({
      runId: "run_success",
      sessionId: "session_success",
      status: "completed",
      trigger: "user",
      eventCount: 7,
      lastSeq: 7,
      input: {
        channel: "onebot11",
        conversationId: "group_01",
        messageId: "message_01",
        senderId: "user_01",
        senderName: "User One",
        text: "@bot start",
        trigger: { kind: "mention", text: "@bot" }
      },
      output: "MainAgent finished",
      agentCalls: [
        {
          agentCallId: "agent_call_01",
          taskId: "task_01",
          skillId: "coding",
          executionMode: "async",
          state: "completed"
        }
      ],
      reply: {
        status: "sent",
        conversationId: "group_01",
        text: "MainAgent finished"
      }
    });
    expect(view?.startedAt).toEqual(expect.any(String));
    expect(view?.endedAt).toEqual(expect.any(String));
    expect(view?.agentCalls[0]?.createdAt).toEqual(expect.any(String));
    expect(view?.agentCalls[0]?.updatedAt).toEqual(expect.any(String));
    expect(view?.reply).toMatchObject({ sentAt: expect.any(String) });
  });

  test("keeps the AgentCall cause for an agent_call_terminal reentry run", () => {
    const eventLog = new InMemoryEventLog();
    appendEvents(eventLog, [
      {
        type: "main_agent.run.started",
        runId: "run_reentry",
        sessionId: "session_reentry",
        data: {
          trigger: "agent_call_terminal",
          cause: {
            agentCallId: "agent_call_parent",
            taskId: "task_parent",
            state: "completed"
          }
        }
      },
      {
        type: "main_agent.run.completed",
        runId: "run_reentry",
        sessionId: "session_reentry",
        data: { output: "continued" }
      }
    ]);

    expect(createRunView(eventLog.readRunEvents("run_reentry"))).toMatchObject({
      status: "completed",
      trigger: "agent_call_terminal",
      cause: {
        agentCallId: "agent_call_parent",
        taskId: "task_parent",
        state: "completed"
      },
      output: "continued",
      agentCalls: [],
      reply: { status: "not-sent" }
    });
  });

  test("keeps a completed run completed when sending the reply fails", () => {
    const eventLog = new InMemoryEventLog();
    appendEvents(eventLog, [
      {
        type: "main_agent.run.started",
        runId: "run_reply_failed",
        sessionId: "session_reply_failed",
        data: { trigger: "user" }
      },
      {
        type: "main_agent.run.completed",
        runId: "run_reply_failed",
        sessionId: "session_reply_failed",
        data: { output: "done before reply" }
      },
      {
        type: "channel.reply.failed",
        runId: "run_reply_failed",
        sessionId: "session_reply_failed",
        data: {
          conversationId: "group_01",
          text: "done before reply",
          error: "OneBot unavailable"
        }
      }
    ]);

    expect(
      createRunView(eventLog.readRunEvents("run_reply_failed"))
    ).toMatchObject({
      status: "completed",
      output: "done before reply",
      reply: {
        status: "failed",
        conversationId: "group_01",
        text: "done before reply",
        error: "OneBot unavailable",
        failedAt: expect.any(String)
      }
    });
  });

  test("restores failed and cancelled MainAgent runs", () => {
    const failedLog = new InMemoryEventLog();
    appendEvents(failedLog, [
      {
        type: "main_agent.run.started",
        runId: "run_failed",
        sessionId: "session_failed",
        data: { trigger: "user" }
      },
      {
        type: "main_agent.run.failed",
        runId: "run_failed",
        sessionId: "session_failed",
        data: { error: "model failed" }
      }
    ]);

    const cancelledLog = new InMemoryEventLog();
    appendEvents(cancelledLog, [
      {
        type: "main_agent.run.started",
        runId: "run_cancelled",
        sessionId: "session_cancelled",
        data: { trigger: "user" }
      },
      {
        type: "main_agent.run.cancelled",
        runId: "run_cancelled",
        sessionId: "session_cancelled",
        data: { reason: "user cancelled" }
      }
    ]);

    expect(createRunView(failedLog.readRunEvents("run_failed"))).toMatchObject({
      status: "failed",
      error: "model failed",
      endedAt: expect.any(String)
    });
    expect(
      createRunView(cancelledLog.readRunEvents("run_cancelled"))
    ).toMatchObject({
      status: "cancelled",
      error: "user cancelled",
      endedAt: expect.any(String)
    });
  });

  test("returns pending before MainAgent starts and running after it starts", () => {
    const pendingLog = new InMemoryEventLog();
    pendingLog.append(channelMessage("run_pending", "session_pending"));

    const runningLog = new InMemoryEventLog();
    runningLog.append({
      type: "main_agent.run.started",
      runId: "run_running",
      sessionId: "session_running",
      data: { trigger: "user" }
    });

    expect(createRunView(pendingLog.readRunEvents("run_pending"))).toMatchObject({
      status: "pending",
      reply: { status: "not-sent" }
    });
    expect(createRunView(runningLog.readRunEvents("run_running"))).toMatchObject({
      status: "running",
      trigger: "user",
      reply: { status: "not-sent" }
    });
  });

  test("sorts by seq without mutating the caller's event array", () => {
    const events: AgentEvent[] = [
      completeEvent(4, "channel.reply.sent", {
        conversationId: "group_01",
        text: "ordered"
      }),
      completeEvent(2, "agent_call.created", {
        agentCallId: "agent_call_ordered",
        taskId: "task_ordered",
        skillId: "coding",
        executionMode: "blocking",
        state: "submitted"
      }),
      completeEvent(1, "main_agent.run.started", { trigger: "user" }),
      completeEvent(3, "main_agent.run.completed", { output: "ordered" })
    ];
    const snapshot = structuredClone(events);

    const view = createRunView(events);

    expect(events).toEqual(snapshot);
    expect(events.map((event) => event.seq)).toEqual([4, 2, 1, 3]);
    expect(view).toMatchObject({
      status: "completed",
      startedAt: "2026-07-15T00:00:01.000Z",
      endedAt: "2026-07-15T00:00:03.000Z",
      durationSeconds: 2,
      eventCount: 4,
      lastSeq: 4,
      output: "ordered",
      agentCalls: [{ agentCallId: "agent_call_ordered", state: "submitted" }],
      reply: { status: "sent", sentAt: "2026-07-15T00:00:04.000Z" }
    });
  });

  test("returns null when no events exist", () => {
    expect(createRunView([])).toBeNull();
  });
});

describe("EventLogRunViewReader", () => {
  test("reads and folds one run through the EventReader boundary", async () => {
    const eventLog = new InMemoryEventLog();
    appendEvents(eventLog, [
      {
        type: "main_agent.run.started",
        runId: "run_reader",
        sessionId: "session_reader",
        data: { trigger: "user" }
      },
      {
        type: "main_agent.run.completed",
        runId: "run_reader",
        sessionId: "session_reader",
        data: { output: "reader output" }
      }
    ]);
    const reader = new EventLogRunViewReader({ eventReader: eventLog });

    await expect(reader.readRunView("run_reader")).resolves.toMatchObject({
      status: "completed",
      output: "reader output"
    });
    await expect(reader.readRunView("run_missing")).resolves.toBeNull();
  });
});

function channelMessage(runId: string, sessionId: string): AgentEventDraft {
  return {
    type: "channel.message.received",
    runId,
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
  };
}

function completeEvent(
  seq: number,
  type: AgentEvent["type"],
  data: AgentEvent["data"]
): AgentEvent {
  return {
    schemaVersion: "2.0",
    id: `event_${seq}`,
    seq,
    timestamp: `2026-07-15T00:00:0${seq}.000Z`,
    type,
    runId: "run_ordered",
    sessionId: "session_ordered",
    data
  } as AgentEvent;
}
