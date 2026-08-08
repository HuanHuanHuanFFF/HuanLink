import type {
  ChannelAdapterV1,
  ChannelOutboundMessagePartV1,
  ConversationJsonValue,
  InMemoryConversationSessionStore,
  RuntimeLogger
} from "@huanlink/core";
import { ChannelOperationError, NoopRuntimeLogger } from "@huanlink/core";
import type { OpenAiAgentsRunContext } from "@huanlink/integration-openai-agents";
import { tool } from "@openai/agents";
import { z } from "zod";

import { createBestEffortRuntimeLogger } from "./best-effort-runtime-logger.js";

export const CHANNEL_REPLY_TOOL_NAME = "reply" as const;

const attachmentKind = z.enum(["image", "audio", "video", "file"]);
const optionalAttachmentMetadata = {
  name: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional()
};
const outboundPart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1)
  }),
  z.object({
    type: z.literal("mention"),
    targetId: z.string().min(1),
    displayName: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("attachmentLink"),
    kind: attachmentKind,
    url: z.string().min(1),
    ...optionalAttachmentMetadata
  }),
  z.object({
    type: z.literal("attachmentLocalPath"),
    kind: attachmentKind,
    path: z.string().min(1),
    ...optionalAttachmentMetadata
  })
]);
const parameters = z.object({
  parts: z.array(outboundPart).min(1),
  replyToMessageId: z.string().min(1).optional()
});

type ChannelReplyToolInput = z.infer<typeof parameters>;
type ChannelReplyToolResult =
  | {
      readonly status: "success";
      readonly tool: typeof CHANNEL_REPLY_TOOL_NAME;
      readonly messageId: string;
      readonly warning?: string;
    }
  | {
      readonly status: "error" | "uncertain";
      readonly tool: typeof CHANNEL_REPLY_TOOL_NAME;
      readonly error: string;
    };

export type CreateChannelReplyToolOptions = {
  sessions: InMemoryConversationSessionStore;
  resolveAdapter(channelId: string): ChannelAdapterV1 | undefined;
  logger?: RuntimeLogger;
  now?: () => Date;
  redactValues?: readonly string[];
};

