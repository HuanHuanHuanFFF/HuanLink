import type {
  OneBot11Action,
  OneBot11ActionContext,
  OneBot11EventListener,
  OneBot11JsonObject,
  OneBot11Transport,
} from "../src/index.js";
import {
  OneBot11ChannelAdapterV1,
  OneBot11DeliveryUncertainError,
  OneBot11OperationNotSupportedError,
  OneBot11Operations,
} from "../src/index.js";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

class FakeOneBot11Transport implements OneBot11Transport {
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly calls: Array<{
    action: OneBot11Action;
    context: OneBot11ActionContext;
  }> = [];
  readonly responseData: unknown;

  constructor(responseData: unknown = { implementation: "raw" }) {
    this.responseData = responseData;
  }

  onEvent(_listener: OneBot11EventListener): () => void {
    return () => undefined;
  }

  async sendAction(
    action: OneBot11Action,
    context: OneBot11ActionContext,
  ): Promise<OneBot11JsonObject> {
    this.calls.push({ action, context });
    return {
      status: "ok",
      retcode: 0,
      data: this.responseData,
      echo: action.echo,
    };
  }
}

type OperationCase = {
  name: string;
  invoke: (operations: OneBot11Operations) => Promise<unknown>;
  action: string;
  params: OneBot11JsonObject;
  conversationId: string;
};

const OPERATION_CASES: readonly OperationCase[] = [
  {
    name: "getMessage",
    invoke: (operations) =>
      operations.standard.getMessage({ messageId: "-12" }),
    action: "get_msg",
    params: { message_id: -12 },
    conversationId: "message:-12",
  },
  {
    name: "getForwardMessage",
    invoke: (operations) =>
      operations.standard.getForwardMessage({ messageId: "forward-1" }),
    action: "get_forward_msg",
    params: { message_id: "forward-1" },
    conversationId: "operation:get-forward-msg",
  },
  {
    name: "getLoginInfo",
    invoke: (operations) => operations.standard.getLoginInfo(),
    action: "get_login_info",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "getVersionInfo",
    invoke: (operations) => operations.standard.getVersionInfo(),
    action: "get_version_info",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "getStatus",
    invoke: (operations) => operations.standard.getStatus(),
    action: "get_status",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "canSendImage",
    invoke: (operations) => operations.standard.canSendImage(),
    action: "can_send_image",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "canSendRecord",
    invoke: (operations) => operations.standard.canSendRecord(),
    action: "can_send_record",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "getStrangerInfo",
    invoke: (operations) =>
      operations.standard.getStrangerInfo({
        userId: "10001",
        noCache: true,
      }),
    action: "get_stranger_info",
    params: { user_id: 10001, no_cache: true },
    conversationId: "10001",
  },
  {
    name: "getFriendList",
    invoke: (operations) => operations.standard.getFriendList(),
    action: "get_friend_list",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "getGroupInfo",
    invoke: (operations) =>
      operations.standard.getGroupInfo({ groupId: "20002" }),
    action: "get_group_info",
    params: { group_id: 20002, no_cache: false },
    conversationId: "20002",
  },
  {
    name: "getGroupList",
    invoke: (operations) => operations.standard.getGroupList(),
    action: "get_group_list",
    params: {},
    conversationId: "operation:self",
  },
  {
    name: "getGroupMemberInfo",
    invoke: (operations) =>
      operations.standard.getGroupMemberInfo({
        groupId: "20002",
        userId: "10001",
        noCache: true,
      }),
    action: "get_group_member_info",
    params: { group_id: 20002, user_id: 10001, no_cache: true },
    conversationId: "20002",
  },
  {
    name: "getGroupMemberList",
    invoke: (operations) =>
      operations.standard.getGroupMemberList({ groupId: "20002" }),
    action: "get_group_member_list",
    params: { group_id: 20002 },
    conversationId: "20002",
  },
  {
    name: "getGroupHonorInfo",
    invoke: (operations) =>
      operations.standard.getGroupHonorInfo({
        groupId: "20002",
        type: "all",
      }),
    action: "get_group_honor_info",
    params: { group_id: 20002, type: "all" },
    conversationId: "20002",
  },
  {
    name: "sendLike",
    invoke: (operations) =>
      operations.standard.sendLike({ userId: "10001", times: 10 }),
    action: "send_like",
    params: { user_id: 10001, times: 10 },
    conversationId: "10001",
  },
  {
    name: "deleteMessage is privileged",
    invoke: (operations) =>
      operations.privileged.deleteMessage({ messageId: "88" }),
    action: "delete_msg",
    params: { message_id: 88 },
    conversationId: "message:88",
  },
  {
    name: "setGroupKick",
    invoke: (operations) =>
      operations.privileged.setGroupKick({
        groupId: "20002",
        userId: "10001",
        rejectAddRequest: true,
      }),
    action: "set_group_kick",
    params: {
      group_id: 20002,
      user_id: 10001,
      reject_add_request: true,
    },
    conversationId: "20002",
  },
  {
    name: "setGroupBan",
    invoke: (operations) =>
      operations.privileged.setGroupBan({
        groupId: "20002",
        userId: "10001",
        durationSeconds: 0,
      }),
    action: "set_group_ban",
    params: { group_id: 20002, user_id: 10001, duration: 0 },
    conversationId: "20002",
  },
  {
    name: "setGroupWholeBan",
    invoke: (operations) =>
      operations.privileged.setGroupWholeBan({
        groupId: "20002",
        enabled: true,
      }),
    action: "set_group_whole_ban",
    params: { group_id: 20002, enable: true },
    conversationId: "20002",
  },
  {
    name: "setGroupAdmin",
    invoke: (operations) =>
      operations.privileged.setGroupAdmin({
        groupId: "20002",
        userId: "10001",
        enabled: false,
      }),
    action: "set_group_admin",
    params: { group_id: 20002, user_id: 10001, enable: false },
    conversationId: "20002",
  },
  {
    name: "setGroupCard allows empty text",
    invoke: (operations) =>
      operations.privileged.setGroupCard({
        groupId: "20002",
        userId: "10001",
        card: "",
      }),
    action: "set_group_card",
    params: { group_id: 20002, user_id: 10001, card: "" },
    conversationId: "20002",
  },
  {
    name: "setGroupName",
    invoke: (operations) =>
      operations.privileged.setGroupName({
        groupId: "20002",
        name: "HuanLink",
      }),
    action: "set_group_name",
    params: { group_id: 20002, group_name: "HuanLink" },
    conversationId: "20002",
  },
  {
    name: "setGroupLeave",
    invoke: (operations) =>
      operations.privileged.setGroupLeave({
        groupId: "20002",
        dismiss: true,
      }),
    action: "set_group_leave",
    params: { group_id: 20002, is_dismiss: true },
    conversationId: "20002",
  },
  {
    name: "setGroupSpecialTitle allows empty text and permanent duration",
    invoke: (operations) =>
      operations.privileged.setGroupSpecialTitle({
        groupId: "20002",
        userId: "10001",
        title: "",
      }),
    action: "set_group_special_title",
    params: {
      group_id: 20002,
      user_id: 10001,
      special_title: "",
      duration: -1,
    },
    conversationId: "20002",
  },
  {
    name: "setFriendAddRequest",
    invoke: (operations) =>
      operations.privileged.setFriendAddRequest({
        flag: "friend-request-1",
        approve: true,
        remark: "Alice",
      }),
    action: "set_friend_add_request",
    params: { flag: "friend-request-1", approve: true, remark: "Alice" },
    conversationId: "operation:friend-request",
  },
  {
    name: "setGroupAddRequest",
    invoke: (operations) =>
      operations.privileged.setGroupAddRequest({
        flag: "group-request-1",
        subType: "invite",
        approve: false,
        reason: "not allowed",
      }),
    action: "set_group_add_request",
    params: {
      flag: "group-request-1",
      sub_type: "invite",
      approve: false,
      reason: "not allowed",
    },
    conversationId: "operation:group-request",
  },
];

