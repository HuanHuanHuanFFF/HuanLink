import { describe, expect, test } from "vitest";

import {
  projectConversationSessionContext,
  type ConversationAgentToolCallEntry,
  type ConversationAgentToolCallLocation,
  type ConversationSessionContextWindow,
} from "@huanlink/core";

import { buildTaskReentrySessionContext } from "../src/index.js";

const sourceToolCall: ConversationAgentToolCallEntry = {
  type: "agent_tool_call",
  runId: "run-source-private",
  toolCallId: "sdk-call-private",
  toolName: "submit_codex_agent_call",
  arguments: { task: "update the parser" },
};

const sourceToolCallLocation: ConversationAgentToolCallLocation = {
  entryIndex: 1,
  entry: sourceToolCall,
};

const metadata: ConversationSessionContextWindow["metadata"] = {
  kind: "external_channel",
  route: {
    channelId: "qq-main",
    conversationKind: "group",
    conversationId: "group-42",
  },
  contentFormat: "plain_text",
};

describe("Task re-entry Session context", () => {
  test("preserves the projected Window source Tool Call exactly without duplicating it", () => {
    const window: ConversationSessionContextWindow = {
      metadata,
      entries: [{ entryIndex: 1, entry: sourceToolCall }],
    };
    const reentryContext = buildTaskReentrySessionContext(
      window,
      sourceToolCallLocation,
    );
    const projected = JSON.parse(reentryContext) as {
      entries: Array<Record<string, unknown>>;
      sourceToolCall?: unknown;
    };

    expect(reentryContext).toBe(projectConversationSessionContext(window));
    expect(projected.sourceToolCall).toBeUndefined();
    expect(projected.entries).toEqual([
      {
        type: "agent_tool_call",
        runId: "run-source-private",
        toolCallId: "sdk-call-private",
        toolName: "submit_codex_agent_call",
        arguments: { task: "update the parser" },
      },
    ]);
  });

  test("appends one marked source Tool Call when it is covered by the latest cursor", () => {
    const projected = JSON.parse(
      buildTaskReentrySessionContext(
        {
          metadata,
          summary: {
            text: "Earlier work was compacted.",
            throughEntryIndex: 4,
          },
          entries: [
            {
              entryIndex: 5,
              entry: {
                type: "channel_message",
                channelId: "qq-main",
                messageId: "message-latest",
                observed: {
                  messageId: "message-latest",
                  route: metadata.route,
                  sender: {
                    id: "user-1",
                    username: "alice",
                    isSelf: false,
                  },
                  content: "Please keep the latest behavior.",
                  contentFormat: "plain_text",
                  receivedAt: "2026-08-12T00:00:00.000Z",
                },
              },
            },
          ],
        },
        {
          entryIndex: 4,
          entry: sourceToolCall,
        },
      ),
    ) as {
      entries: Array<Record<string, unknown>>;
      sourceToolCall: Record<string, unknown>;
    };

    expect(projected.sourceToolCall).toEqual({
      type: "source_tool_call",
      toolName: "submit_codex_agent_call",
      arguments: { task: "update the parser" },
    });
    expect(projected.entries).toHaveLength(1);
    expect(JSON.stringify(projected).match(/update the parser/g)).toHaveLength(
      1,
    );
    expect(JSON.stringify(projected)).not.toMatch(
      /run-source-private|sdk-call-private|runId|toolCallId/,
    );
  });

  test("keeps the projected source Tool Call when it is after the latest cursor", () => {
    const window: ConversationSessionContextWindow = {
      metadata,
      summary: {
        text: "Earlier work was compacted.",
        throughEntryIndex: 4,
      },
      entries: [{ entryIndex: 5, entry: sourceToolCall }],
    };

    const reentryContext = buildTaskReentrySessionContext(window, {
      entryIndex: 5,
      entry: sourceToolCall,
    });
    const projected = JSON.parse(reentryContext) as {
      sourceToolCall?: unknown;
    };

    expect(reentryContext).toBe(projectConversationSessionContext(window));
    expect(projected.sourceToolCall).toBeUndefined();
  });
});
