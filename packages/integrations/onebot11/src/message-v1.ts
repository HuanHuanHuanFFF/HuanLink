import { Buffer } from "node:buffer";

import {
  CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1,
  CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
  resolveChannelTriggerV1,
  type InboundChannelMessageV1,
} from "@huanlink/core";

import {
  normalizeOneBot11Message,
  type OneBot11MessageSegment,
} from "./codec.js";

export type ParseOneBot11MessageV1Options = {
  /** 当前 OneBot Channel 实例的稳定标识。 */
  readonly channelId: string;
};

/**
 * 将 OneBot 11 的群聊或私聊消息事件转换为 HuanLink V1 入站消息。
 * 不支持的事件或缺少必要字段时返回 undefined；配置项为空时抛出错误。
 * 消息正文统一保留为 CQ 字符串，超过 8 KiB 时改为超限占位记录。
 */
export function parseOneBot11MessageV1(
  input: unknown,
  options: ParseOneBot11MessageV1Options,
): InboundChannelMessageV1 | undefined {
  const channelId = nonEmptyString(options.channelId);
  if (channelId === undefined) {
    throw new Error("channelId must be non-empty");
  }

  const frame = asObject(input);
  if (
    frame === undefined ||
    (frame.post_type !== "message" && frame.post_type !== "message_sent") ||
    (frame.message_type !== "group" && frame.message_type !== "private")
  ) {
    return undefined;
  }

  const selfId = normalizePositiveId(frame.self_id);
  const messageId = normalizeMessageId(frame.message_id);
  const senderId = normalizePositiveId(frame.user_id);
  const receivedAt = parseReceivedAt(frame.time);
  const normalized = normalizeOneBot11Message(frame.message);
  const conversationId =
    frame.message_type === "group"
      ? normalizePositiveId(frame.group_id)
      : frame.post_type === "message_sent"
        ? normalizePositiveId(frame.target_id)
        : senderId;
  if (
    selfId === undefined ||
    messageId === undefined ||
    senderId === undefined ||
    conversationId === undefined ||
    receivedAt === undefined ||
    normalized === undefined
  ) {
    return undefined;
  }

  const sender = asObject(frame.sender);
  const username = nonEmptyString(sender?.nickname) ?? senderId;
  const displayName = nonEmptyString(sender?.card);
  const contentSize = Buffer.byteLength(normalized.content, "utf8");
  const message: InboundChannelMessageV1 = {
    messageId,
    route: {
      channelId,
      conversationKind:
        frame.message_type === "group" ? "group" : "direct",
      conversationId,
    },
    sender: {
      id: senderId,
      username,
      ...(displayName === undefined || displayName === username
        ? {}
        : { displayName }),
      isSelf: senderId === selfId,
    },
    receivedAt,
    ...(contentSize <= CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1
      ? { content: normalized.content }
      : {
          content: CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
          contentOmitted: {
            reason: "too_large" as const,
            originalSizeBytes: contentSize,
          },
        }),
    contentFormat: "onebot11.cq",
    ...optionalMessageMetadata(normalized.segments, selfId),
  };
  return message;
}

/**
 * 从规范化消息段中提取可选的引用消息 ID 和触发原因。
 * 没有有效引用、@Bot 或通用斜杠命令时不写入对应字段。
 */
function optionalMessageMetadata(
  segments: readonly OneBot11MessageSegment[],
  selfId: string,
): Pick<InboundChannelMessageV1, "replyToMessageId" | "trigger"> {
  const replyToMessageId = segments
    .filter((segment) => segment.type === "reply")
    .map((segment) => normalizeMessageId(segment.data.id))
    .find((value) => value !== undefined);
  const trigger = parseTrigger(segments, selfId);
  return {
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(trigger === undefined ? {} : { trigger }),
  };
}

/**
 * 提取 OneBot 平台事实，并交给 Core Channel 统一判断触发原因。
 */
function parseTrigger(
  segments: readonly OneBot11MessageSegment[],
  selfId: string,
): InboundChannelMessageV1["trigger"] {
  const mentionedSelf = segments.some(
    (segment) =>
      segment.type === "at" &&
      normalizePositiveId(segment.data.qq) === selfId,
  );
  const leadingText = leadingTriggerText(segments, selfId);
  return resolveChannelTriggerV1({
    mentionedSelf,
    ...(leadingText === undefined ? {} : { leadingText }),
  });
}

/**
 * 提取供 Channel 判断触发原因的开头连续文本。
 * 开头允许 reply、空白和 @当前Bot；在有效文本前遇到 @其他人时不提供候选。
 */
function leadingTriggerText(
  segments: readonly OneBot11MessageSegment[],
  selfId: string,
): string | undefined {
  const text: string[] = [];
  let contentStarted = false;
  for (const segment of segments) {
    if (!contentStarted && segment.type === "reply") {
      continue;
    }
    if (
      !contentStarted &&
      segment.type === "at"
    ) {
      if (normalizePositiveId(segment.data.qq) === selfId) {
        continue;
      }
      return undefined;
    }
    if (segment.type !== "text") {
      break;
    }
    const value = segment.data.text ?? "";
    text.push(value);
    if (/\S/u.test(value)) {
      contentStarted = true;
    }
  }
  return text.length === 0 ? undefined : text.join("");
}

/**
 * 将 OneBot 的 Unix 秒级时间戳转换为 UTC ISO-8601 字符串。
 * 输入不是非负整数或无法构造有效日期时返回 undefined。
 */
function parseReceivedAt(input: unknown): string | undefined {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0
  ) {
    return undefined;
  }
  const date = new Date(input * 1000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/**
 * 将 OneBot 用户、群或目标 ID 规范为正整数字符串。
 */
function normalizePositiveId(input: unknown): string | undefined {
  const normalized = normalizeInteger(input);
  return normalized !== undefined && /^[1-9]\d*$/u.test(normalized)
    ? normalized
    : undefined;
}

/**
 * 将 OneBot 消息 ID 规范为整数字符串；兼容协议实现返回的负数 ID。
 */
function normalizeMessageId(input: unknown): string | undefined {
  const normalized = normalizeInteger(input);
  return normalized !== undefined && /^-?\d+$/u.test(normalized)
    ? normalized
    : undefined;
}

/**
 * 将整数字符串或 JavaScript 安全整数统一转换为去除首尾空白的字符串。
 * 此函数只统一输入形态，具体是否允许正数或负数由调用方继续校验。
 */
function normalizeInteger(input: unknown): string | undefined {
  if (typeof input === "string") {
    const normalized = input.trim();
    return normalized.length === 0 ? undefined : normalized;
  }
  if (
    typeof input === "number" &&
    Number.isSafeInteger(input)
  ) {
    return String(input);
  }
  return undefined;
}

/**
 * 将未知输入收窄为去除首尾空白后的非空字符串。
 */
function nonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const normalized = input.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/**
 * 将未知输入收窄为非 null、非数组的普通对象。
 */
function asObject(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
