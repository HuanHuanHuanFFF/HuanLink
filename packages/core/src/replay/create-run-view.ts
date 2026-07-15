import type { AgentEvent } from "../events/types.js";
import type {
  AgentCallView,
  ChannelInputView,
  ReplyView,
  RunView,
  RunViewCause,
  RunViewStatus
} from "./types.js";

type MutableAgentCallView = {
  -readonly [Key in keyof AgentCallView]: AgentCallView[Key];
};

export function createRunView(events: AgentEvent[]): RunView | null {
  if (events.length === 0) {
    return null;
  }

  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const firstEvent = orderedEvents[0]!;
  const lastEvent = orderedEvents[orderedEvents.length - 1]!;
  const agentCalls = new Map<string, MutableAgentCallView>();
  const agentCallOrder: string[] = [];

  let status: RunViewStatus = "pending";
  let trigger: RunView["trigger"];
  let cause: RunViewCause | undefined;
  let input: ChannelInputView | undefined;
  let output: string | undefined;
  let error: string | undefined;
  let endedAt: string | undefined;
  let reply: ReplyView = { status: "not-sent" };

  for (const event of orderedEvents) {
    switch (event.type) {
      case "channel.message.received":
        input = {
          channel: event.data.channel,
          conversationId: event.data.conversationId,
          messageId: event.data.messageId,
          senderId: event.data.senderId,
          senderName: event.data.senderName,
          text: event.data.text,
          ...(event.data.trigger === undefined
            ? {}
            : { trigger: { ...event.data.trigger } })
        };
        break;
      case "main_agent.run.started":
        if (status === "pending" || status === "running") {
          status = "running";
          trigger = event.data.trigger;
          cause =
            event.data.cause === undefined
              ? undefined
              : { ...event.data.cause };
        }
        break;
      case "main_agent.run.completed":
        status = "completed";
        output = event.data.output;
        error = undefined;
        endedAt = event.timestamp;
        break;
      case "main_agent.run.failed":
        status = "failed";
        output = undefined;
        error = event.data.error;
        endedAt = event.timestamp;
        break;
      case "main_agent.run.cancelled":
        status = "cancelled";
        output = undefined;
        error = event.data.reason;
        endedAt = event.timestamp;
        break;
      case "agent_call.created":
        mergeCreatedAgentCall(
          agentCalls,
          agentCallOrder,
          event.data,
          event.timestamp
        );
        break;
      case "agent_call.state.changed": {
        const agentCall = agentCalls.get(event.data.agentCallId);
        if (agentCall !== undefined) {
          agentCall.taskId = event.data.taskId;
          agentCall.state = event.data.state;
          agentCall.updatedAt = event.timestamp;
        }
        break;
      }
      case "channel.reply.sent":
        reply = {
          status: "sent",
          conversationId: event.data.conversationId,
          text: event.data.text,
          sentAt: event.timestamp
        };
        break;
      case "channel.reply.failed":
        reply = {
          status: "failed",
          conversationId: event.data.conversationId,
          text: event.data.text,
          error: event.data.error,
          failedAt: event.timestamp
        };
        break;
    }
  }

  return {
    runId: firstEvent.runId,
    sessionId: firstEvent.sessionId,
    status,
    trigger,
    cause,
    startedAt: firstEvent.timestamp,
    endedAt,
    durationSeconds:
      endedAt === undefined
        ? undefined
        : (Date.parse(endedAt) - Date.parse(firstEvent.timestamp)) / 1000,
    eventCount: orderedEvents.length,
    lastSeq: lastEvent.seq,
    input,
    output,
    error,
    agentCalls: agentCallOrder.map((agentCallId) => ({
      ...agentCalls.get(agentCallId)!
    })),
    reply
  };
}

function mergeCreatedAgentCall(
  agentCalls: Map<string, MutableAgentCallView>,
  agentCallOrder: string[],
  data: Extract<AgentEvent, { type: "agent_call.created" }>["data"],
  timestamp: string
): void {
  const existing = agentCalls.get(data.agentCallId);

  if (existing === undefined) {
    agentCalls.set(data.agentCallId, {
      agentCallId: data.agentCallId,
      taskId: data.taskId,
      skillId: data.skillId,
      executionMode: data.executionMode,
      state: data.state,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    agentCallOrder.push(data.agentCallId);
    return;
  }

  existing.taskId = data.taskId;
  existing.skillId = data.skillId;
  existing.executionMode = data.executionMode;
  existing.state = data.state;
  existing.updatedAt = timestamp;
}
