import { randomUUID } from "node:crypto";

import { createOneBot11SendMessageActionV1 } from "./outbound-message-v1.js";
import {
  createCanSendImageAction,
  createCanSendRecordAction,
  createDeleteMessageOperationAction,
  createGetForwardMessageAction,
  createGetFriendListAction,
  createGetGroupHonorInfoAction,
  createGetGroupInfoAction,
  createGetGroupListAction,
  createGetGroupMemberInfoAction,
  createGetGroupMemberListAction,
  createGetLoginInfoAction,
  createGetMessageAction,
  createGetStatusAction,
  createGetStrangerInfoAction,
  createGetVersionInfoAction,
  createSendLikeAction,
  createSendGroupForwardMessageAction,
  createSendPrivateForwardMessageAction,
  createSetFriendAddRequestAction,
  createSetGroupAddRequestAction,
  createSetGroupAdminAction,
  createSetGroupBanAction,
  createSetGroupCardAction,
  createSetGroupKickAction,
  createSetGroupLeaveAction,
  createSetGroupNameAction,
  createSetGroupSpecialTitleAction,
  createSetGroupWholeBanAction,
} from "./operation-actions.js";
import type {
  OneBot11CachedGroupInput,
  OneBot11CachedGroupMemberInput,
  OneBot11CachedUserInput,
  OneBot11FileUploadExtension,
  OneBot11ForwardMessageExtension,
  OneBot11ForwardMessageInput,
  OneBot11GroupHonorInput,
  OneBot11GroupInput,
  OneBot11MessageInput,
  OneBot11OperationData,
  OneBot11PrivilegedOperations,
  OneBot11SendGroupMessageInput,
  OneBot11SendGroupForwardMessageInput,
  OneBot11SendLikeInput,
  OneBot11SendPrivateMessageInput,
  OneBot11SendPrivateForwardMessageInput,
  OneBot11SetFriendAddRequestInput,
  OneBot11SetGroupAddRequestInput,
  OneBot11SetGroupAdminInput,
  OneBot11SetGroupBanInput,
  OneBot11SetGroupCardInput,
  OneBot11SetGroupKickInput,
  OneBot11SetGroupLeaveInput,
  OneBot11SetGroupNameInput,
  OneBot11SetGroupSpecialTitleInput,
  OneBot11SetGroupWholeBanInput,
  OneBot11StandardOperations,
  OneBot11UploadGroupFileInput,
  OneBot11UploadPrivateFileInput,
} from "./operation-contracts.js";
import {
  assertExactObject,
  assertExtensionAction,
  assertReadableAbsoluteFile,
  optionalString,
  parsePositiveIdParameter,
  requireNonBlankString,
} from "./operation-validation.js";
import { OneBot11OperationNotSupportedError } from "./action-errors.js";
import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";
import type { OneBot11Transport } from "./types.js";

export type OneBot11OperationsOptions = {
  /** 用于复用 Channel 出站 Parts 编码，不代表 Operations 只能操作当前会话。 */
  readonly channelId: string;
  readonly transport: OneBot11Transport;
  readonly fileUpload?: OneBot11FileUploadExtension;
  readonly forwardMessages?: OneBot11ForwardMessageExtension;
};

/**
 * OneBot 11 具名操作集合。
 *
 * `standard` 与 `privileged` 只描述后续 Tool 的权限分组；当前类不执行审批、
 * 允许范围判断或消息归属检查，也不注册进 Agent Runtime。
 */
export class OneBot11Operations {
  readonly standard: OneBot11StandardOperations;
  readonly privileged: OneBot11PrivilegedOperations;

  private readonly channelId: string;
  private readonly transport: OneBot11Transport;
  private readonly fileUpload: OneBot11FileUploadExtension | undefined;
  private readonly forwardMessagesEnabled: boolean;

