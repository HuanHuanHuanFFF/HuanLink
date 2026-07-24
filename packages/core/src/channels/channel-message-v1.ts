import type { ChannelConversationRouteV1 } from "./channel-instance-v1.js";

/** 附件内容的公共类别；具体来源由远程链接或受管缓存引用表达。 */
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

/** 保留原始顺序的文本内容。 */
export type ChannelTextPartV1 = {
  readonly type: "text";
  readonly text: string;
};

/** 对平台内用户或 Bot 的提及。 */
export type ChannelMentionPartV1 = {
  readonly type: "mention";
  readonly targetId: string;
  readonly displayName?: string;
};

/** 可由本机或远程 Agent 自行获取的 HTTP(S) 附件。 */
export type ChannelRemoteUrlAttachmentSourceV1 = {
  readonly type: "remoteUrl";
  readonly url: string;
};

/**
 * HuanLink AttachmentStore 已接管的本地附件。
 *
 * `attachmentId` 是 Store 签发的不透明稳定 ID，不是文件名或路径。Core
 * 合同不会暴露缓存目录；需要读取内容的本机组件必须通过受控 resolver 解析。
 */
export type ChannelLocalCacheAttachmentSourceV1 = {
  readonly type: "localCache";
  readonly attachmentId: string;
};

export type ChannelAttachmentSourceV1 =
  | ChannelRemoteUrlAttachmentSourceV1
  | ChannelLocalCacheAttachmentSourceV1;

/**
 * 附件引用。Adapter 可以接收平台提供的本地路径，但必须先把文件导入
 * AttachmentStore，再以 HuanLink 受管缓存 ID 进入本合同；合同本身不携带
 * 原始本地路径。远程附件使用 HTTP(S) 链接，`file://`、Base64 和原始字节
 * 也不能作为跨平台消息字段。
 */
export type ChannelAttachmentRefPartV1 = {
  readonly type: "attachmentRef";
  readonly kind: ChannelAttachmentKindV1;
  readonly source: ChannelAttachmentSourceV1;
  readonly name?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
};

/** 消息由这些 Part 按数组顺序组成，不提供平台原始消息段逃生口。 */
export type ChannelMessagePartV1 =
  | ChannelTextPartV1
  | ChannelMentionPartV1
  | ChannelAttachmentRefPartV1;

/** Adapter 已规范化的触发事实，而不是权限或授权。 */
export type ChannelTriggerV1 = {
  readonly kind: "mention" | "command";
  readonly text: string;
};

/** Adapter 交给 Server 的平台无关入站消息。 */
export type InboundChannelMessageV1 = {
  readonly messageId: string;
  readonly route: ChannelConversationRouteV1;
  readonly sender: ChannelSenderIdentityV1;
  readonly receivedAt: string;
  readonly parts: readonly ChannelMessagePartV1[];
  readonly replyToMessageId?: string;
  readonly trigger?: ChannelTriggerV1;
};
