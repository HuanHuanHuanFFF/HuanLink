/**
 * Channel Contract v1 的迁移期定义。
 *
 * 当前正式运行链仍使用 `channels/types.ts` 中的 Demo 合同；本文件先让
 * OneBot Adapter 和 Server 可以分批迁移。全部调用方切换后会删除旧合同，
 * 并去掉本文件类型名中的 `V1` 后缀，不长期维护两套 Channel API。
 *
 * 本合同只表达跨平台的公共聊天语义。QQ 戳一戳、群管理等平台专属动作
 * 应由对应 Adapter 的结构化 Tool 或受控 CLI 暴露，不得塞入 Core 消息字段。
 */

/** 平台无关的会话形态；具体 Adapter 只声明自己实际支持的子集。 */
export type ChannelConversationKindV1 = "direct" | "group" | "channel";

/** v1 首批允许进入 Core 的三种有序消息 Part。 */
export type ChannelMessagePartTypeV1 =
  | "text"
  | "mention"
  | "attachmentRef";

/** 附件内容的公共类别；具体来源由远程链接或受管缓存引用表达。 */
export type ChannelAttachmentKindV1 = "image" | "audio" | "video" | "file";

/**
 * Adapter 的能力声明，不代表所有 Channel 都支持这些能力。
 *
 * Server 调用前必须检查对应能力；Adapter 也必须对未支持操作明确返回
 * `not_supported`。其中编辑、撤回、reaction、typing 和流式消息目前只有
 * 声明位，尚无对应 v1 命令或事件合同，现阶段 Adapter 不得声明为 `true`。
 */
export type ChannelCapabilitiesV1 = {
  /** 支持的私聊、群聊或频道会话形态。 */
  readonly conversationKinds: readonly ChannelConversationKindV1[];
  /** 是否支持在会话内继续按 thread 隔离。 */
  readonly threads: boolean;
  /** 能够从平台可靠映射进入 Core 的 Part 类型。 */
  readonly inboundPartTypes: readonly ChannelMessagePartTypeV1[];
  /** 能够从 Core 可靠发送到平台的 Part 类型。 */
  readonly outboundPartTypes: readonly ChannelMessagePartTypeV1[];
  /** 是否支持引用某条已有消息进行回复。 */
  readonly reply: boolean;
  /** 以下能力尚未定义执行合同，目前必须为 false。 */
  readonly edit: boolean;
  readonly retract: boolean;
  readonly reaction: boolean;
  readonly typing: boolean;
  readonly streaming: boolean;
};

/** 一个配置并运行的 Channel 实例，而不是平台类型本身。 */
export type ChannelDescriptorV1 = {
  /** 配置中的稳定实例 ID；多实例路由和 session 隔离都使用它。 */
  readonly channelId: string;
  /** 协议或平台标识，例如 `onebot11`；不能代替 channelId。 */
  readonly platform: string;
  /** Adapter 已知时提供的实际 Bot/应用账号。 */
  readonly accountId?: string;
  /** 该实例在当前配置和连接条件下实际支持的能力。 */
  readonly capabilities: ChannelCapabilitiesV1;
};

/** 可把回复稳定送回原聊天位置的规范路由。 */
export type ChannelConversationRouteV1 = {
  readonly channelId: string;
  readonly conversationKind: ChannelConversationKindV1;
  /** 平台本地群 ID、私聊 ID 或频道 ID。 */
  readonly conversationId: string;
  /** 平台支持 thread 时进一步隔离子会话。 */
  readonly threadId?: string;
};

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

/** Server 要求指定 Channel 实例发送的统一命令。 */
export type OutboundChannelCommandV1 = {
  readonly route: ChannelConversationRouteV1;
  readonly parts: readonly ChannelMessagePartV1[];
  readonly replyToMessageId?: string;
};

/** 平台确认发送成功后返回的最小稳定回执。 */
export type DeliveryReceiptV1 = {
  readonly channelId: string;
  readonly platformMessageId: string;
};

/** 跨平台稳定错误码；平台原始错误只作为受控 cause 或日志保留。 */
export type ChannelErrorCodeV1 =
  | "not_supported"
  | "rate_limited"
  | "temporarily_unavailable"
  | "authentication_failed"
  | "invalid_target"
  | "permanent_failure";

/** Channel 操作失败时交给 Server 的结构化错误。 */
export class ChannelOperationError extends Error {
  readonly code: ChannelErrorCodeV1;
  readonly retryAfterMs?: number;

  constructor(
    code: ChannelErrorCodeV1,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChannelOperationError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type ChannelMessageListenerV1 = (
  message: InboundChannelMessageV1
) => Promise<void> | void;

/**
 * Server 依赖的最小 Channel Adapter 接口。
 * 连接、鉴权、心跳、重连和平台协议映射都由具体 Adapter 内部负责。
 */
export interface ChannelAdapterV1 {
  readonly descriptor: ChannelDescriptorV1;
  /** 启动连接或事件接收；成功返回时 Adapter 已可用。 */
  start(): Promise<void>;
  /** 停止接收并释放连接及未完成的内部操作。 */
  close(): Promise<void>;
  /** 订阅规范入站消息；返回的函数用于取消订阅。 */
  onMessage(listener: ChannelMessageListenerV1): () => void;
  /** 发送规范命令，并在平台确认后返回回执。 */
  send(command: OutboundChannelCommandV1): Promise<DeliveryReceiptV1>;
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
