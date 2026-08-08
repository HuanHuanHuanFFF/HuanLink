import type { OneBot11Action, OneBot11JsonObject } from "./codec.js";
import type {
  OneBot11CachedGroupInput,
  OneBot11CachedGroupMemberInput,
  OneBot11CachedUserInput,
  OneBot11ForwardMessageInput,
  OneBot11GroupHonorInput,
  OneBot11GroupHonorType,
  OneBot11GroupInput,
  OneBot11MessageInput,
  OneBot11SendLikeInput,
  OneBot11SendGroupForwardMessageInput,
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
} from "./operation-contracts.js";
import {
  assertExactObject,
  optionalBoolean,
  optionalLikeTimes,
  optionalSpecialTitleDuration,
  parseForwardNodes,
  optionalString,
  parseMessageIdParameter,
  parsePositiveIdParameter,
  requireBoolean,
  requireEnum,
  requireNonBlankString,
  requireNonNegativeSafeInteger,
  requireString,
} from "./operation-validation.js";

const GROUP_HONOR_TYPES = [
  "talkative",
  "performer",
  "legend",
  "strong_newbie",
  "emotion",
  "all",
] as const satisfies readonly OneBot11GroupHonorType[];

export function createGetMessageAction(
  input: OneBot11MessageInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(input, ["messageId"], "getMessage input");
  return createAction(
    "get_msg",
    {
      message_id: parseMessageIdParameter(
        raw.messageId,
        "OneBot 11 message ID",
      ),
    },
    echo,
  );
}

export function createGetForwardMessageAction(
  input: OneBot11ForwardMessageInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["messageId"],
    "getForwardMessage input",
  );
  return createAction(
    "get_forward_msg",
    {
      message_id: requireNonBlankString(
        raw.messageId,
        "OneBot 11 forward message ID",
      ),
    },
    echo,
  );
}

export function createGetLoginInfoAction(echo: string): OneBot11Action {
  return createAction("get_login_info", {}, echo);
}

export function createGetVersionInfoAction(echo: string): OneBot11Action {
  return createAction("get_version_info", {}, echo);
}

export function createGetStatusAction(echo: string): OneBot11Action {
  return createAction("get_status", {}, echo);
}

export function createCanSendImageAction(echo: string): OneBot11Action {
  return createAction("can_send_image", {}, echo);
}

export function createCanSendRecordAction(echo: string): OneBot11Action {
  return createAction("can_send_record", {}, echo);
}

export function createGetStrangerInfoAction(
  input: OneBot11CachedUserInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["userId", "noCache"],
    "getStrangerInfo input",
  );
  return createAction(
    "get_stranger_info",
    {
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      no_cache: optionalBoolean(raw.noCache, false, "OneBot 11 noCache"),
    },
    echo,
  );
}

export function createGetFriendListAction(echo: string): OneBot11Action {
  return createAction("get_friend_list", {}, echo);
}

export function createGetGroupInfoAction(
  input: OneBot11CachedGroupInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "noCache"],
    "getGroupInfo input",
  );
  return createAction(
    "get_group_info",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      no_cache: optionalBoolean(raw.noCache, false, "OneBot 11 noCache"),
    },
    echo,
  );
}

export function createGetGroupListAction(echo: string): OneBot11Action {
  return createAction("get_group_list", {}, echo);
}

export function createGetGroupMemberInfoAction(
  input: OneBot11CachedGroupMemberInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "noCache"],
    "getGroupMemberInfo input",
  );
  return createAction(
    "get_group_member_info",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      no_cache: optionalBoolean(raw.noCache, false, "OneBot 11 noCache"),
    },
    echo,
  );
}

export function createGetGroupMemberListAction(
  input: OneBot11GroupInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(input, ["groupId"], "getGroupMemberList input");
  return createAction(
    "get_group_member_list",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
    },
    echo,
  );
}

export function createGetGroupHonorInfoAction(
  input: OneBot11GroupHonorInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "type"],
    "getGroupHonorInfo input",
  );
  return createAction(
    "get_group_honor_info",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      type: requireEnum(
        raw.type,
        GROUP_HONOR_TYPES,
        "OneBot 11 group honor type",
      ),
    },
    echo,
  );
}

export function createSendLikeAction(
  input: OneBot11SendLikeInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(input, ["userId", "times"], "sendLike input");
  return createAction(
    "send_like",
    {
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      times: optionalLikeTimes(raw.times),
    },
    echo,
  );
}

/** 编码 NapCat/go-cqhttp 兼容的群合并转发扩展 Action。 */
export function createSendGroupForwardMessageAction(
  input: OneBot11SendGroupForwardMessageInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "nodes"],
    "sendGroupForwardMessage input",
  );
  return createAction(
    "send_group_forward_msg",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      messages: encodeForwardNodes(raw.nodes),
    },
    echo,
  );
}

/** 编码 NapCat/go-cqhttp 兼容的私聊合并转发扩展 Action。 */
export function createSendPrivateForwardMessageAction(
  input: OneBot11SendPrivateForwardMessageInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["userId", "nodes"],
    "sendPrivateForwardMessage input",
  );
  return createAction(
    "send_private_forward_msg",
    {
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      messages: encodeForwardNodes(raw.nodes),
    },
    echo,
  );
}

