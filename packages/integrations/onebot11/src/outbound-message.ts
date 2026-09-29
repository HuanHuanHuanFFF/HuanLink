import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  ChannelOperationError,
  assertValidRetractChannelMessageCommand,
  assertValidSendChannelMessageCommand,
  type ChannelAttachmentKind,
  type ChannelOutboundMessagePart,
  type RetractChannelMessageCommand,
  type SendChannelMessageCommand,
} from "@huanlink/core";

import type {
  OneBot11Action,
  OneBot11JsonObject,
  OneBot11MessageSegment,
} from "./codec.js";

/**
 * 将 HuanLink Channel 发送命令转换为 OneBot 11 群聊或私聊 Action。
 * 保留回复和 Parts 顺序；本机媒体路径会先检查可读性并转换为 file URL。
 */
export async function createOneBot11SendMessageAction(
  command: SendChannelMessageCommand,
  channelId: string,
  echo: string,
): Promise<OneBot11Action> {
  validateSendCommand(command);
  assertMatchingChannel(command.route.channelId, channelId);
  assertSupportedRoute(command.route.conversationKind, command.route.threadId);

  const targetId = parsePositiveIdParameter(
    command.route.conversationId,
    "OneBot 11 conversation ID",
  );
  const message: OneBot11MessageSegment[] = [];
  if (command.replyToMessageId !== undefined) {
    message.push({
      type: "reply",
      data: {
        id: String(
          parseMessageIdParameter(
            command.replyToMessageId,
            "OneBot 11 reply message ID",
          ),
        ),
      },
    });
  }

  for (const part of command.parts) {
    message.push(await mapOutboundPart(part));
  }

  return {
    action:
      command.route.conversationKind === "group"
        ? "send_group_msg"
        : "send_private_msg",
    params: {
      [command.route.conversationKind === "group" ? "group_id" : "user_id"]:
        targetId,
      message: message.map((segment) => ({
        type: segment.type,
        data: Object.fromEntries(
          Object.entries(segment.data).map(([key, value]) => [
            key,
            oneBotSegmentParameter(segment.type, key, value),
          ]),
        ),
      })),
    },
    echo,
  };
}

/**
 * 将 HuanLink Channel 主动撤回命令转换为 OneBot 11 `delete_msg` Action。
 */
export function createOneBot11DeleteMessageAction(
  command: RetractChannelMessageCommand,
  channelId: string,
  echo: string,
): OneBot11Action {
  validateRetractCommand(command);
  assertMatchingChannel(command.route.channelId, channelId);
  assertSupportedRoute(command.route.conversationKind, command.route.threadId);

  return {
    action: "delete_msg",
    params: {
      message_id: parseMessageIdParameter(
        command.messageId,
        "OneBot 11 retract message ID",
      ),
    },
    echo,
  };
}

/**
 * 从 OneBot 11 成功响应中读取并规范化 `message_id`。
 * 响应缺少有效 ID 时返回 undefined，由 Adapter 转换为稳定发送错误。
 */
