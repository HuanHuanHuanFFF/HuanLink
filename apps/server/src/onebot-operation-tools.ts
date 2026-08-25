import type {
  ChannelConversationRoute,
  ConversationJsonValue,
  ConversationSessionStore,
  RuntimeLogger,
  SessionToolHistoryRecorder,
  SessionId,
} from "@huanlink/core";
import {
  ChannelOperationError,
  ConversationSessionStoreToolHistoryRecorder,
  NoopRuntimeLogger,
} from "@huanlink/core";
import {
  type OpenAiAgentsRunContext,
  withSessionToolHistory,
} from "@huanlink/integration-openai-agents";
import {
  OneBot11DeliveryUncertainError,
  OneBot11RemoteActionError,
  type OneBot11Operations,
} from "@huanlink/integration-onebot11";
import { tool } from "@openai/agents";
import { z } from "zod";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

export const ONEBOT11_STANDARD_TOOL_NAME = "onebot_standard" as const;
export const ONEBOT11_PRIVILEGED_TOOL_NAME = "onebot_privileged" as const;

const positiveId = z.string().regex(/^[1-9]\d*$/u);
const messageId = z.string().regex(/^-?\d+$/u);
const nonBlank = z.string().regex(/\S/u);
const messageText = z.string().min(1);
const noParams = z.object({}).strict();
const outboundPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: messageText }).strict(),
  z
    .object({
      type: z.literal("mention"),
      targetId: z.union([positiveId, z.literal("all")]),
      displayName: nonBlank.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("attachmentLink"),
      kind: z.enum(["image", "audio", "video", "file"]),
      url: nonBlank,
      name: nonBlank.optional(),
      mimeType: nonBlank.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("attachmentLocalPath"),
      kind: z.enum(["image", "audio", "video", "file"]),
      path: nonBlank,
      name: nonBlank.optional(),
      mimeType: nonBlank.optional(),
    })
    .strict(),
]);
const forwardNode = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference"), messageId }).strict(),
  z
    .object({
      kind: z.literal("custom"),
      userId: positiveId,
      displayName: nonBlank,
      content: messageText,
    })
    .strict(),
]);

