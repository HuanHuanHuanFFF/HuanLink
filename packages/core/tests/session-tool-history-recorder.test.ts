import { expect, test } from "vitest";

import {
  ConversationSessionStoreToolHistoryRecorder,
  InMemoryConversationSessionStore,
  type InboundChannelMessage,
} from "../src/index.js";

function inboundMessage(): InboundChannelMessage {
  return {
    messageId: "message-1",
    route: {
      channelId: "qq-main",
      conversationKind: "group",
      conversationId: "10001",
    },
    sender: { id: "20002", username: "Alice", isSelf: false },
    receivedAt: "2026-08-08T08:00:00.000Z",
    content: "hello",
    contentFormat: "onebot11.cq",
  };
}

test("SessionToolHistoryRecorder forwards caller-provided IDs to the Session Store", () => {
  const store = new InMemoryConversationSessionStore();
  const recorder = new ConversationSessionStoreToolHistoryRecorder(store);
  store.appendChannelMessage("session-a", inboundMessage());

  recorder.recordToolCall("session-a", {
    runId: "run-from-caller",
    toolCallId: "sdk-call-42",
    toolName: "reply",
    rawArguments: '{"content":',
  });
  recorder.recordToolResult("session-a", {
    runId: "run-from-caller",
    toolCallId: "sdk-call-42",
    toolName: "reply",
    output: { status: "sent" },
  });

  expect(store.getSession("session-a")?.timeline).toMatchObject([
    { type: "channel_message" },
    {
      type: "agent_tool_call",
      runId: "run-from-caller",
      toolCallId: "sdk-call-42",
      rawArguments: '{"content":',
    },
    {
      type: "agent_tool_result",
      runId: "run-from-caller",
      toolCallId: "sdk-call-42",
      output: { status: "sent" },
    },
  ]);
});
