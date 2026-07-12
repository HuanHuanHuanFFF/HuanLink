import type { InboundChannelMessage } from "@huanlink/core";

import type { ParseOneBot11GroupMessageOptions } from "./types.js";

type JsonObject = Record<string, unknown>;

type ParsedSegments = {
  text: string;
  textWithoutSelfMention: string;
  mentionsSelf: boolean;
};

export function parseOneBot11GroupMessage(
  input: unknown,
  options: ParseOneBot11GroupMessageOptions,
): InboundChannelMessage | undefined {
  const commandPrefix = options.commandPrefix.trim();
  if (commandPrefix.length === 0) {
    throw new Error("commandPrefix must be non-empty");
  }

  const frame = asObject(input);
  if (
    frame === undefined ||
    frame.post_type !== "message" ||
    frame.message_type !== "group"
  ) {
    return undefined;
  }

  const selfId = normalizeId(frame.self_id);
  const conversationId = normalizeId(frame.group_id);
  const messageId = normalizeId(frame.message_id);
  const senderId = normalizeId(frame.user_id);
  const receivedAt = parseReceivedAt(frame.time);
  if (
    selfId === undefined ||
    conversationId === undefined ||
    messageId === undefined ||
    senderId === undefined ||
    receivedAt === undefined ||
    senderId === selfId ||
    !Array.isArray(frame.message)
  ) {
    return undefined;
  }

  const segments = parseSegments(frame.message, selfId);
  if (segments === undefined) {
    return undefined;
  }

  const trigger = buildTrigger(segments, commandPrefix);
  return {
    channel: "onebot11",
    conversationId,
    messageId,
    senderId,
    senderName: parseSenderName(frame.sender, senderId),
    text: segments.text,
    receivedAt,
    ...(trigger === undefined ? {} : { trigger }),
  };
}

function parseSegments(
  input: readonly unknown[],
  selfId: string,
): ParsedSegments | undefined {
  const rendered: string[] = [];
  const withoutSelfMention: string[] = [];
  let mentionsSelf = false;

  for (const rawSegment of input) {
    const segment = asObject(rawSegment);
    const data = asObject(segment?.data);
    if (segment === undefined || typeof segment.type !== "string" || data === undefined) {
      return undefined;
    }

    if (segment.type === "text") {
      if (typeof data.text !== "string") {
        return undefined;
      }
      rendered.push(data.text);
      withoutSelfMention.push(data.text);
      continue;
    }

    if (segment.type === "at") {
      const targetId = normalizeId(data.qq);
      if (targetId === undefined) {
        return undefined;
      }
      const visibleMention = `@<${targetId}>`;
      rendered.push(visibleMention);
      if (targetId === selfId) {
        mentionsSelf = true;
      } else {
        withoutSelfMention.push(visibleMention);
      }
    }
  }

  return {
    text: rendered.join("").trimStart(),
    textWithoutSelfMention: withoutSelfMention.join("").trim(),
    mentionsSelf,
  };
}

function buildTrigger(
  segments: ParsedSegments,
  commandPrefix: string,
): InboundChannelMessage["trigger"] {
  if (segments.mentionsSelf) {
    return {
      kind: "mention",
      text:
        stripCommandPrefix(segments.textWithoutSelfMention, commandPrefix) ??
        segments.textWithoutSelfMention,
    };
  }

  const commandText = stripCommandPrefix(segments.text, commandPrefix);
  return commandText === undefined
    ? undefined
    : { kind: "command", text: commandText };
}

function stripCommandPrefix(
  input: string,
  commandPrefix: string,
): string | undefined {
  const candidate = input.trimStart();
  if (!candidate.startsWith(commandPrefix)) {
    return undefined;
  }

  const boundary = candidate.at(commandPrefix.length);
  if (boundary !== undefined && !/\s/u.test(boundary)) {
    return undefined;
  }

  return candidate.slice(commandPrefix.length).trim();
}

function parseSenderName(input: unknown, fallback: string): string {
  const sender = asObject(input);
  return (
    nonEmptyString(sender?.card) ??
    nonEmptyString(sender?.nickname) ??
    fallback
  );
}

function parseReceivedAt(input: unknown): string | undefined {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0
  ) {
    return undefined;
  }

  const milliseconds = input * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function normalizeId(input: unknown): string | undefined {
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized.length === 0 ? undefined : normalized;
  }
  if (typeof input === "number" && Number.isFinite(input) && Number.isInteger(input)) {
    return String(input);
  }
  return undefined;
}

function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function asObject(input: unknown): JsonObject | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as JsonObject)
    : undefined;
}