const standardRequest = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("sendGroupMessage"),
      params: z
        .object({
          groupId: positiveId,
          parts: z.array(outboundPart).min(1),
          replyToMessageId: messageId.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("sendPrivateMessage"),
      params: z
        .object({
          userId: positiveId,
          parts: z.array(outboundPart).min(1),
          replyToMessageId: messageId.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("sendGroupForwardMessage"),
      params: z
        .object({ groupId: positiveId, nodes: z.array(forwardNode).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("sendPrivateForwardMessage"),
      params: z
        .object({ userId: positiveId, nodes: z.array(forwardNode).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("getMessage"),
      params: z.object({ messageId }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("getForwardMessage"),
      params: z.object({ messageId: nonBlank }).strict(),
    })
    .strict(),
  z.object({ operation: z.literal("getLoginInfo"), params: noParams }).strict(),
  z
    .object({ operation: z.literal("getVersionInfo"), params: noParams })
    .strict(),
  z.object({ operation: z.literal("getStatus"), params: noParams }).strict(),
  z.object({ operation: z.literal("canSendImage"), params: noParams }).strict(),
  z
    .object({ operation: z.literal("canSendRecord"), params: noParams })
    .strict(),
  z
    .object({
      operation: z.literal("getStrangerInfo"),
      params: z
        .object({ userId: positiveId, noCache: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({ operation: z.literal("getFriendList"), params: noParams })
    .strict(),
  z
    .object({
      operation: z.literal("getGroupInfo"),
      params: z
        .object({ groupId: positiveId, noCache: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z.object({ operation: z.literal("getGroupList"), params: noParams }).strict(),
  z
    .object({
      operation: z.literal("getGroupMemberInfo"),
      params: z
        .object({
          groupId: positiveId,
          userId: positiveId,
          noCache: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("getGroupMemberList"),
      params: z.object({ groupId: positiveId }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("getGroupHonorInfo"),
      params: z
        .object({
          groupId: positiveId,
          type: z.enum([
            "talkative",
            "performer",
            "legend",
            "strong_newbie",
            "emotion",
            "all",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("sendLike"),
      params: z
        .object({
          userId: positiveId,
          times: z.number().int().min(1).max(10).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("uploadGroupFile"),
      params: z
        .object({
          groupId: positiveId,
          path: nonBlank,
          name: nonBlank.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("uploadPrivateFile"),
      params: z
        .object({
          userId: positiveId,
          path: nonBlank,
          name: nonBlank.optional(),
        })
        .strict(),
    })
    .strict(),
]);

const privilegedRequest = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("deleteMessage"),
      params: z.object({ messageId }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupKick"),
      params: z
        .object({
          groupId: positiveId,
          userId: positiveId,
          rejectAddRequest: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupBan"),
      params: z
        .object({
          groupId: positiveId,
          userId: positiveId,
          durationSeconds: z.number().int().min(0),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupWholeBan"),
      params: z.object({ groupId: positiveId, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupAdmin"),
      params: z
        .object({
          groupId: positiveId,
          userId: positiveId,
          enabled: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupCard"),
      params: z
        .object({ groupId: positiveId, userId: positiveId, card: z.string() })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupName"),
      params: z.object({ groupId: positiveId, name: nonBlank }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupLeave"),
      params: z
        .object({ groupId: positiveId, dismiss: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupSpecialTitle"),
      params: z
        .object({
          groupId: positiveId,
          userId: positiveId,
          title: z.string(),
          durationSeconds: z.number().int().min(-1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setFriendAddRequest"),
      params: z
        .object({
          flag: nonBlank,
          approve: z.boolean(),
          remark: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("setGroupAddRequest"),
      params: z
        .object({
          flag: nonBlank,
          subType: z.enum(["add", "invite"]),
          approve: z.boolean(),
          reason: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);

const standardParameters = z
  .object({ channelId: nonBlank, request: standardRequest })
  .strict();
const privilegedParameters = z
  .object({ channelId: nonBlank, request: privilegedRequest })
  .strict();

type StandardToolInput = z.infer<typeof standardParameters>;
type PrivilegedToolInput = z.infer<typeof privilegedParameters>;
type ToolName =
  | typeof ONEBOT11_STANDARD_TOOL_NAME
  | typeof ONEBOT11_PRIVILEGED_TOOL_NAME;
type ToolResult =
  | ConversationJsonValue
  | {
      readonly status: "error" | "uncertain";
      readonly tool: ToolName;
      readonly error: string;
    };

type OutboundDelivery = {
  readonly route: ChannelConversationRoute;
  readonly messageId: string;
};

type OperationExecution = {
  readonly data: unknown;
  readonly delivery?: OutboundDelivery;
};

export type CreateOneBot11OperationToolsOptions = {
  sessions: ConversationSessionStore;
  /** Defaults to the supplied Session Store without generating any IDs. */
  historyRecorder?: SessionToolHistoryRecorder;
  resolveOperations(channelId: string): OneBot11Operations | undefined;
  isRouteAllowed(route: ChannelConversationRoute): boolean;
  /**
   * Decides whether destructive OneBot operations may target a Channel.
   * Omit the predicate unless the caller intentionally accepts that risk.
   */
  isUnsafePrivilegedOperationsEnabled?(channelId: string): boolean;
  /** Channel Runtime owns the canonical route-to-Session mapping. */
  sessionIdForRoute(route: ChannelConversationRoute): SessionId;
  /** Channel Runtime owns serialization of all target-session outbound work. */
  runOutbound<T>(
    route: ChannelConversationRoute,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Applies Channel Runtime lifecycle gates without adding route-list checks. */
  runOperation<T>(channelId: string, operation: () => Promise<T>): Promise<T>;
  logger?: RuntimeLogger;
  now?: () => Date;
};

export type OneBot11OperationTools = ReturnType<
  typeof createOneBot11OperationTools
>;

/**
 * Builds the Agent-visible OneBot Tools. Standard operations are always
 * available to external Channel Sessions. Privileged operations are omitted
 * unless explicitly enabled because the current Agent Runtime has no approval
 * and resume protection. This Server boundary owns allow-range checks for
 * standard explicit targets, Session audit records and delivery association;
 * the integration Operations object remains a typed protocol executor only.
 */
export function createOneBot11OperationTools(
  options: CreateOneBot11OperationToolsOptions,
) {
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger(),
  );
  const historyRecorder =
    options.historyRecorder ??
    new ConversationSessionStoreToolHistoryRecorder(options.sessions);

  const standard = withSessionToolHistory(
    tool<typeof standardParameters, OpenAiAgentsRunContext>({
      name: ONEBOT11_STANDARD_TOOL_NAME,
      description:
        "Run one named, non-privileged OneBot 11 operation. Operations with an explicit group or private target must be in HuanLink's allowed Channel range; account-level list and status queries have no target and return the configured account's raw data.",
      parameters: standardParameters,
      strict: true,
      isEnabled: ({ runContext }) =>
        isExternalSession(options, runContext.context.sessionId),
      errorFunction: (_context, error) =>
        JSON.stringify(errorResult(ONEBOT11_STANDARD_TOOL_NAME, error)),
      execute: async (input, runContext, details) =>
        await executeToolCall({
          options,
          logger,
          toolName: ONEBOT11_STANDARD_TOOL_NAME,
          input,
          runContext,
          toolCallId: details?.toolCall?.callId,
          operation: async (operations) =>
            executeStandard(options, operations, input),
        }),
    }),
    historyRecorder,
    logger,
    parseStandardHistoryArguments,
  );
  const privileged =
    options.isUnsafePrivilegedOperationsEnabled !== undefined
      ? withSessionToolHistory(
          tool<typeof privilegedParameters, OpenAiAgentsRunContext>({
            name: ONEBOT11_PRIVILEGED_TOOL_NAME,
            description:
              "Run one named destructive OneBot 11 operation. This Tool currently has no approval, target-list, or message-ownership protection and executes immediately.",
            parameters: privilegedParameters,
            strict: true,
            isEnabled: ({ runContext }) => {
              const metadata = options.sessions.getSessionMetadata(
                runContext.context.sessionId,
              );
              return (
                metadata?.kind === "external_channel" &&
                options.isUnsafePrivilegedOperationsEnabled?.(
                  metadata.route.channelId,
                ) === true
              );
            },
            errorFunction: (_context, error) =>
              JSON.stringify(errorResult(ONEBOT11_PRIVILEGED_TOOL_NAME, error)),
            execute: async (input, runContext, details) =>
              await executeToolCall({
                options,
                logger,
                toolName: ONEBOT11_PRIVILEGED_TOOL_NAME,
                input,
                runContext,
                toolCallId: details?.toolCall?.callId,
                operation: async (operations) => ({
                  data: await executePrivileged(operations, input),
                }),
              }),
          }),
          historyRecorder,
          logger,
          parsePrivilegedHistoryArguments,
        )
      : undefined;

  if (privileged !== undefined) {
    logger.warn("onebot.privileged.enabled_without_protection", {
      approvalProtection: false,
    });
  }

  return { standard, privileged };
}

function parseStandardHistoryArguments(
  rawArguments: string,
): Readonly<Record<string, ConversationJsonValue>> {
  return standardParameters.parse(
    JSON.parse(rawArguments),
  ) as unknown as Readonly<Record<string, ConversationJsonValue>>;
}

function parsePrivilegedHistoryArguments(
  rawArguments: string,
): Readonly<Record<string, ConversationJsonValue>> {
  return privilegedParameters.parse(
    JSON.parse(rawArguments),
  ) as unknown as Readonly<Record<string, ConversationJsonValue>>;
}

async function executeToolCall<
  Input extends StandardToolInput | PrivilegedToolInput,
>(input: {
  options: CreateOneBot11OperationToolsOptions;
  logger: RuntimeLogger;
  toolName: ToolName;
  input: Input;
  runContext: { context: OpenAiAgentsRunContext } | undefined;
  toolCallId: string | undefined;
  operation: (operations: OneBot11Operations) => Promise<OperationExecution>;
}): Promise<string> {
  const context = input.runContext?.context;
  if (context === undefined) {
    return JSON.stringify(
      errorResult(
        input.toolName,
        new Error("OneBot Tool requires a HuanLink RunContext"),
      ),
    );
  }
  if (!isExternalSession(input.options, context.sessionId)) {
    return JSON.stringify(
      errorResult(
        input.toolName,
        new Error(
          `Session ${context.sessionId} is not an external Channel session`,
        ),
      ),
    );
  }
  if (input.toolCallId === undefined || input.toolCallId.trim().length === 0) {
    return JSON.stringify(
      errorResult(
        input.toolName,
        new Error("OneBot Tool requires the SDK Tool Call ID"),
      ),
    );
  }

  const toolLogger = input.logger.child({
    runId: context.runId,
    sessionId: context.sessionId,
    toolName: input.toolName,
    channelId: input.input.channelId,
    operation: input.input.request.operation,
  });
  const complete = (result: ToolResult): string => {
    toolLogger.info("onebot.operation.completed", {
      status: isErrorResult(result) ? result.status : "success",
    });
    return JSON.stringify(result);
  };

  if (input.toolName === ONEBOT11_PRIVILEGED_TOOL_NAME) {
    try {
      if (
        input.options.isUnsafePrivilegedOperationsEnabled?.(
          input.input.channelId,
        ) !== true
      ) {
        return complete(
          errorResult(
            input.toolName,
            new Error(
              `Unsafe privileged OneBot operations are not enabled for ${input.input.channelId}`,
            ),
          ),
        );
      }
    } catch (error) {
      return complete(errorResult(input.toolName, error));
    }
  }

  let operations: OneBot11Operations | undefined;
  try {
    operations = input.options.resolveOperations(input.input.channelId);
  } catch (error) {
    return complete(errorResult(input.toolName, error));
  }
  if (operations === undefined) {
    return complete(
      errorResult(
        input.toolName,
        new Error(
          `No OneBot Operations are registered for ${input.input.channelId}`,
        ),
      ),
    );
  }

  toolLogger.info("onebot.operation.started");
  try {
    const execution = await input.options.runOperation(
      input.input.channelId,
      async () => await input.operation(operations),
    );
    if (execution.delivery !== undefined) {
      try {
        input.options.sessions.recordOutboundDelivery(
          input.options.sessionIdForRoute(execution.delivery.route),
          {
            route: execution.delivery.route,
            contentFormat: "onebot11.cq",
            receipt: {
              channelId: execution.delivery.route.channelId,
              messageId: execution.delivery.messageId,
            },
            sentAt: (input.options.now ?? (() => new Date()))().toISOString(),
            runId: context.runId,
            toolCallId: input.toolCallId,
            sourceSessionId: context.sessionId,
          },
        );
      } catch (error) {
        toolLogger.warn("onebot.operation.session_association_failed", {
          messageId: execution.delivery.messageId,
          errorType: errorType(error),
        });
      }
    }
    const value = asConversationJsonValue(execution.data);
    if (value === undefined) {
      return complete(
        errorResult(
          input.toolName,
          new Error("OneBot operation returned non-JSON data"),
        ),
      );
    }
    return complete(value);
  } catch (error) {
    return complete(errorResult(input.toolName, error));
  }
}

async function executeStandard(
  options: CreateOneBot11OperationToolsOptions,
  operations: OneBot11Operations,
  input: StandardToolInput,
): Promise<OperationExecution> {
  const request = input.request;
  switch (request.operation) {
    case "sendGroupMessage":
      return await executeSend(
        options,
        groupRoute(input.channelId, request.params.groupId),
        () => operations.standard.sendGroupMessage(request.params),
      );
    case "sendPrivateMessage":
      return await executeSend(
        options,
        directRoute(input.channelId, request.params.userId),
        () => operations.standard.sendPrivateMessage(request.params),
      );
    case "sendGroupForwardMessage":
      return await executeSend(
        options,
        groupRoute(input.channelId, request.params.groupId),
        () => operations.standard.sendGroupForwardMessage(request.params),
      );
    case "sendPrivateForwardMessage":
      return await executeSend(
        options,
        directRoute(input.channelId, request.params.userId),
        () => operations.standard.sendPrivateForwardMessage(request.params),
      );
    case "getMessage":
      return { data: await operations.standard.getMessage(request.params) };
    case "getForwardMessage":
      return {
        data: await operations.standard.getForwardMessage(request.params),
      };
    case "getLoginInfo":
      return { data: await operations.standard.getLoginInfo() };
    case "getVersionInfo":
      return { data: await operations.standard.getVersionInfo() };
    case "getStatus":
      return { data: await operations.standard.getStatus() };
    case "canSendImage":
      return { data: await operations.standard.canSendImage() };
    case "canSendRecord":
      return { data: await operations.standard.canSendRecord() };
    case "getStrangerInfo":
      assertAllowed(
        options,
        directRoute(input.channelId, request.params.userId),
      );
      return {
        data: await operations.standard.getStrangerInfo(request.params),
      };
    // 用户已将无显式目标的账号级只读枚举归入 standard；它们不伪造一个
    // route，也不改变带明确群/私聊目标操作必须经过 assertAllowed 的规则。
    case "getFriendList":
      return { data: await operations.standard.getFriendList() };
    case "getGroupInfo":
      assertAllowed(
        options,
        groupRoute(input.channelId, request.params.groupId),
      );
      return { data: await operations.standard.getGroupInfo(request.params) };
    case "getGroupList":
      return { data: await operations.standard.getGroupList() };
    case "getGroupMemberInfo":
      assertAllowed(
        options,
        groupRoute(input.channelId, request.params.groupId),
      );
      return {
        data: await operations.standard.getGroupMemberInfo(request.params),
      };
    case "getGroupMemberList":
      assertAllowed(
        options,
        groupRoute(input.channelId, request.params.groupId),
      );
      return {
        data: await operations.standard.getGroupMemberList(request.params),
      };
    case "getGroupHonorInfo":
      assertAllowed(
        options,
        groupRoute(input.channelId, request.params.groupId),
      );
      return {
        data: await operations.standard.getGroupHonorInfo(request.params),
      };
    case "sendLike":
      return {
        data: await runAllowedOutbound(
          options,
          directRoute(input.channelId, request.params.userId),
          () => operations.standard.sendLike(request.params),
        ),
      };
    case "uploadGroupFile":
      assertAllowed(
        options,
        groupRoute(input.channelId, request.params.groupId),
      );
      return {
        data: await options.runOutbound(
          groupRoute(input.channelId, request.params.groupId),
          () => operations.standard.uploadGroupFile(request.params),
        ),
      };
    case "uploadPrivateFile":
      assertAllowed(
        options,
        directRoute(input.channelId, request.params.userId),
      );
      return {
        data: await options.runOutbound(
          directRoute(input.channelId, request.params.userId),
          () => operations.standard.uploadPrivateFile(request.params),
        ),
      };
  }
}

async function executePrivileged(
  operations: OneBot11Operations,
  input: PrivilegedToolInput,
): Promise<unknown> {
  const request = input.request;
  switch (request.operation) {
    case "deleteMessage":
      return await operations.privileged.deleteMessage(request.params);
    case "setGroupKick":
      return await operations.privileged.setGroupKick(request.params);
    case "setGroupBan":
      return await operations.privileged.setGroupBan(request.params);
    case "setGroupWholeBan":
      return await operations.privileged.setGroupWholeBan(request.params);
    case "setGroupAdmin":
      return await operations.privileged.setGroupAdmin(request.params);
    case "setGroupCard":
      return await operations.privileged.setGroupCard(request.params);
    case "setGroupName":
      return await operations.privileged.setGroupName(request.params);
    case "setGroupLeave":
      return await operations.privileged.setGroupLeave(request.params);
    case "setGroupSpecialTitle":
      return await operations.privileged.setGroupSpecialTitle(request.params);
    case "setFriendAddRequest":
      return await operations.privileged.setFriendAddRequest(request.params);
    case "setGroupAddRequest":
      return await operations.privileged.setGroupAddRequest(request.params);
  }
}

async function executeSend(
  options: CreateOneBot11OperationToolsOptions,
  route: ChannelConversationRoute,
  send: () => Promise<unknown>,
): Promise<OperationExecution> {
  assertAllowed(options, route);
  const data = await options.runOutbound(route, send);
  const id = readMessageId(data);
  if (id === undefined) {
    throw new OneBot11DeliveryUncertainError(
      "OneBot send response did not contain message_id",
    );
  }
  return { data, delivery: { route, messageId: id } };
}

async function runAllowedOutbound<T>(
  options: CreateOneBot11OperationToolsOptions,
  route: ChannelConversationRoute,
  operation: () => Promise<T>,
): Promise<T> {
  assertAllowed(options, route);
  return await options.runOutbound(route, operation);
}

function assertAllowed(
  options: CreateOneBot11OperationToolsOptions,
  route: ChannelConversationRoute,
): void {
  if (!options.isRouteAllowed(route)) {
    throw new Error("OneBot target is not allowed");
  }
}

function groupRoute(
  channelId: string,
  groupId: string,
): ChannelConversationRoute {
  return { channelId, conversationKind: "group", conversationId: groupId };
}

function directRoute(
  channelId: string,
  userId: string,
): ChannelConversationRoute {
  return { channelId, conversationKind: "direct", conversationId: userId };
}

function isExternalSession(
  options: CreateOneBot11OperationToolsOptions,
  sessionId: SessionId,
): boolean {
  return (
    options.sessions.getSessionMetadata(sessionId)?.kind === "external_channel"
  );
}

function readMessageId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const value = (data as Record<string, unknown>).message_id;
  if (typeof value === "string") {
    const normalized = value.trim();
    return /^-?\d+$/u.test(normalized) ? normalized : undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
}

function asConversationJsonValue(
  value: unknown,
): ConversationJsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : (JSON.parse(serialized) as ConversationJsonValue);
  } catch {
    return undefined;
  }
}

function errorResult(
  tool: ToolName,
  error: unknown,
): Extract<ToolResult, { status: "error" | "uncertain" }> {
  return {
    status: isDeliveryUncertain(error) ? "uncertain" : "error",
    tool,
    error: formatError(error),
  };
}

function isErrorResult(
  value: ToolResult,
): value is Extract<ToolResult, { status: "error" | "uncertain" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "error" || value.status === "uncertain")
  );
}

function isDeliveryUncertain(error: unknown): boolean {
  return (
    error instanceof OneBot11DeliveryUncertainError ||
    (error instanceof ChannelOperationError &&
      error.code === "delivery_uncertain")
  );
}

function formatError(error: unknown): string {
  if (error instanceof OneBot11RemoteActionError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
