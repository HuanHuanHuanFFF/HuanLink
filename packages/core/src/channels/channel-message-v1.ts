import type { ChannelConversationRouteV1 } from "./channel-instance-v1.js";

/** 附件内容的公共类别。 */
export type ChannelAttachmentKindV1 = "image" | "audio" | "video" | "file";

/**
 * 平台内的发送者身份；它不代表 HuanLink 权限或跨平台用户身份。
 *
 * `username` 是 Adapter 规范化后的平台账户基础名称，必须提供；平台没有
 * 可用名称时回退为 `id`，不能因此丢弃消息。`displayName` 是当前会话内的
 * 可选显示名称，例如 OneBot 群名片 `sender.card`，不与 username 重复填充。
 */
export type ChannelSenderIdentityV1 = {
  /** 平台内稳定 ID，例如 OneBot `user_id`。 */
  readonly id: string;
  /** 平台账户基础名称，例如 OneBot `sender.nickname`。 */
  readonly username: string;
  /** 当前会话特有的备注、群名片或群昵称；没有时省略。 */
  readonly displayName?: string;
};

/** Server 主动发给 Channel 的文本内容。 */
export type ChannelOutboundTextPartV1 = {
  readonly type: "text";
  readonly text: string;
};

/** Server 主动发给 Channel 的平台用户或 Bot 提及。 */
export type ChannelOutboundMentionPartV1 = {
  readonly type: "mention";
  readonly targetId: string;
  readonly displayName?: string;
};

/**
 * Server 主动发给 Channel 的 HTTP(S) 附件链接。
 *
 * `attachmentLink` 不接受本地路径、Base64 或原始字节，也不要求
 * Adapter 下载附件。
 */
export type ChannelOutboundAttachmentLinkPartV1 = {
  readonly type: "attachmentLink";
  readonly kind: ChannelAttachmentKindV1;
  readonly url: string;
  readonly name?: string;
  readonly mimeType?: string;
};

/**
 * Server 主动发给 Channel 的本机附件。
 *
 * `path` 是 HuanLink/Adapter 所在机器可读取的绝对路径。合同不读取或复制
 * 文件；Adapter 在实际发送时负责检查文件并映射为平台上传操作。
 */
export type ChannelOutboundAttachmentLocalPathPartV1 = {
  readonly type: "attachmentLocalPath";
  readonly kind: ChannelAttachmentKindV1;
  readonly path: string;
  readonly name?: string;
  readonly mimeType?: string;
};

/** 出站消息由这些 Part 按数组顺序组成。 */
export type ChannelOutboundMessagePartV1 =
  | ChannelOutboundTextPartV1
  | ChannelOutboundMentionPartV1
  | ChannelOutboundAttachmentLinkPartV1
  | ChannelOutboundAttachmentLocalPathPartV1;

/** Adapter 已规范化的触发事实，而不是权限或授权。 */
export type ChannelTriggerV1 = {
  readonly kind: "mention" | "command";
};

/** 入站内容完整保留时允许的 UTF-8 字节数。 */
export const CHANNEL_INBOUND_CONTENT_MAX_BYTES_V1 = 8 * 1024;

/** 入站内容超限时转发到 session 的固定占位文本。 */
export const CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1 =
  "[HuanLink: inbound content omitted because it exceeds 8192 bytes]";

/** 原始入站内容因超过合同上限而未进入 session。 */
export type ChannelContentOmittedV1 = {
  readonly reason: "too_large";
  readonly originalSizeBytes: number;
};

/**
 * Adapter 交给 Server 的入站消息。
 *
 * `content` 是 Adapter 生成的平台格式字符串，Core 不解析或清理其内容。
 * OneBot Adapter 使用 `onebot11.cq` 并保留完整 CQ 字符串。
 */
export type InboundChannelMessageV1 = {
  readonly messageId: string;
  readonly route: ChannelConversationRouteV1;
  readonly sender: ChannelSenderIdentityV1;
  readonly receivedAt: string;
  readonly content: string;
  readonly contentFormat: string;
  readonly contentOmitted?: ChannelContentOmittedV1;
  readonly replyToMessageId?: string;
  readonly trigger?: ChannelTriggerV1;
};
