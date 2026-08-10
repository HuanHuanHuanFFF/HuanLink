import { expect, test } from "vitest";

import {
  projectConversationSessionContext,
  type ConversationSessionContextWindow,
} from "../src/index.js";

test("projects a cursor window as compact deterministic JSON without repeating route metadata", () => {
  const window: ConversationSessionContextWindow = {
    metadata: {
      kind: "external_channel",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      contentFormat: "onebot11.cq",
    },
    summary: { text: "Earlier context", throughEntryIndex: 10 },
    entries: [
      {
        entryIndex: 30,
        entry: {
          type: "agent_tool_result",
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "reply",
          output: { z: { second: true, first: false }, a: 1 },
        },
      },
      {
        entryIndex: 11,
        entry: {
          type: "channel_message",
          channelId: "qq-main",
          messageId: "message-1",
          observed: {
            messageId: "message-1",
            route: {
              channelId: "qq-main",
              conversationKind: "group",
              conversationId: "10001",
            },
            sender: {
              id: "bot-1",
              username: "HuanLink",
              displayName: "HuanLink Bot",
              isSelf: true,
            },
            receivedAt: "2026-08-08T08:00:00.000Z",
            content: "[CQ:at,qq=1] reply",
            contentFormat: "onebot11.cq",
            contentOmitted: { reason: "too_large", originalSizeBytes: 9001 },
            replyToMessageId: "message-0",
            trigger: { kind: "mention" },
          },
          outbound: {
            sentAt: "2026-08-08T08:01:00.000Z",
            runId: "run-1",
            toolCallId: "call-1",
            sourceSessionId: "other-session",
            origin: "cross_session",
          },
        },
      },
      {
        entryIndex: 20,
        entry: {
          type: "agent_tool_call",
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "reply",
          rawArguments: '{"content":',
        },
      },
    ],
  };
  const before = JSON.stringify(window);

  const projection = projectConversationSessionContext(window);

  expect(projection).not.toContain("\n");
  expect(projection).toBe(
    projectConversationSessionContext({
      ...window,
      entries: [...window.entries].reverse(),
    }),
  );
  expect(projection).toContain('"a":1,"z":{"first":false,"second":true}');
  expect(projection.match(/"route":/g)).toHaveLength(1);
  expect(projection.match(/"contentFormat":/g)).toHaveLength(1);
  expect(JSON.stringify(window)).toBe(before);
  expect(JSON.parse(projection)).toEqual({
    entries: [
      {
        content: "[CQ:at,qq=1] reply",
        contentOmitted: { originalSizeBytes: 9001, reason: "too_large" },
        messageId: "message-1",
        outbound: {
          origin: "cross_session",
          runId: "run-1",
          sentAt: "2026-08-08T08:01:00.000Z",
          sourceSessionId: "other-session",
          toolCallId: "call-1",
        },
        receivedAt: "2026-08-08T08:00:00.000Z",
        replyToMessageId: "message-0",
        sender: {
          displayName: "HuanLink Bot",
          id: "bot-1",
          isSelf: true,
          username: "HuanLink",
        },
        trigger: { kind: "mention" },
        type: "channel_message",
      },
      {
        rawArguments: '{"content":',
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        type: "agent_tool_call",
      },
      {
        output: { a: 1, z: { first: false, second: true } },
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "reply",
        type: "agent_tool_result",
      },
    ],
    metadata: {
      contentFormat: "onebot11.cq",
      kind: "external_channel",
      route: {
        channelId: "qq-main",
        conversationId: "10001",
        conversationKind: "group",
      },
    },
    summary: { text: "Earlier context" },
  });
});

test("rejects a context window whose cursor overlaps an emitted stable entry", () => {
  const window: ConversationSessionContextWindow = {
    metadata: {
      kind: "external_channel",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      contentFormat: "onebot11.cq",
    },
    summary: { text: "Earlier context", throughEntryIndex: 20 },
    entries: [
      {
        entryIndex: 20,
        entry: {
          type: "agent_tool_call",
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "reply",
          arguments: {},
        },
      },
    ],
  };

  expect(() => projectConversationSessionContext(window)).toThrow(
    /after the context cursor/i,
  );
});