/** 创建只向显式外部 Channel Session 提供的当前会话回复 Tool。 */
export function createChannelReplyTool(options: CreateChannelReplyToolOptions) {
  const logger = createBestEffortRuntimeLogger(
    options.logger ?? new NoopRuntimeLogger()
  );

  return tool<typeof parameters, OpenAiAgentsRunContext>({
    name: CHANNEL_REPLY_TOOL_NAME,
    description:
      "Send one message to the current external Channel session. The target is fixed by trusted session metadata; omit this tool to stay silent.",
    parameters,
    isEnabled: ({ runContext }) =>
      options.sessions.getSessionMetadata(runContext.context.sessionId)?.kind ===
      "external_channel",
    errorFunction: (_context, error) =>
      JSON.stringify(replyError("error", error, options.redactValues)),
    execute: async (input, runContext, details) => {
      const context = runContext?.context;
      if (context === undefined) {
        return JSON.stringify(
          replyError(
            "error",
            new Error("reply requires a HuanLink RunContext"),
            options.redactValues
          )
        );
      }

      const metadata = options.sessions.getSessionMetadata(context.sessionId);
      if (metadata?.kind !== "external_channel") {
        return JSON.stringify(
          replyError(
            "error",
            new Error(
              `Session ${context.sessionId} is not an external Channel session`
            ),
            options.redactValues
          )
        );
      }

      const toolCallId = details?.toolCall?.callId;
      if (toolCallId === undefined || toolCallId.trim().length === 0) {
        return JSON.stringify(
          replyError(
            "error",
            new Error("reply requires the SDK Tool Call ID"),
            options.redactValues
          )
        );
      }

      const toolLogger = logger.child({
        runId: context.runId,
        sessionId: context.sessionId,
        toolName: CHANNEL_REPLY_TOOL_NAME,
        channelId: metadata.route.channelId,
        conversationKind: metadata.route.conversationKind,
        conversationId: metadata.route.conversationId
      });
      const storedArguments = replyArguments(input);
      try {
        options.sessions.appendAgentToolCall(context.sessionId, {
          runId: context.runId,
          toolCallId,
          toolName: CHANNEL_REPLY_TOOL_NAME,
          arguments: storedArguments
        });
      } catch (error) {
        toolLogger.error("channel.reply.tool_call_record_failed", {
          errorType: safeErrorType(error)
        });
        return JSON.stringify(
          replyError("error", error, options.redactValues)
        );
      }

      const complete = (result: ChannelReplyToolResult): string => {
        let output = result;
        try {
          options.sessions.appendAgentToolResult(context.sessionId, {
            runId: context.runId,
            toolCallId,
            toolName: CHANNEL_REPLY_TOOL_NAME,
            output
          });
        } catch (error) {
          toolLogger.error("channel.reply.tool_result_record_failed", {
            status: result.status,
            errorType: safeErrorType(error)
          });
          if (result.status === "success") {
            output = {
              ...result,
              warning: appendWarning(
                result.warning,
                formatReplyError(error, options.redactValues)
              )
            };
          }
        }
        toolLogger.info("channel.reply.completed", {
          status: output.status,
          ...(output.status === "success"
            ? { messageId: output.messageId }
            : {})
        });
        return JSON.stringify(output);
      };

      let adapter: ChannelAdapterV1 | undefined;
      try {
        adapter = options.resolveAdapter(metadata.route.channelId);
      } catch (error) {
        return complete(replyError("error", error, options.redactValues));
      }
      if (adapter === undefined) {
        return complete(
          replyError(
            "error",
            new Error(
              `No Channel Adapter is registered for ${metadata.route.channelId}`
            ),
            options.redactValues
          )
        );
      }

      toolLogger.info("channel.reply.sending");
      let receipt: Awaited<ReturnType<ChannelAdapterV1["send"]>>;
      try {
        receipt = await adapter.send({
          route: metadata.route,
          parts: input.parts as readonly ChannelOutboundMessagePartV1[],
          ...(input.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: input.replyToMessageId })
        });
      } catch (error) {
        const status =
          error instanceof ChannelOperationError &&
          error.code !== "delivery_uncertain"
            ? "error"
            : "uncertain";
        return complete(replyError(status, error, options.redactValues));
      }

      if (
        receipt.channelId !== metadata.route.channelId ||
        typeof receipt.messageId !== "string" ||
        receipt.messageId.trim().length === 0
      ) {
        return complete(
          replyError(
            "uncertain",
            new Error(
              "Channel send returned an invalid delivery receipt; the message may have been sent"
            ),
            options.redactValues
          )
        );
      }

      let warning: string | undefined;
      try {
        const sentAt = (options.now ?? (() => new Date()))().toISOString();
        options.sessions.recordOutboundDelivery(context.sessionId, {
          route: metadata.route,
          contentFormat: metadata.contentFormat,
          receipt,
          sentAt,
          runId: context.runId,
          toolCallId,
          sourceSessionId: context.sessionId
        });
      } catch (error) {
        warning = formatReplyError(error, options.redactValues);
        toolLogger.warn("channel.reply.session_association_failed", {
          messageId: receipt.messageId,
          errorType: safeErrorType(error)
        });
      }

      return complete({
        status: "success",
        tool: CHANNEL_REPLY_TOOL_NAME,
        messageId: receipt.messageId,
        ...(warning === undefined ? {} : { warning })
      });
    }
  });
}

function replyArguments(
  input: ChannelReplyToolInput
): Readonly<Record<string, ConversationJsonValue>> {
  return input as unknown as Readonly<Record<string, ConversationJsonValue>>;
}

function replyError(
  status: "error" | "uncertain",
  error: unknown,
  redactValues: readonly string[] | undefined
): ChannelReplyToolResult {
  return {
    status,
    tool: CHANNEL_REPLY_TOOL_NAME,
    error: formatReplyError(error, redactValues)
  };
}

/** 保留原始错误因果文本，仅移除明确配置的凭证和常见 Bearer 值。 */
function formatReplyError(
  error: unknown,
  redactValues: readonly string[] | undefined
): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    const previous = messages.at(-1);
    if (
      message.length > 0 &&
      previous !== message &&
      previous?.startsWith(message) !== true
    ) {
      messages.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  let result = messages.join(": ") || "Unknown reply error";
  for (const value of redactValues ?? []) {
    if (value.length > 0) {
      result = result.split(value).join("[Redacted]");
    }
  }
  return result.replace(/\bBearer\s+\S+/giu, "Bearer [Redacted]");
}

function appendWarning(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current}: ${next}`;
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
