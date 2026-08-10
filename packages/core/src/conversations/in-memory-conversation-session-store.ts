import {
  assertValidInboundChannelMessage,
  type ChannelConversationRoute,
  type InboundChannelMessage,
} from "../channels/contract.js";
import type { SessionId } from "../shared/ids.js";

import type {
  AppendConversationAgentToolCall,
  AppendConversationAgentToolResult,
  ConversationAgentToolCallEntry,
  ConversationChannelMessageEntry,
  ConversationSession,
  ConversationSessionMetadata,
  ConversationTimelineEntry,
  RecordConversationOutboundDelivery,
} from "./conversation-session.js";
import {
  assertPendingConversationTarget,
  assertSameChannelMessageSession,
  channelMessageKey,
  createPendingConversationOutboundDelivery,
  isSameConversationOutboundDelivery,
  isSameInboundChannelMessage,
  isSamePendingConversationOutboundDelivery,
  type PendingConversationOutboundDelivery,
  validateConversationOutboundDeliveryRecord,
} from "./conversation-session-facts.js";
import type { ConversationSessionStore } from "./conversation-session-store.js";
import {
  cloneChannelConversationRoute,
  cloneConversationJsonRecord,
  cloneConversationJsonValue,
  cloneConversationSession,
  cloneConversationSessionMetadata,
  cloneInboundChannelMessage,
} from "./conversation-session-copy.js";
import {
  isSameConversationRoute,
  requireConversationIdentifier,
  validateConversationToolIdentity,
} from "./conversation-session-validation.js";

type MutableConversationSession = {
  metadata: ConversationSessionMetadata;
  timeline: ConversationTimelineEntry[];
};

type MessageLocation = {
  sessionId: SessionId;
  entry: ConversationChannelMessageEntry;
};

/**
 * B07 的进程内结构化 Conversation Session 存储。
 *
 * 它只保存和合并事实，不负责把时间线投影成特定模型的输入，也不提供
 * 跨进程持久化。
 */
export class InMemoryConversationSessionStore implements ConversationSessionStore {
  private readonly sessions = new Map<SessionId, MutableConversationSession>();
  private readonly messageLocations = new Map<string, MessageLocation>();
  private readonly pendingOutboundDeliveries = new Map<
    string,
    PendingConversationOutboundDelivery
  >();

  /** 追加平台观测消息；完全相同的重复事实幂等，冲突事实拒绝覆盖。 */
  appendChannelMessage(
    sessionId: SessionId,
    message: InboundChannelMessage,
  ): "appended" | "duplicate" | "associated" {
    assertValidInboundChannelMessage(message);
    const key = channelMessageKey(message.route.channelId, message.messageId);
    const pending = this.pendingOutboundDeliveries.get(key);
    const existing = this.messageLocations.get(key);
    if (existing !== undefined) {
      assertSameChannelMessageSession(key, sessionId, existing.sessionId);
      if (
        existing.entry.observed === undefined ||
        !isSameInboundChannelMessage(existing.entry.observed, message)
      ) {
        throw new Error(
          `Channel message ${message.messageId} conflicts with existing observed facts`,
        );
      }
      if (pending !== undefined) {
        assertPendingConversationTarget(
          pending,
          key,
          sessionId,
          message.route,
          message.contentFormat,
        );
      }
      if (
        (existing.entry.outbound !== undefined || pending !== undefined) &&
        !message.sender.isSelf
      ) {
        throw new Error(
          `Channel message ${key} has a HuanLink outbound delivery but the observed sender is not self`,
        );
      }
      if (pending !== undefined) {
        if (
          existing.entry.outbound !== undefined &&
          !isSameConversationOutboundDelivery(
            existing.entry.outbound,
            pending.outbound,
          )
        ) {
          throw new Error(
            `Channel message ${message.messageId} already has a different outbound association`,
          );
        }
        if (existing.entry.outbound === undefined) {
          const session = this.requireSession(sessionId);
          existing.entry = { ...existing.entry, outbound: pending.outbound };
          replaceTimelineEntry(session.timeline, existing.entry);
        }
        this.pendingOutboundDeliveries.delete(key);
        return "associated";
      }
      return "duplicate";
    }

    if (pending !== undefined) {
      assertPendingConversationTarget(
        pending,
        key,
        sessionId,
        message.route,
        message.contentFormat,
      );
      if (!message.sender.isSelf) {
        throw new Error(
          `Channel message ${key} has a HuanLink outbound delivery but the observed sender is not self`,
        );
      }
    }
    const session = this.ensureSession(
      sessionId,
      message.route,
      message.contentFormat,
    );

    const entry: ConversationChannelMessageEntry = {
      type: "channel_message",
      channelId: message.route.channelId,
      messageId: message.messageId,
      observed: cloneInboundChannelMessage(message),
      ...(pending === undefined ? {} : { outbound: pending.outbound }),
    };
    session.timeline.push(entry);
    this.messageLocations.set(key, { sessionId, entry });
    if (pending !== undefined) {
      this.pendingOutboundDeliveries.delete(key);
    }
    return "appended";
  }