export function readOneBot11MessageId(
  response: OneBot11JsonObject,
): string | undefined {
  const data = asObject(response.data);
  const value = data?.message_id;
  if (typeof value === "string") {
    const normalized = value.trim();
    return /^-?\d+$/u.test(normalized) ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

/** 将一个通用出站 Part 映射为对应的 OneBot 11 消息段。 */
async function mapOutboundPart(
  part: ChannelOutboundMessagePart,
): Promise<OneBot11MessageSegment> {
  switch (part.type) {
    case "text":
      return { type: "text", data: { text: part.text } };
    case "mention":
      return {
        type: "at",
        data: {
          qq: String(parseMentionTargetParameter(part.targetId)),
        },
      };
    case "attachmentLink":
      return mediaSegment(part.kind, part.url);
    case "attachmentLocalPath":
      if (part.kind === "file") {
        return mediaSegment(part.kind, part.path);
      }
      await assertReadableLocalFile(part.path);
      return mediaSegment(part.kind, pathToFileURL(part.path).href);
  }
}

/**
 * 创建图片、语音或视频消息段。
 * OneBot 11 公共消息段不提供通用文件上传，`file` 交由后续专属操作处理。
 */
function mediaSegment(
  kind: ChannelAttachmentKind,
  file: string,
): OneBot11MessageSegment {
  if (kind === "file") {
    throw new ChannelOperationError(
      "not_supported",
      "OneBot 11 generic files require an implementation-specific upload operation",
    );
  }
  return {
    type: kind === "audio" ? "record" : kind,
    data: { file },
  };
}

/** 确认本机附件路径存在、可读且指向普通文件。 */
async function assertReadableLocalFile(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    if (!(await stat(path)).isFile()) {
      throw new Error("path is not a regular file");
    }
  } catch (error) {
    throw new ChannelOperationError(
      "invalid_target",
      "OneBot 11 local attachment is not readable",
      { cause: error },
    );
  }
}

/** 防止一个 Adapter 实例向不属于自己的 Channel 路由发送操作。 */
function assertMatchingChannel(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ChannelOperationError(
      "invalid_target",
      `Channel route ${actual} does not match OneBot instance ${expected}`,
    );
  }
}

/** 限制 OneBot Channel 通用发送只使用无 Thread 的群聊或私聊路由。 */
function assertSupportedRoute(
  conversationKind: string,
  threadId: string | undefined,
): void {
  if (
    (conversationKind !== "group" && conversationKind !== "direct") ||
    threadId !== undefined
  ) {
    throw new ChannelOperationError(
      "not_supported",
      "OneBot 11 supports only non-threaded group and direct routes",
    );
  }
}

/**
 * 将正整数 ID 转换为 OneBot 参数。
 * 安全整数使用 number，超出 JavaScript 安全范围时保留 string，避免精度丢失。
 */
function parsePositiveIdParameter(
  input: string,
  label: string,
): number | string {
  if (!/^[1-9]\d*$/u.test(input)) {
    throw new ChannelOperationError(
      "invalid_target",
      `${label} must be a positive integer string`,
    );
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : input;
}

/**
 * 将允许负数的消息 ID 转换为 OneBot 参数，并在超出安全范围时保留 string。
 */
function parseMessageIdParameter(
  input: string,
  label: string,
): number | string {
  if (!/^-?\d+$/u.test(input)) {
    throw new ChannelOperationError(
      "invalid_target",
      `${label} must be an integer string`,
    );
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : input;
}

/** 将 @ 和 reply 消息段中的 ID 参数转换为 OneBot 接受的数值形态。 */
function oneBotSegmentParameter(
  type: string,
  key: string,
  value: string,
): string | number {
  if (type === "at" && key === "qq") {
    return parseMentionTargetParameter(value);
  }
  if (type === "reply" && key === "id") {
    return parseMessageIdParameter(value, "OneBot 11 reply message ID");
  }
  return value;
}

/** OneBot 的 `at.qq` 接受正整数用户 ID，或保留值 `all`。 */
function parseMentionTargetParameter(input: string): string | number {
  if (input === "all") {
    return input;
  }
  return parsePositiveIdParameter(input, "OneBot 11 mention target ID");
}

/** 复用 Core 合同校验，并将失败统一映射为 Channel 操作错误。 */
function validateSendCommand(command: SendChannelMessageCommand): void {
  try {
    assertValidSendChannelMessageCommand(command);
  } catch (error) {
    throw new ChannelOperationError(
      "invalid_target",
      "Invalid Channel send command for OneBot 11",
      { cause: error },
    );
  }
}

/** 复用 Core 撤回合同校验，并将失败统一映射为 Channel 操作错误。 */
function validateRetractCommand(command: RetractChannelMessageCommand): void {
  try {
    assertValidRetractChannelMessageCommand(command);
  } catch (error) {
    throw new ChannelOperationError(
      "invalid_target",
      "Invalid Channel retract command for OneBot 11",
      { cause: error },
    );
  }
}

/** 将未知输入收窄为非 null、非数组的普通对象。 */
function asObject(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
