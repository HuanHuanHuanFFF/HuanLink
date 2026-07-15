// 补充 createRunView reducer 在失败工具与观测回填分支上的行为。
import { describe, expect, test } from "vitest";

import { InMemoryEventLog, createRunView } from "../src/index.js";
import type { AgentEventDraft } from "../src/index.js";

// 把一组最小事件写入内存日志并返回补齐后的完整事件序列。
function buildEvents(runId: string, events: AgentEventDraft[]) {
  const eventLog = new InMemoryEventLog();

  for (const event of events) {
    eventLog.append(event);
  }

  return eventLog.readRunEvents(runId);
}

describe("createRunView tool-call reducer", () => {
  test("records a failed tool call with its error output", () => {
    const runId = "run_view_failed_tool_01";
    const sessionId = "session_view_failed_tool_01";
    const events = buildEvents(runId, [
      {
        type: "run.created",
        runId,
        sessionId,
        source: "agent_loop",
        data: { userMessage: "Trigger a failing tool" }
      },
      {
        type: "tool.failed",
        runId,
        sessionId,
        source: "tool_gateway",
        step: 0,
        toolCallId: "call_failed_01",
        data: {
          toolCall: {
            id: "call_failed_01",
            name: "boom",
            args: {}
          },
          result: {
            callId: "call_failed_01",
            toolName: "boom",
            output: "tool exploded",
            isError: true
          }
        }
      },
      {
        type: "run.failed",
        runId,
        sessionId,
        source: "agent_loop",
        data: { error: "run stopped after tool failure" }
      }
    ]);

    const view = createRunView(events);

    expect(view).toMatchObject({
      runId,
      sessionId,
      status: "failed",
      error: "run stopped after tool failure",
      toolCalls: [
        {
          toolCallId: "call_failed_01",
          toolName: "boom",
          step: 0,
          status: "failed",
          output: "tool exploded"
        }
      ]
    });
  });

  test("backfills tool-call output from an observation when none was set", () => {
    const runId = "run_view_observation_01";
    const sessionId = "session_view_observation_01";
    const events = buildEvents(runId, [
      {
        type: "run.created",
        runId,
        sessionId,
        source: "agent_loop",
        data: { userMessage: "Observation without prior tool result" }
      },
      {
        type: "observation.appended",
        runId,
        sessionId,
        source: "agent_loop",
        step: 0,
        parentEventId: "evt_parent_01",
        data: {
          toolCallId: "call_observed_01",
          toolName: "lookup",
          message: {
            role: "tool",
            content: "observed output"
          }
        }
      }
    ]);

    const view = createRunView(events);

    expect(view?.status).toBe("running");
    expect(view?.toolCalls).toEqual([
      {
        toolCallId: "call_observed_01",
        toolName: "lookup",
        step: 0,
        status: "requested",
        output: "observed output",
        parentEventId: "evt_parent_01"
      }
    ]);
  });

  test("does not overwrite an existing output when a later observation arrives", () => {
    const runId = "run_view_observation_keep_01";
    const sessionId = "session_view_observation_keep_01";
    const events = buildEvents(runId, [
      {
        type: "run.created",
        runId,
        sessionId,
        source: "agent_loop",
        data: { userMessage: "Completed tool then observation" }
      },
      {
        type: "tool.completed",
        runId,
        sessionId,
        source: "tool_gateway",
        step: 0,
        toolCallId: "call_keep_01",
        data: {
          toolCall: {
            id: "call_keep_01",
            name: "lookup",
            args: {}
          },
          result: {
            callId: "call_keep_01",
            toolName: "lookup",
            output: "authoritative output"
          }
        }
      },
      {
        type: "observation.appended",
        runId,
        sessionId,
        source: "agent_loop",
        step: 0,
        parentEventId: "evt_parent_keep_01",
        data: {
          toolCallId: "call_keep_01",
          toolName: "lookup",
          message: {
            role: "tool",
            content: "observation output that should be ignored"
          }
        }
      }
    ]);

    const view = createRunView(events);

    expect(view?.toolCalls[0]).toMatchObject({
      toolCallId: "call_keep_01",
      status: "completed",
      output: "authoritative output",
      parentEventId: "evt_parent_keep_01"
    });
  });
});