  constructor(options: OneBot11OperationsOptions) {
    this.channelId = requireNonBlankString(options.channelId, "channelId");
    this.transport = options.transport;
    this.fileUpload = options.fileUpload;
    this.forwardMessagesEnabled = validateForwardMessageExtension(
      options.forwardMessages,
    );

    this.standard = Object.freeze<OneBot11StandardOperations>({
      sendGroupMessage: (input) => this.sendGroupMessage(input),
      sendPrivateMessage: (input) => this.sendPrivateMessage(input),
      sendGroupForwardMessage: (input) => this.sendGroupForwardMessage(input),
      sendPrivateForwardMessage: (input) =>
        this.sendPrivateForwardMessage(input),
      getMessage: (input) =>
        this.execute(
          createGetMessageAction(input, this.echo("get-msg")),
          `message:${input.messageId}`,
        ),
      getForwardMessage: (input) =>
        this.execute(
          createGetForwardMessageAction(input, this.echo("get-forward-msg")),
          "operation:get-forward-msg",
        ),
      getLoginInfo: () =>
        this.execute(
          createGetLoginInfoAction(this.echo("get-login-info")),
          "operation:self",
        ),
      getVersionInfo: () =>
        this.execute(
          createGetVersionInfoAction(this.echo("get-version-info")),
          "operation:self",
        ),
      getStatus: () =>
        this.execute(
          createGetStatusAction(this.echo("get-status")),
          "operation:self",
        ),
      canSendImage: () =>
        this.execute(
          createCanSendImageAction(this.echo("can-send-image")),
          "operation:self",
        ),
      canSendRecord: () =>
        this.execute(
          createCanSendRecordAction(this.echo("can-send-record")),
          "operation:self",
        ),
      getStrangerInfo: (input) =>
        this.executeUserAction(
          createGetStrangerInfoAction(input, this.echo("get-stranger-info")),
          input,
        ),
      getFriendList: () =>
        this.execute(
          createGetFriendListAction(this.echo("get-friend-list")),
          "operation:self",
        ),
      getGroupInfo: (input) =>
        this.executeGroupAction(
          createGetGroupInfoAction(input, this.echo("get-group-info")),
          input,
        ),
      getGroupList: () =>
        this.execute(
          createGetGroupListAction(this.echo("get-group-list")),
          "operation:self",
        ),
      getGroupMemberInfo: (input) =>
        this.executeGroupAction(
          createGetGroupMemberInfoAction(
            input,
            this.echo("get-group-member-info"),
          ),
          input,
        ),
      getGroupMemberList: (input) =>
        this.executeGroupAction(
          createGetGroupMemberListAction(
            input,
            this.echo("get-group-member-list"),
          ),
          input,
        ),
      getGroupHonorInfo: (input) =>
        this.executeGroupAction(
          createGetGroupHonorInfoAction(
            input,
            this.echo("get-group-honor-info"),
          ),
          input,
        ),
      sendLike: (input) =>
        this.executeUserAction(
          createSendLikeAction(input, this.echo("send-like")),
          input,
        ),
      uploadGroupFile: (input) => this.uploadGroupFile(input),
      uploadPrivateFile: (input) => this.uploadPrivateFile(input),
    });

    this.privileged = Object.freeze<OneBot11PrivilegedOperations>({
      deleteMessage: (input) =>
        this.execute(
          createDeleteMessageOperationAction(input, this.echo("delete-msg")),
          `message:${input.messageId}`,
        ),
      setGroupKick: (input) =>
        this.executeGroupAction(
          createSetGroupKickAction(input, this.echo("set-group-kick")),
          input,
        ),
      setGroupBan: (input) =>
        this.executeGroupAction(
          createSetGroupBanAction(input, this.echo("set-group-ban")),
          input,
        ),
      setGroupWholeBan: (input) =>
        this.executeGroupAction(
          createSetGroupWholeBanAction(input, this.echo("set-group-whole-ban")),
          input,
        ),
      setGroupAdmin: (input) =>
        this.executeGroupAction(
          createSetGroupAdminAction(input, this.echo("set-group-admin")),
          input,
        ),
      setGroupCard: (input) =>
        this.executeGroupAction(
          createSetGroupCardAction(input, this.echo("set-group-card")),
          input,
        ),
      setGroupName: (input) =>
        this.executeGroupAction(
          createSetGroupNameAction(input, this.echo("set-group-name")),
          input,
        ),
      setGroupLeave: (input) =>
        this.executeGroupAction(
          createSetGroupLeaveAction(input, this.echo("set-group-leave")),
          input,
        ),
      setGroupSpecialTitle: (input) =>
        this.executeGroupAction(
          createSetGroupSpecialTitleAction(
            input,
            this.echo("set-group-special-title"),
          ),
          input,
        ),
      setFriendAddRequest: (input) =>
        this.execute(
          createSetFriendAddRequestAction(
            input,
            this.echo("set-friend-add-request"),
          ),
          "operation:friend-request",
        ),
      setGroupAddRequest: (input) =>
        this.execute(
          createSetGroupAddRequestAction(
            input,
            this.echo("set-group-add-request"),
          ),
          "operation:group-request",
        ),
    });
  }

