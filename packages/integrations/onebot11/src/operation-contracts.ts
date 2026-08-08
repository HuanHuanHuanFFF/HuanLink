import type { ChannelOutboundMessagePartV1 } from "@huanlink/core";

import type { OneBot11Action } from "./codec.js";

/** OneBot 成功响应中的原始 `data`；集成层不改名、裁剪或归一化。 */
export type OneBot11OperationData = unknown;

export type OneBot11SendGroupMessageInput = {
  readonly groupId: string;
  readonly parts: readonly ChannelOutboundMessagePartV1[];
  readonly replyToMessageId?: string;
};

export type OneBot11SendPrivateMessageInput = {
  readonly userId: string;
  readonly parts: readonly ChannelOutboundMessagePartV1[];
  readonly replyToMessageId?: string;
};

/** 直接引用一条已有消息作为合并转发节点。 */
export type OneBot11ForwardReferenceNode = {
  readonly kind: "reference";
  readonly messageId: string;
};

/** 使用指定显示身份和 OneBot CQ 内容构造一个合并转发节点。 */
export type OneBot11ForwardCustomNode = {
  readonly kind: "custom";
  readonly userId: string;
  readonly displayName: string;
  readonly content: string;
};

export type OneBot11ForwardNode =
  | OneBot11ForwardReferenceNode
  | OneBot11ForwardCustomNode;

export type OneBot11SendGroupForwardMessageInput = {
  readonly groupId: string;
  readonly nodes: readonly OneBot11ForwardNode[];
};

export type OneBot11SendPrivateForwardMessageInput = {
  readonly userId: string;
  readonly nodes: readonly OneBot11ForwardNode[];
};

export type OneBot11MessageInput = {
  readonly messageId: string;
};

export type OneBot11ForwardMessageInput = {
  readonly messageId: string;
};

export type OneBot11UserInput = {
  readonly userId: string;
};

export type OneBot11CachedUserInput = OneBot11UserInput & {
  readonly noCache?: boolean;
};

export type OneBot11GroupInput = {
  readonly groupId: string;
};

export type OneBot11CachedGroupInput = OneBot11GroupInput & {
  readonly noCache?: boolean;
};

export type OneBot11GroupMemberInput = OneBot11GroupInput & OneBot11UserInput;

export type OneBot11CachedGroupMemberInput = OneBot11GroupMemberInput & {
  readonly noCache?: boolean;
};

export type OneBot11GroupHonorType =
  | "talkative"
  | "performer"
  | "legend"
  | "strong_newbie"
  | "emotion"
  | "all";

export type OneBot11GroupHonorInput = OneBot11GroupInput & {
  readonly type: OneBot11GroupHonorType;
};

export type OneBot11SendLikeInput = OneBot11UserInput & {
  readonly times?: number;
};

export type OneBot11UploadGroupFileInput = OneBot11GroupInput & {
  readonly path: string;
  readonly name?: string;
};

export type OneBot11UploadPrivateFileInput = OneBot11UserInput & {
  readonly path: string;
  readonly name?: string;
};

export type OneBot11SetGroupKickInput = OneBot11GroupMemberInput & {
  readonly rejectAddRequest?: boolean;
};

export type OneBot11SetGroupBanInput = OneBot11GroupMemberInput & {
  /** 禁言秒数；`0` 表示取消禁言。 */
  readonly durationSeconds: number;
};

export type OneBot11SetGroupWholeBanInput = OneBot11GroupInput & {
  readonly enabled: boolean;
};

export type OneBot11SetGroupAdminInput = OneBot11GroupMemberInput & {
  readonly enabled: boolean;
};

export type OneBot11SetGroupCardInput = OneBot11GroupMemberInput & {
  /** 空字符串表示删除群名片。 */
  readonly card: string;
};

export type OneBot11SetGroupNameInput = OneBot11GroupInput & {
  readonly name: string;
};

export type OneBot11SetGroupLeaveInput = OneBot11GroupInput & {
  readonly dismiss?: boolean;
};

export type OneBot11SetGroupSpecialTitleInput = OneBot11GroupMemberInput & {
  /** 空字符串表示删除专属头衔。 */
  readonly title: string;
  /** `-1` 表示永久，非负整数表示秒数。 */
  readonly durationSeconds?: number;
};

export type OneBot11SetFriendAddRequestInput = {
  readonly flag: string;
  readonly approve: boolean;
  readonly remark?: string;
};

export type OneBot11GroupRequestType = "add" | "invite";

export type OneBot11SetGroupAddRequestInput = {
  readonly flag: string;
  readonly subType: OneBot11GroupRequestType;
  readonly approve: boolean;
  readonly reason?: string;
};

