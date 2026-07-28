import { Buffer } from "node:buffer";
import { posix, win32 } from "node:path";

import type { RetractChannelMessageCommandV1 } from "./channel-adapter-v1.js";
import {
  CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1,
  CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
  type ChannelOutboundAttachmentLinkPartV1,
  type ChannelOutboundAttachmentLocalPathPartV1,
  type ChannelOutboundMessagePartV1,
  type InboundChannelMessageV1
} from "./channel-message-v1.js";

/** 在调用平台前拒绝缺失或非法的撤回消息 ID。 */
export function assertValidRetractChannelMessageCommand(
  command: RetractChannelMessageCommandV1
): void {
  if (typeof command !== "object" || command === null) {
    throw new Error("Channel retract command must be an object");
  }

  const rawCommand = command as unknown as Record<string, unknown>;
  requireNonEmptyString(
    rawCommand.messageId as string,
    "Channel retract messageId"
  );
}

/** 在入站消息进入 session 前校验字符串边界和基础元数据。 */
export function assertValidInboundChannelMessage(
  message: InboundChannelMessageV1
): void {
  if (typeof message !== "object" || message === null) {
    throw new Error("Inbound Channel message must be an object");
  }

  const rawMessage = message as unknown as Record<string, unknown>;
  requireNonEmptyString(rawMessage.messageId, "Inbound Channel messageId");
  requireNonEmptyString(rawMessage.receivedAt, "Inbound Channel receivedAt");
  requireNonEmptyString(
    rawMessage.contentFormat,
    "Inbound Channel contentFormat"
  );

  validateSender(rawMessage.sender);
  validateOptionalString(
    rawMessage.replyToMessageId,
    "Inbound Channel replyToMessageId"
  );
  validateTrigger(rawMessage.trigger);

  if (rawMessage.contentOmitted === undefined) {
    requireNonEmptyContentString(
      rawMessage.content,
      "Inbound Channel content"
    );
    const sizeBytes = Buffer.byteLength(rawMessage.content, "utf8");
    if (sizeBytes > CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1) {
      throw new Error(
        `Inbound Channel content must not exceed ${CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1} UTF-8 bytes`
      );
    }
    return;
  }

  validateOmittedContent(rawMessage.content, rawMessage.contentOmitted);
}

/**
 * 在 Server 调用 Adapter 前校验出站 Part。
 * 该函数只检查结构、URL 和路径边界，不发起网络或文件访问。
 */
export function assertValidOutboundChannelMessageParts(
  parts: readonly ChannelOutboundMessagePartV1[]
): void {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Outbound Channel message parts must be a non-empty array");
  }

  for (const part of parts) {
    if (typeof part !== "object" || part === null) {
      throw new Error("Outbound Channel message part must be an object");
    }

    switch (part.type) {
      case "text":
        assertOnlyKeys(
          part as unknown as Record<string, unknown>,
          ["type", "text"],
          "Outbound Channel text part"
        );
        requireNonEmptyString(part.text, "Outbound Channel text part text");
        break;
      case "mention":
        assertOnlyKeys(
          part as unknown as Record<string, unknown>,
          ["type", "targetId", "displayName"],
          "Outbound Channel mention part"
        );
        requireNonEmptyString(
          part.targetId,
          "Outbound Channel mention targetId"
        );
        validateOptionalString(
          part.displayName,
          "Outbound Channel mention displayName"
        );
        break;
      case "attachmentLink":
        validateAttachmentLink(part);
        break;
      case "attachmentLocalPath":
        validateAttachmentLocalPath(part);
        break;
      default:
        throw new Error("Unsupported outbound Channel message part type");
    }
  }
}

function validateSender(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("Inbound Channel sender must be an object");
  }

  const sender = value as Record<string, unknown>;
  assertOnlyKeys(
    sender,
    ["id", "username", "displayName"],
    "Inbound Channel sender"
  );
  requireNonEmptyString(sender.id, "Inbound Channel sender id");
  requireNonEmptyString(sender.username, "Inbound Channel sender username");
  validateOptionalString(
    sender.displayName,
    "Inbound Channel sender displayName"
  );
}

function validateTrigger(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Inbound Channel trigger must be an object");
  }

  const trigger = value as Record<string, unknown>;
  assertOnlyKeys(trigger, ["kind"], "Inbound Channel trigger");
  if (trigger.kind !== "mention" && trigger.kind !== "command") {
    throw new Error("Inbound Channel trigger kind is unsupported");
  }
}

function validateOmittedContent(content: unknown, value: unknown): void {
  if (
    content !== CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1 ||
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error("Inbound Channel omitted content must use the fixed placeholder");
  }

  const omitted = value as Record<string, unknown>;
  assertOnlyKeys(
    omitted,
    ["reason", "originalSizeBytes"],
    "Inbound Channel omitted content"
  );
  if (omitted.reason !== "too_large") {
    throw new Error("Inbound Channel omitted content reason must be too_large");
  }
  if (
    !Number.isSafeInteger(omitted.originalSizeBytes) ||
    (omitted.originalSizeBytes as number) <=
      CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1
  ) {
    throw new Error(
      `Inbound Channel omitted content originalSizeBytes must exceed ${CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1}`
    );
  }
}

function validateAttachmentLink(
  part: ChannelOutboundAttachmentLinkPartV1
): void {
  const rawPart = part as unknown as Record<string, unknown>;
  assertOnlyKeys(
    rawPart,
    ["type", "kind", "url", "name", "mimeType"],
    "Outbound Channel attachment link"
  );

  if (!["image", "audio", "video", "file"].includes(part.kind)) {
    throw new Error("Unsupported outbound Channel attachment kind");
  }

  validateOptionalString(part.name, "Channel attachment name");
  validateOptionalString(part.mimeType, "Channel attachment mimeType");
  requireNonEmptyString(part.url, "Channel attachment URL");

  let url: URL;
  try {
    url = new URL(part.url);
  } catch {
    throw new Error("Channel attachment URL must be an HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Channel attachment URL must be an HTTP(S) URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Channel attachment URL must not include credentials");
  }
}

function validateAttachmentLocalPath(
  part: ChannelOutboundAttachmentLocalPathPartV1
): void {
  const rawPart = part as unknown as Record<string, unknown>;
  assertOnlyKeys(
    rawPart,
    ["type", "kind", "path", "name", "mimeType"],
    "Outbound Channel local attachment"
  );

  if (!["image", "audio", "video", "file"].includes(part.kind)) {
    throw new Error("Unsupported outbound Channel attachment kind");
  }

  validateOptionalString(part.name, "Channel attachment name");
  validateOptionalString(part.mimeType, "Channel attachment mimeType");
  requireNonEmptyString(part.path, "Channel attachment local path");
  if (!win32.isAbsolute(part.path) && !posix.isAbsolute(part.path)) {
    throw new Error("Channel attachment local path must be absolute");
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field ${key}`);
    }
  }
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined) {
    requireNonEmptyString(value, label);
  }
}

function requireNonEmptyContentString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