describe("OneBot11Operations", () => {
  test.each(OPERATION_CASES)(
    "encodes $name and returns the untouched response data",
    async ({ invoke, action, params, conversationId }) => {
      const rawData = { nested: { implementationField: 1 } };
      const transport = new FakeOneBot11Transport(rawData);
      const operations = new OneBot11Operations({
        channelId: "qq-main",
        transport,
      });

      await expect(invoke(operations)).resolves.toBe(rawData);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]).toEqual({
        action: {
          action,
          params,
          echo: expect.stringMatching(
            new RegExp(`^${action.replaceAll("_", "-")}:`),
          ),
        },
        context: { conversationId },
      });
    },
  );

  test("keeps ordinary cross-group and cross-private sending under standard operations", async () => {
    const transport = new FakeOneBot11Transport({ message_id: 99 });
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport,
    });

    await operations.standard.sendGroupMessage({
      groupId: "20002",
      parts: [{ type: "text", text: "cross-group" }],
    });
    await operations.standard.sendPrivateMessage({
      userId: "10001",
      replyToMessageId: "88",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(transport.calls.map(({ action }) => action)).toMatchObject([
      {
        action: "send_group_msg",
        params: {
          group_id: 20002,
          message: [{ type: "text", data: { text: "cross-group" } }],
        },
      },
      {
        action: "send_private_msg",
        params: {
          user_id: 10001,
          message: [
            { type: "reply", data: { id: 88 } },
            { type: "text", data: { text: "hello" } },
          ],
        },
      },
    ]);
  });

  test("sends referenced and custom forward nodes to groups and private chats", async () => {
    const rawData = { message_id: 99, forward_id: "forward-1" };
    const transport = new FakeOneBot11Transport(rawData);
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport,
      forwardMessages: { protocol: "go-cqhttp-compatible" },
    });
    const nodes = [
      { kind: "reference", messageId: "-12" },
      {
        kind: "custom",
        userId: "10001",
        displayName: "Alice",
        content: "hello[CQ:image,file=https://example.com/a.png]",
      },
    ] as const;

    await expect(
      operations.standard.sendGroupForwardMessage({
        groupId: "20002",
        nodes,
      }),
    ).resolves.toBe(rawData);
    await expect(
      operations.standard.sendPrivateForwardMessage({
        userId: "10002",
        nodes,
      }),
    ).resolves.toBe(rawData);

    expect(transport.calls.map(({ action }) => action)).toMatchObject([
      {
        action: "send_group_forward_msg",
        params: {
          group_id: 20002,
          messages: [
            { type: "node", data: { id: -12 } },
            {
              type: "node",
              data: {
                uin: 10001,
                name: "Alice",
                content: "hello[CQ:image,file=https://example.com/a.png]",
              },
            },
          ],
        },
      },
      {
        action: "send_private_forward_msg",
        params: {
          user_id: 10002,
          messages: [
            { type: "node", data: { id: -12 } },
            {
              type: "node",
              data: {
                uin: 10001,
                name: "Alice",
                content: "hello[CQ:image,file=https://example.com/a.png]",
              },
            },
          ],
        },
      },
    ]);
  });

  test("exposes the same operations from the Channel Adapter instance", () => {
    const transport = new FakeOneBot11Transport();
    const adapter = new OneBot11ChannelAdapterV1({
      channelId: "qq-main",
      transport,
    });

    expect(adapter.operations).toBeInstanceOf(OneBot11Operations);
    expect("sendAction" in adapter.operations).toBe(false);
    expect(Object.isFrozen(adapter.operations.standard)).toBe(true);
    expect(Object.isFrozen(adapter.operations.privileged)).toBe(true);
  });

  test("passes Transport failures through without changing their type or identity", async () => {
    const transport = new FakeOneBot11Transport();
    const failure = new OneBot11DeliveryUncertainError("result unknown");
    vi.spyOn(transport, "sendAction").mockRejectedValueOnce(failure);
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport,
    });

    await expect(operations.standard.getStatus()).rejects.toBe(failure);
  });

  test("returns stable not_supported when a file extension is absent", async () => {
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport: new FakeOneBot11Transport(),
    });

    await expect(
      operations.standard.uploadGroupFile({
        groupId: "20002",
        path: fileURLToPath(import.meta.url),
      }),
    ).rejects.toMatchObject({
      name: "OneBot11OperationNotSupportedError",
      code: "not_supported",
      operation: "uploadGroupFile",
    });
    await expect(
      operations.standard.uploadPrivateFile({
        userId: "10001",
        path: fileURLToPath(import.meta.url),
      }),
    ).rejects.toBeInstanceOf(OneBot11OperationNotSupportedError);
  });

  test("returns stable not_supported when the forward-message extension is absent", async () => {
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport: new FakeOneBot11Transport(),
    });

    await expect(
      operations.standard.sendGroupForwardMessage({
        groupId: "20002",
        nodes: [{ kind: "reference", messageId: "12" }],
      }),
    ).rejects.toMatchObject({
      name: "OneBot11OperationNotSupportedError",
      code: "not_supported",
      operation: "sendGroupForwardMessage",
    });
    await expect(
      operations.standard.sendPrivateForwardMessage({
        userId: "10001",
        nodes: [{ kind: "reference", messageId: "12" }],
      }),
    ).rejects.toBeInstanceOf(OneBot11OperationNotSupportedError);
  });

  test("uses an explicitly injected file action factory after validating the local file", async () => {
    const transport = new FakeOneBot11Transport({ file_id: "file-1" });
    const path = fileURLToPath(import.meta.url);
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport,
      fileUpload: {
        createUploadGroupFileAction: (input, echo) => ({
          action: "upload_group_file",
          params: {
            group_id: input.groupId,
            file: input.path,
            name: input.name,
          },
          echo,
        }),
        createUploadPrivateFileAction: (input, echo) => ({
          action: "upload_private_file",
          params: {
            user_id: input.userId,
            file: input.path,
            name: input.name,
          },
          echo,
        }),
      },
    });

    await expect(
      operations.standard.uploadGroupFile({
        groupId: "20002",
        path,
        name: "operations.test.ts",
      }),
    ).resolves.toBe(transport.responseData);
    await expect(
      operations.standard.uploadPrivateFile({
        userId: "10001",
        path,
        name: "operations.test.ts",
      }),
    ).resolves.toBe(transport.responseData);
    expect(transport.calls).toMatchObject([
      {
        action: {
          action: "upload_group_file",
          params: {
            group_id: "20002",
            file: path,
            name: "operations.test.ts",
          },
        },
        context: { conversationId: "20002" },
      },
      {
        action: {
          action: "upload_private_file",
          params: {
            user_id: "10001",
            file: path,
            name: "operations.test.ts",
          },
        },
        context: { conversationId: "10001" },
      },
    ]);
  });
});