/** 后续 `onebot_standard` Tool 只能调用这一组普通操作。 */
export interface OneBot11StandardOperations {
  sendGroupMessage(
    input: OneBot11SendGroupMessageInput,
  ): Promise<OneBot11OperationData>;
  sendPrivateMessage(
    input: OneBot11SendPrivateMessageInput,
  ): Promise<OneBot11OperationData>;
  sendGroupForwardMessage(
    input: OneBot11SendGroupForwardMessageInput,
  ): Promise<OneBot11OperationData>;
  sendPrivateForwardMessage(
    input: OneBot11SendPrivateForwardMessageInput,
  ): Promise<OneBot11OperationData>;
  getMessage(input: OneBot11MessageInput): Promise<OneBot11OperationData>;
  getForwardMessage(
    input: OneBot11ForwardMessageInput,
  ): Promise<OneBot11OperationData>;
  getLoginInfo(): Promise<OneBot11OperationData>;
  getVersionInfo(): Promise<OneBot11OperationData>;
  getStatus(): Promise<OneBot11OperationData>;
  canSendImage(): Promise<OneBot11OperationData>;
  canSendRecord(): Promise<OneBot11OperationData>;
  getStrangerInfo(
    input: OneBot11CachedUserInput,
  ): Promise<OneBot11OperationData>;
  getFriendList(): Promise<OneBot11OperationData>;
  getGroupInfo(input: OneBot11CachedGroupInput): Promise<OneBot11OperationData>;
  getGroupList(): Promise<OneBot11OperationData>;
  getGroupMemberInfo(
    input: OneBot11CachedGroupMemberInput,
  ): Promise<OneBot11OperationData>;
  getGroupMemberList(input: OneBot11GroupInput): Promise<OneBot11OperationData>;
  getGroupHonorInfo(
    input: OneBot11GroupHonorInput,
  ): Promise<OneBot11OperationData>;
  sendLike(input: OneBot11SendLikeInput): Promise<OneBot11OperationData>;
  uploadGroupFile(
    input: OneBot11UploadGroupFileInput,
  ): Promise<OneBot11OperationData>;
  uploadPrivateFile(
    input: OneBot11UploadPrivateFileInput,
  ): Promise<OneBot11OperationData>;
}

/** 后续 `onebot_privileged` Tool 统一对这一组操作申请审批。 */
export interface OneBot11PrivilegedOperations {
  deleteMessage(input: OneBot11MessageInput): Promise<OneBot11OperationData>;
  setGroupKick(
    input: OneBot11SetGroupKickInput,
  ): Promise<OneBot11OperationData>;
  setGroupBan(input: OneBot11SetGroupBanInput): Promise<OneBot11OperationData>;
  setGroupWholeBan(
    input: OneBot11SetGroupWholeBanInput,
  ): Promise<OneBot11OperationData>;
  setGroupAdmin(
    input: OneBot11SetGroupAdminInput,
  ): Promise<OneBot11OperationData>;
  setGroupCard(
    input: OneBot11SetGroupCardInput,
  ): Promise<OneBot11OperationData>;
  setGroupName(
    input: OneBot11SetGroupNameInput,
  ): Promise<OneBot11OperationData>;
  setGroupLeave(
    input: OneBot11SetGroupLeaveInput,
  ): Promise<OneBot11OperationData>;
  setGroupSpecialTitle(
    input: OneBot11SetGroupSpecialTitleInput,
  ): Promise<OneBot11OperationData>;
  setFriendAddRequest(
    input: OneBot11SetFriendAddRequestInput,
  ): Promise<OneBot11OperationData>;
  setGroupAddRequest(
    input: OneBot11SetGroupAddRequestInput,
  ): Promise<OneBot11OperationData>;
}

/**
 * OneBot 11 标准没有统一文件上传 Action；具体实现只能显式注入已知工厂。
 * 工厂接收经过公共校验的输入，不会被上层用于发送任意 Action。
 */
export interface OneBot11FileUploadExtension {
  createUploadGroupFileAction?(
    input: OneBot11UploadGroupFileInput,
    echo: string,
  ): OneBot11Action;
  createUploadPrivateFileAction?(
    input: OneBot11UploadPrivateFileInput,
    echo: string,
  ): OneBot11Action;
}

/**
 * 显式启用 NapCat/go-cqhttp 兼容的合并转发 Action。
 * 该标记不会根据实现名称自动开启，也不允许调用方提供任意 Action 名。
 */
export type OneBot11ForwardMessageExtension = {
  readonly protocol: "go-cqhttp-compatible";
};