  /**
   * 登记已取得有效消息 ID 的发送结果；回流前只保存内部关联，不创建公开消息。
   */
  recordOutboundDelivery(
    targetSessionId: SessionId,
    delivery: RecordConversationOutboundDelivery,
  ): void {
    validateConversationOutboundDeliveryRecord(targetSessionId, delivery);

    const sourceSession = this.sessions.get(delivery.sourceSessionId);
    const sourceToolCall =
      sourceSession === undefined
        ? undefined
        : findToolCall(
            sourceSession.timeline,
            delivery.runId,
            delivery.toolCallId,
          );
    if (sourceToolCall === undefined) {
      throw new Error(
        `Outbound delivery source Tool Call ${delivery.runId} / ${delivery.toolCallId} does not exist in session ${delivery.sourceSessionId}`,
      );
    }

    const key = channelMessageKey(
      delivery.receipt.channelId,
      delivery.receipt.messageId,
    );
    const pending = createPendingConversationOutboundDelivery(
      targetSessionId,
      delivery,
    );
    const outbound = pending.outbound;
    const existing = this.messageLocations.get(key);
    if (existing !== undefined) {
      assertSameChannelMessageSession(key, targetSessionId, existing.sessionId);
      const targetSession = this.requireSession(targetSessionId);
      assertSessionMetadata(
        targetSession,
        targetSessionId,
        delivery.route,
        delivery.contentFormat,
      );
      if (
        existing.entry.observed !== undefined &&
        !existing.entry.observed.sender.isSelf
      ) {
        throw new Error(
          `Channel message ${key} is not a self message and cannot receive a HuanLink outbound association`,
        );
      }
      if (existing.entry.outbound !== undefined) {
        if (
          !isSameConversationOutboundDelivery(existing.entry.outbound, outbound)
        ) {
          throw new Error(
            `Channel message ${delivery.receipt.messageId} already has a different outbound association`,
          );
        }
        return;
      }
      existing.entry = { ...existing.entry, outbound };
      replaceTimelineEntry(targetSession.timeline, existing.entry);
      return;
    }

    const targetSession = this.sessions.get(targetSessionId);
    if (targetSession !== undefined) {
      assertSessionMetadata(
        targetSession,
        targetSessionId,
        delivery.route,
        delivery.contentFormat,
      );
    }
    const previousPending = this.pendingOutboundDeliveries.get(key);
    if (previousPending !== undefined) {
      if (
        !isSamePendingConversationOutboundDelivery(previousPending, pending)
      ) {
        throw new Error(
          `Channel message ${delivery.receipt.messageId} already has a different outbound association`,
        );
      }
      return;
    }
    this.pendingOutboundDeliveries.set(key, pending);
  }

  /** 追加一个结构化 Tool Call，并拒绝同一 run 内的重复调用 ID。 */
  appendAgentToolCall(
    sessionId: SessionId,
    call: AppendConversationAgentToolCall,
  ): void {
    const session = this.requireSession(sessionId);
    validateConversationToolIdentity(call, "Agent Tool Call");
    if (
      findToolCall(session.timeline, call.runId, call.toolCallId) !== undefined
    ) {
      throw new Error(
        `Agent Tool Call ${call.runId} / ${call.toolCallId} already exists in session ${sessionId}`,
      );
    }
    session.timeline.push({
      type: "agent_tool_call",
      runId: call.runId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      arguments: cloneConversationJsonRecord(
        call.arguments,
        "Agent Tool Call arguments",
      ),
    });
  }