  /** 跨群发送仍复用 Channel Parts 编码，但目标由具名 OneBot 操作显式提供。 */
  private async sendGroupMessage(
    input: OneBot11SendGroupMessageInput,
  ): Promise<OneBot11OperationData> {
    assertExactObject(
      input,
      ["groupId", "parts", "replyToMessageId"],
      "sendGroupMessage input",
    );
    const action = await createOneBot11SendMessageActionV1(
      {
        route: {
          channelId: this.channelId,
          conversationKind: "group",
          conversationId: input.groupId,
        },
        parts: input.parts,
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: input.replyToMessageId }),
      },
      this.channelId,
      this.echo("send-group-msg"),
    );
    return this.execute(action, input.groupId);
  }

  /** 跨私聊发送与群发送使用相同的受控 Parts，不接受原始 Action。 */
  private async sendPrivateMessage(
    input: OneBot11SendPrivateMessageInput,
  ): Promise<OneBot11OperationData> {
    assertExactObject(
      input,
      ["userId", "parts", "replyToMessageId"],
      "sendPrivateMessage input",
    );
    const action = await createOneBot11SendMessageActionV1(
      {
        route: {
          channelId: this.channelId,
          conversationKind: "direct",
          conversationId: input.userId,
        },
        parts: input.parts,
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: input.replyToMessageId }),
      },
      this.channelId,
      this.echo("send-private-msg"),
    );
    return this.execute(action, input.userId);
  }

  private async sendGroupForwardMessage(
    input: OneBot11SendGroupForwardMessageInput,
  ): Promise<OneBot11OperationData> {
    if (!this.forwardMessagesEnabled) {
      throw new OneBot11OperationNotSupportedError("sendGroupForwardMessage");
    }
    return await this.executeGroupAction(
      createSendGroupForwardMessageAction(
        input,
        this.echo("send-group-forward-msg"),
      ),
      input,
    );
  }

  private async sendPrivateForwardMessage(
    input: OneBot11SendPrivateForwardMessageInput,
  ): Promise<OneBot11OperationData> {
    if (!this.forwardMessagesEnabled) {
      throw new OneBot11OperationNotSupportedError("sendPrivateForwardMessage");
    }
    return await this.executeUserAction(
      createSendPrivateForwardMessageAction(
        input,
        this.echo("send-private-forward-msg"),
      ),
      input,
    );
  }

  /** 只有显式注入群文件 Action 工厂时才允许上传本机普通文件。 */
  private async uploadGroupFile(
    input: OneBot11UploadGroupFileInput,
  ): Promise<OneBot11OperationData> {
    const factory = this.fileUpload?.createUploadGroupFileAction;
    if (factory === undefined) {
      throw new OneBot11OperationNotSupportedError("uploadGroupFile");
    }
    const validated = await this.validateGroupUpload(input);
    const echo = this.echo("upload-group-file");
    const action = factory(validated, echo);
    assertExtensionAction(action, echo);
    return this.execute(action, validated.groupId);
  }

  /** 只有显式注入私聊文件 Action 工厂时才允许上传本机普通文件。 */
  private async uploadPrivateFile(
    input: OneBot11UploadPrivateFileInput,
  ): Promise<OneBot11OperationData> {
    const factory = this.fileUpload?.createUploadPrivateFileAction;
    if (factory === undefined) {
      throw new OneBot11OperationNotSupportedError("uploadPrivateFile");
    }
    const validated = await this.validatePrivateUpload(input);
    const echo = this.echo("upload-private-file");
    const action = factory(validated, echo);
    assertExtensionAction(action, echo);
    return this.execute(action, validated.userId);
  }

  private async validateGroupUpload(
    input: OneBot11UploadGroupFileInput,
  ): Promise<OneBot11UploadGroupFileInput> {
    const raw = assertExactObject(
      input,
      ["groupId", "path", "name"],
      "uploadGroupFile input",
    );
    parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID");
    const path = await assertReadableAbsoluteFile(raw.path);
    const name = optionalString(raw.name, "OneBot 11 upload name");
    return {
      groupId: raw.groupId as string,
      path,
      ...(name === undefined ? {} : { name }),
    };
  }

  private async validatePrivateUpload(
    input: OneBot11UploadPrivateFileInput,
  ): Promise<OneBot11UploadPrivateFileInput> {
    const raw = assertExactObject(
      input,
      ["userId", "path", "name"],
      "uploadPrivateFile input",
    );
    parsePositiveIdParameter(raw.userId, "OneBot 11 user ID");
    const path = await assertReadableAbsoluteFile(raw.path);
    const name = optionalString(raw.name, "OneBot 11 upload name");
    return {
      userId: raw.userId as string,
      path,
      ...(name === undefined ? {} : { name }),
    };
  }

  private executeGroupAction(
    action: OneBot11Action,
    input:
      | OneBot11CachedGroupInput
      | OneBot11CachedGroupMemberInput
      | OneBot11GroupHonorInput
      | OneBot11GroupInput
      | OneBot11SetGroupAdminInput
      | OneBot11SetGroupBanInput
      | OneBot11SetGroupCardInput
      | OneBot11SetGroupKickInput
      | OneBot11SetGroupLeaveInput
      | OneBot11SetGroupNameInput
      | OneBot11SetGroupSpecialTitleInput
      | OneBot11SetGroupWholeBanInput,
  ): Promise<OneBot11OperationData> {
    return this.execute(action, input.groupId);
  }

  private executeUserAction(
    action: OneBot11Action,
    input:
      | OneBot11CachedUserInput
      | OneBot11SendLikeInput
      | OneBot11SendPrivateForwardMessageInput,
  ): Promise<OneBot11OperationData> {
    return this.execute(action, input.userId);
  }

  /** 直接返回响应中的同一个 `data` 值；失败由 Transport 原样抛出。 */
  private async execute(
    action: OneBot11Action,
    conversationId: string,
  ): Promise<OneBot11OperationData> {
    const response: OneBot11JsonObject = await this.transport.sendAction(
      action,
      { conversationId },
    );
    return response.data;
  }

  private echo(operation: string): string {
    return `${operation}:${randomUUID()}`;
  }
}

function validateForwardMessageExtension(
  input: OneBot11ForwardMessageExtension | undefined,
): boolean {
  if (input === undefined) {
    return false;
  }
  const extension = assertExactObject(
    input,
    ["protocol"],
    "OneBot 11 forward-message extension",
  );
  if (extension.protocol !== "go-cqhttp-compatible") {
    throw new TypeError(
      "OneBot 11 forward-message extension protocol must be go-cqhttp-compatible",
    );
  }
  return true;
}
