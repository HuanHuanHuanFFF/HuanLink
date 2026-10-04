import type {
  ConversationAgentToolCallEntry,
  ConversationChannelMessageEntry,
  ConversationSessionContextEntry,
  ConversationSessionContextWindow,
  ConversationTimelineEntry,
} from "./conversation-session.js";

type ProjectedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectedJsonValue[]
  | { readonly [key: string]: ProjectedJsonValue };

/**
 * Projects one Session window into a compact, protocol-neutral JSON value.
 *
 * Route and content-format live only in the metadata header. Entry indices are
 * sorted instead of trusting array order, so a late Tool Result can be placed
 * beside its Call without changing the meaning of a cursor.
 */
export function projectConversationSessionContext(
  window: ConversationSessionContextWindow,
): string {
  const throughEntryIndex = window.summary?.throughEntryIndex;
  if (
    throughEntryIndex !== undefined &&
    (!Number.isSafeInteger(throughEntryIndex) || throughEntryIndex < 0)
  ) {
    throw new Error(
      "Conversation context cursor must be a non-negative safe integer",
    );
  }

  const entries = window.entries
    .map((contextEntry) =>
      validateContextEntry(contextEntry, throughEntryIndex),
    )
    .sort((left, right) => left.entryIndex - right.entryIndex);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.entryIndex === entries[index]!.entryIndex) {
      throw new Error("Conversation context entry indexes must be unique");
    }
  }

  return stringifyCanonicalJson({
    metadata: projectMetadata(window),
    ...(window.summary === undefined
      ? {}
      : {
          summary: {
            text: window.summary.text,
          },
        }),
    entries: entries.map(({ entry }) => projectTimelineEntry(entry)),
  });
}

function validateContextEntry(
  contextEntry: ConversationSessionContextEntry,
  throughEntryIndex: number | undefined,
): ConversationSessionContextEntry {
  if (
    !Number.isSafeInteger(contextEntry.entryIndex) ||
    contextEntry.entryIndex < 0
  ) {
    throw new Error(
      "Conversation context entryIndex must be a non-negative safe integer",
    );
  }
  if (
    throughEntryIndex !== undefined &&
    contextEntry.entryIndex <= throughEntryIndex
  ) {
    throw new Error(
      "Conversation context entries must be after the context cursor",
    );
  }
  return contextEntry;
}

function projectMetadata(
  window: ConversationSessionContextWindow,
): ProjectedJsonValue {
  const { route } = window.metadata;
  return {
    kind: window.metadata.kind,
    route: {
      channelId: route.channelId,
      conversationKind: route.conversationKind,
      conversationId: route.conversationId,
      ...(route.threadId === undefined ? {} : { threadId: route.threadId }),
    },
    contentFormat: window.metadata.contentFormat,
  };
}

function projectTimelineEntry(
  entry: ConversationTimelineEntry,
): ProjectedJsonValue {
  switch (entry.type) {
    case "channel_message":
      return projectChannelMessageEntry(entry);
    case "agent_tool_call":
      return projectToolCallEntry(entry);
    case "agent_tool_result":
      return {
        type: "agent_tool_result",
        runId: entry.runId,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        output: entry.output,
      };
  }
}

function projectChannelMessageEntry(
  entry: ConversationChannelMessageEntry,
): ProjectedJsonValue {
  const observed = entry.observed;
  return {
    type: "channel_message",
    messageId: entry.messageId,
    ...(observed === undefined
      ? {}
      : {
          sender: {
            id: observed.sender.id,
            username: observed.sender.username,
            ...(observed.sender.displayName === undefined
              ? {}
              : { displayName: observed.sender.displayName }),
            isSelf: observed.sender.isSelf,
          },
          receivedAt: observed.receivedAt,
          content: observed.content,
          ...(observed.contentOmitted === undefined
            ? {}
            : { contentOmitted: { ...observed.contentOmitted } }),
          ...(observed.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: observed.replyToMessageId }),
          ...(observed.trigger === undefined
            ? {}
            : { trigger: { ...observed.trigger } }),
        }),
    ...(entry.outbound === undefined
      ? {}
      : { outbound: { ...entry.outbound } }),
  };
}

function projectToolCallEntry(
  entry: ConversationAgentToolCallEntry,
): ProjectedJsonValue {
  const identity = {
    type: "agent_tool_call" as const,
    runId: entry.runId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
  };
  if (entry.rawArguments !== undefined) {
    return { ...identity, rawArguments: entry.rawArguments };
  }
  if (entry.arguments === undefined) {
    throw new Error("Conversation Tool Call has no arguments payload");
  }
  return { ...identity, arguments: entry.arguments };
}

/** Recursively sorts object keys and emits compact JSON without mutating input. */
function stringifyCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Conversation context JSON cannot contain non-finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(compareJsonKeys)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stringifyCanonicalJson(object[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    "Conversation context JSON must not contain undefined or unsupported values",
  );
}

function compareJsonKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
