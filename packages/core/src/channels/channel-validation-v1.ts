import type { RetractChannelMessageCommandV1 } from "./channel-adapter-v1.js";
import type {
  ChannelAttachmentRefPartV1,
  ChannelAttachmentSourceV1,
  ChannelMessagePartV1
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

/**
 * 在消息进入 Core 或离开 Server 前校验 Part 边界。
 * 该函数只检查结构、URL 协议和不透明缓存 ID，不发起网络或文件访问。
 */
export function assertValidChannelMessageParts(
  parts: readonly ChannelMessagePartV1[]
): void {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Channel message parts must be a non-empty array");
  }

  for (const part of parts) {
    if (typeof part !== "object" || part === null) {
      throw new Error("Channel message part must be an object");
    }

    switch (part.type) {
      case "text":
        requireNonEmptyString(part.text, "Channel text part text");
        break;
      case "mention":
        requireNonEmptyString(part.targetId, "Channel mention targetId");
        validateOptionalString(part.displayName, "Channel mention displayName");
        break;
      case "attachmentRef":
        validateAttachmentRef(part);
        break;
      default:
        throw new Error("Unsupported Channel message part type");
    }
  }
}

function validateAttachmentRef(part: ChannelAttachmentRefPartV1): void {
  const rawPart = part as unknown as Record<string, unknown>;
  if ("path" in rawPart) {
    throw new Error("Channel attachment reference must not include a raw path");
  }
  assertOnlyKeys(
    rawPart,
    ["type", "kind", "source", "name", "mimeType", "sizeBytes"],
    "Channel attachment reference"
  );

  if (!["image", "audio", "video", "file"].includes(part.kind)) {
    throw new Error("Unsupported Channel attachment kind");
  }

  validateAttachmentSource(part.source);

  validateOptionalString(part.name, "Channel attachment name");
  validateOptionalString(part.mimeType, "Channel attachment mimeType");
  if (
    part.sizeBytes !== undefined &&
    (!Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 0)
  ) {
    throw new Error("Channel attachment sizeBytes must be a non-negative safe integer");
  }
}

function validateAttachmentSource(source: ChannelAttachmentSourceV1): void {
  if (typeof source !== "object" || source === null) {
    throw new Error("Channel attachment source must be an object");
  }

  const rawSource = source as unknown as Record<string, unknown>;
  if ("path" in rawSource) {
    throw new Error("Channel attachment source must not include a raw path");
  }

  switch (source.type) {
    case "remoteUrl":
      assertOnlyKeys(rawSource, ["type", "url"], "Remote attachment source");
      validateRemoteAttachmentUrl(source.url);
      break;
    case "localCache":
      assertOnlyKeys(
        rawSource,
        ["type", "attachmentId"],
        "Local cache attachment source"
      );
      validateManagedAttachmentId(source.attachmentId);
      break;
    default:
      throw new Error("Unsupported Channel attachment source type");
  }
}

function validateRemoteAttachmentUrl(value: string): void {
  requireNonEmptyString(value, "Channel attachment URL");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Channel attachment URL must be an HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Channel attachment URL must be an HTTP(S) URL");
  }
}

function validateManagedAttachmentId(value: string): void {
  requireNonEmptyString(value, "Channel managed attachment ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("Channel local cache source must use a stable attachment ID");
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

function validateOptionalString(value: string | undefined, label: string): void {
  if (value !== undefined) {
    requireNonEmptyString(value, label);
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