function encodeForwardNodes(input: unknown): OneBot11JsonObject[] {
  return parseForwardNodes(input).map((node) =>
    node.kind === "reference"
      ? {
          type: "node",
          data: {
            id: parseMessageIdParameter(
              node.messageId,
              "OneBot 11 forward reference message ID",
            ),
          },
        }
      : {
          type: "node",
          data: {
            uin: parsePositiveIdParameter(
              node.userId,
              "OneBot 11 forward custom user ID",
            ),
            name: node.displayName,
            content: node.content,
          },
        },
  );
}

export function createDeleteMessageOperationAction(
  input: OneBot11MessageInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(input, ["messageId"], "deleteMessage input");
  return createAction(
    "delete_msg",
    {
      message_id: parseMessageIdParameter(
        raw.messageId,
        "OneBot 11 message ID",
      ),
    },
    echo,
  );
}

export function createSetGroupKickAction(
  input: OneBot11SetGroupKickInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "rejectAddRequest"],
    "setGroupKick input",
  );
  return createAction(
    "set_group_kick",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      reject_add_request: optionalBoolean(
        raw.rejectAddRequest,
        false,
        "OneBot 11 rejectAddRequest",
      ),
    },
    echo,
  );
}

export function createSetGroupBanAction(
  input: OneBot11SetGroupBanInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "durationSeconds"],
    "setGroupBan input",
  );
  return createAction(
    "set_group_ban",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      duration: requireNonNegativeSafeInteger(
        raw.durationSeconds,
        "OneBot 11 durationSeconds",
      ),
    },
    echo,
  );
}

export function createSetGroupWholeBanAction(
  input: OneBot11SetGroupWholeBanInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "enabled"],
    "setGroupWholeBan input",
  );
  return createAction(
    "set_group_whole_ban",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      enable: requireBoolean(raw.enabled, "OneBot 11 enabled"),
    },
    echo,
  );
}

export function createSetGroupAdminAction(
  input: OneBot11SetGroupAdminInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "enabled"],
    "setGroupAdmin input",
  );
  return createAction(
    "set_group_admin",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      enable: requireBoolean(raw.enabled, "OneBot 11 enabled"),
    },
    echo,
  );
}

export function createSetGroupCardAction(
  input: OneBot11SetGroupCardInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "card"],
    "setGroupCard input",
  );
  return createAction(
    "set_group_card",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      card: requireString(raw.card, "OneBot 11 group card"),
    },
    echo,
  );
}

export function createSetGroupNameAction(
  input: OneBot11SetGroupNameInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "name"],
    "setGroupName input",
  );
  return createAction(
    "set_group_name",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      group_name: requireNonBlankString(raw.name, "OneBot 11 group name"),
    },
    echo,
  );
}

export function createSetGroupLeaveAction(
  input: OneBot11SetGroupLeaveInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "dismiss"],
    "setGroupLeave input",
  );
  return createAction(
    "set_group_leave",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      is_dismiss: optionalBoolean(raw.dismiss, false, "OneBot 11 dismiss"),
    },
    echo,
  );
}

export function createSetGroupSpecialTitleAction(
  input: OneBot11SetGroupSpecialTitleInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["groupId", "userId", "title", "durationSeconds"],
    "setGroupSpecialTitle input",
  );
  return createAction(
    "set_group_special_title",
    {
      group_id: parsePositiveIdParameter(raw.groupId, "OneBot 11 group ID"),
      user_id: parsePositiveIdParameter(raw.userId, "OneBot 11 user ID"),
      special_title: requireString(raw.title, "OneBot 11 special title"),
      duration: optionalSpecialTitleDuration(raw.durationSeconds),
    },
    echo,
  );
}

export function createSetFriendAddRequestAction(
  input: OneBot11SetFriendAddRequestInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["flag", "approve", "remark"],
    "setFriendAddRequest input",
  );
  return createAction(
    "set_friend_add_request",
    {
      flag: requireNonBlankString(raw.flag, "OneBot 11 request flag"),
      approve: requireBoolean(raw.approve, "OneBot 11 approve"),
      remark: optionalString(raw.remark, "OneBot 11 friend remark") ?? "",
    },
    echo,
  );
}

export function createSetGroupAddRequestAction(
  input: OneBot11SetGroupAddRequestInput,
  echo: string,
): OneBot11Action {
  const raw = assertExactObject(
    input,
    ["flag", "subType", "approve", "reason"],
    "setGroupAddRequest input",
  );
  return createAction(
    "set_group_add_request",
    {
      flag: requireNonBlankString(raw.flag, "OneBot 11 request flag"),
      sub_type: requireEnum(
        raw.subType,
        ["add", "invite"] as const,
        "OneBot 11 group request subType",
      ),
      approve: requireBoolean(raw.approve, "OneBot 11 approve"),
      reason: optionalString(raw.reason, "OneBot 11 rejection reason") ?? "",
    },
    echo,
  );
}

/** 所有公开构造器最终只通过这里写入固定 Action 名称。 */
function createAction(
  action: string,
  params: OneBot11JsonObject,
  echo: string,
): OneBot11Action {
  return {
    action,
    params,
    echo: requireNonBlankString(echo, "OneBot 11 action echo"),
  };
}
