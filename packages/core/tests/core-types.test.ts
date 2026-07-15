// 验证 core 对外暴露的是外层编排事件，而不是旧 inner-loop 事件。

import { describe, expect, test } from "vitest";

import * as coreApi from "../src/index.js";
import { CORE_SCHEMA_VERSION } from "../src/index.js";
import type {
  AgentCallId,
  AgentCallTaskState,
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  AgentRuntimeTrigger,
  ChannelTrigger,
  EventLog,
  EventReader,
  EventWriter,
  RunId,
  SessionId,
  TaskExecutionMode
} from "../src/index.js";

describe("core public types", () => {
  test("exports the outer orchestration event API shape", () => {
    const runId: RunId = "run_01";
    const sessionId: SessionId = "session_01";
    const agentCallId: AgentCallId = "agent_call_01";
    const eventType: AgentEventType = "agent_call.created";
    const trigger: AgentRuntimeTrigger = "agent_call_terminal";
    const channelTrigger: ChannelTrigger = {
      kind: "mention",
      text: "@bot continue"
    };
    const state: AgentCallTaskState = "submitted";
    const executionMode: TaskExecutionMode = "async";

    const event: AgentEvent = {
      schemaVersion: CORE_SCHEMA_VERSION,
      id: "event_01",
      seq: 1,
      timestamp: "2026-07-15T00:00:00.000Z",
      type: eventType,
      runId,
      sessionId,
      data: {
        agentCallId,
        taskId: "task_01",
        skillId: "coding",
        executionMode,
        state
      }
    };

    const eventDraft: AgentEventDraft = {
      type: "main_agent.run.started",
      runId,
      sessionId,
      data: {
        trigger,
        cause: {
          agentCallId,
          taskId: "task_01",
          state: "completed"
        }
      }
    };

    const eventWriter: EventWriter = { append: () => event };
    const eventReader: EventReader = { readRunEvents: () => [event] };
    const eventLog: EventLog = {
      append: eventWriter.append,
      readRunEvents: eventReader.readRunEvents
    };

    expect(CORE_SCHEMA_VERSION).toBe("2.0");
    expect(eventWriter.append(eventDraft)).toEqual(event);
    expect(eventLog.readRunEvents(runId)).toEqual([event]);
    expect(channelTrigger).toEqual({ kind: "mention", text: "@bot continue" });
  });

  test("does not expose the retired inner-loop runtime API", () => {
    const retiredExports = [
      "AgentLoop",
      "FakeModelClient",
      "ToolGateway",
      "AllowPolicyEngine",
      "echoTool",
      "StaticContextAssembler"
    ];

    expect(retiredExports.filter((name) => name in coreApi)).toEqual([]);
  });
});