  /** 追加与已有调用严格配对的 Tool Result。 */
  appendAgentToolResult(
    sessionId: SessionId,
    result: AppendConversationAgentToolResult,
  ): void {
    const session = this.requireSession(sessionId);
    validateConversationToolIdentity(result, "Agent Tool Result");
    const call = findToolCall(
      session.timeline,
      result.runId,
      result.toolCallId,
    );
    if (call === undefined) {
      throw new Error(
        `Agent Tool Result ${result.toolCallId} has no Tool Call in session ${sessionId}`,
      );
    }
    if (call.runId !== result.runId || call.toolName !== result.toolName) {
      throw new Error(
        `Agent Tool Result ${result.toolCallId} does not match its Tool Call`,
      );
    }
    if (
      session.timeline.some(
        (entry) =>
          entry.type === "agent_tool_result" &&
          entry.runId === result.runId &&
          entry.toolCallId === result.toolCallId,
      )
    ) {
      throw new Error(
        `Agent Tool Result ${result.toolCallId} already exists in session ${sessionId}`,
      );
    }
    const callIndex = session.timeline.indexOf(call);
    session.timeline.splice(callIndex + 1, 0, {
      type: "agent_tool_result",
      runId: result.runId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: cloneConversationJsonValue(
        result.output,
        "Agent Tool Result output",
      ),
    });
  }

  /** 返回结构化 Session 的完整防御性副本。 */
  getSession(sessionId: SessionId): ConversationSession | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined
      ? undefined
      : cloneConversationSession(session);
  }

  /** 返回固定 Session 元数据，不复制可能持续增长的时间线。 */
  getSessionMetadata(
    sessionId: SessionId,
  ): ConversationSessionMetadata | undefined {
    const metadata = this.sessions.get(sessionId)?.metadata;
    return metadata === undefined
      ? undefined
      : cloneConversationSessionMetadata(metadata);
  }

  private ensureSession(
    sessionId: SessionId,
    route: ChannelConversationRoute,
    contentFormat: string,
  ): MutableConversationSession {
    requireConversationIdentifier(sessionId, "Conversation sessionId");
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) {
      const created = {
        metadata: {
          kind: "external_channel" as const,
          route: cloneChannelConversationRoute(route),
          contentFormat,
        },
        timeline: [],
      };
      this.sessions.set(sessionId, created);
      return created;
    }

    if (!isSameConversationRoute(existing.metadata.route, route)) {
      throw new Error(`Conversation session ${sessionId} route cannot change`);
    }
    if (existing.metadata.contentFormat !== contentFormat) {
      throw new Error(
        `Conversation session ${sessionId} content format cannot change`,
      );
    }
    return existing;
  }

  private requireSession(sessionId: SessionId): MutableConversationSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown conversation session ${sessionId}`);
    }
    return session;
  }
}

function assertSessionMetadata(
  session: MutableConversationSession,
  sessionId: SessionId,
  route: ChannelConversationRoute,
  contentFormat: string,
): void {
  if (!isSameConversationRoute(session.metadata.route, route)) {
    throw new Error(`Conversation session ${sessionId} route cannot change`);
  }
  if (session.metadata.contentFormat !== contentFormat) {
    throw new Error(
      `Conversation session ${sessionId} content format cannot change`,
    );
  }
}

function replaceTimelineEntry(
  timeline: ConversationTimelineEntry[],
  replacement: ConversationChannelMessageEntry,
): void {
  const index = timeline.findIndex(
    (entry) =>
      entry.type === "channel_message" &&
      entry.channelId === replacement.channelId &&
      entry.messageId === replacement.messageId,
  );
  if (index < 0) {
    throw new Error("Conversation message index is inconsistent");
  }
  timeline[index] = replacement;
}

function findToolCall(
  timeline: readonly ConversationTimelineEntry[],
  runId: string,
  toolCallId: string,
): ConversationAgentToolCallEntry | undefined {
  return timeline.find(
    (entry): entry is ConversationAgentToolCallEntry =>
      entry.type === "agent_tool_call" &&
      entry.runId === runId &&
      entry.toolCallId === toolCallId,
  );
}
