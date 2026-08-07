import {
  assertValidChannelConversationRoute,
  type ChannelConversationRouteV1
} from "@huanlink/core";

export type ChannelAccessListMode = "allowlist" | "denylist";

export type ChannelConversationAccessList = {
  readonly mode: ChannelAccessListMode;
  readonly ids: readonly string[];
};

/** 一个 Channel 实例对群聊和私聊分别生效的接收名单。 */
export type ChannelInboundAccessPolicy = {
  readonly groups: ChannelConversationAccessList;
  readonly directs: ChannelConversationAccessList;
};

/** 防御性校验运行时收到的策略；配置加载器之外的调用方也不能绕过边界。 */
export function assertValidChannelInboundAccessPolicy(
  policy: ChannelInboundAccessPolicy
): void {
  assertValidAccessList(policy?.groups, "groups");
  assertValidAccessList(policy?.directs, "directs");
}

/** 校验并复制名单，避免调用方在注册或热更新后原地改写生效策略。 */
export function copyChannelInboundAccessPolicy(
  policy: ChannelInboundAccessPolicy
): ChannelInboundAccessPolicy {
  assertValidChannelInboundAccessPolicy(policy);
  return {
    groups: {
      mode: policy.groups.mode,
      ids: [...policy.groups.ids]
    },
    directs: {
      mode: policy.directs.mode,
      ids: [...policy.directs.ids]
    }
  };
}

/** 判断一条规范 Channel route 是否属于该实例允许的会话范围。 */
export function isChannelRouteAllowed(
  policy: ChannelInboundAccessPolicy,
  route: ChannelConversationRouteV1
): boolean {
  assertValidChannelConversationRoute(route);
  const accessList =
    route.conversationKind === "group"
      ? policy.groups
      : route.conversationKind === "direct"
        ? policy.directs
        : undefined;
  if (accessList === undefined) {
    return false;
  }

  const listed = accessList.ids.includes(route.conversationId);
  return accessList.mode === "allowlist" ? listed : !listed;
}

function assertValidAccessList(
  accessList: ChannelConversationAccessList | undefined,
  label: string
): void {
  if (
    accessList === undefined ||
    (accessList.mode !== "allowlist" && accessList.mode !== "denylist") ||
    !Array.isArray(accessList.ids)
  ) {
    throw new TypeError(`Channel ${label} access policy is invalid`);
  }

  const seen = new Set<string>();
  for (const id of accessList.ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TypeError(
        `Channel ${label} access policy IDs must be non-empty strings`
      );
    }
    if (seen.has(id)) {
      throw new TypeError(`Channel ${label} access policy IDs must be unique`);
    }
    seen.add(id);
  }
}
