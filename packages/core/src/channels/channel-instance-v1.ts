/** 平台无关的会话形态；具体 Adapter 只声明自己实际支持的子集。 */
export type ChannelConversationKindV1 = "direct" | "group" | "channel";

/** v1 首批允许进入 Core 的三种有序消息 Part。 */
export type ChannelMessagePartTypeV1 =
  | "text"
  | "mention"
  | "attachmentRef";

/**
 * Adapter 的能力声明，不代表所有 Channel 都支持这些能力。
 *
 * Server 调用前必须检查对应能力；Adapter 也必须对未支持操作明确返回
 * `not_supported`。撤回已经具有可执行合同；编辑、reaction、typing 和
 * 流式消息目前只有声明位，尚无对应 v1 命令或事件合同。
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
  readonly edit: boolean;
  /** 当前 Channel 实例是否支持主动撤回消息。 */
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
