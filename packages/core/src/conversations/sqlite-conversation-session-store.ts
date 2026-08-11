import { DatabaseSync } from "node:sqlite";

import {
  assertValidInboundChannelMessage,
  type ChannelConversationRoute,
  type InboundChannelMessage,
} from "../channels/contract.js";
import type { RunId, SessionId } from "../shared/ids.js";

import {
  cloneConversationSession,
  cloneConversationAgentToolCallPayload,
  cloneConversationSessionContextWindow,
  cloneConversationSessionMetadata,
  cloneConversationJsonRecord,
  cloneConversationJsonValue,
  cloneInboundChannelMessage,
} from "./conversation-session-copy.js";
import type {
  AppendConversationAgentToolCall,
  AppendConversationAgentToolResult,
  ConversationChannelMessageEntry,
  ConversationAgentToolCallEntry,
  ConversationAgentToolResultEntry,
  ConversationSession,
  ConversationSessionContextWindow,
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
  isSameConversationRoute,
  requireConversationIdentifier,
  validateConversationToolCallPayload,
  validateConversationToolIdentity,
} from "./conversation-session-validation.js";
import {
  parseSqlitePendingOutboundDelivery,
  parseSqliteSessionMetadata,
  parseSqliteStoredEntry,
  parseSqliteStoredMessage,
  type SqliteEntryRow,
  type SqliteMessageRow,
  type SqliteOutboundDeliveryRow,
  type SqliteSessionRow,
  type SqliteToolCallRow,
} from "./sqlite-conversation-codec.js";
import { applySqliteConversationMigrations } from "./sqlite-migrations.js";

const ENTRY_INDEX_STRIDE = 1024;

/** SQLite-backed Conversation Store with persistent Channel and Tool facts. */
export class SqliteConversationSessionStore implements ConversationSessionStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.database.exec("PRAGMA busy_timeout = 5000");
      applySqliteConversationMigrations(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  appendChannelMessage(
    sessionId: SessionId,
    message: InboundChannelMessage,
  ): "appended" | "duplicate" | "associated" {
    this.assertOpen();
    assertValidInboundChannelMessage(message);
    const storedMessage = cloneInboundChannelMessage(message);

    return this.inTransaction(() => {
      const pending = this.findPendingOutboundDelivery(
        storedMessage.route.channelId,
        storedMessage.messageId,
      );
      const existing = this.findMessage(
        storedMessage.route.channelId,
        storedMessage.messageId,
      );
      if (existing !== undefined) {
        assertSameChannelMessageSession(
          channelMessageKey(
            storedMessage.route.channelId,
            storedMessage.messageId,
          ),
          sessionId,
          existing.session_id,
        );
        if (
          !isSameInboundChannelMessage(
            parseSqliteStoredMessage(existing),
            storedMessage,
          )
        ) {
          throw new Error(
            `Channel message ${storedMessage.messageId} conflicts with existing observed facts`,
          );
        }
        if (pending !== undefined) {
          assertPendingConversationTarget(
            pending,
            channelMessageKey(
              storedMessage.route.channelId,
              storedMessage.messageId,
            ),
            sessionId,
            storedMessage.route,
            storedMessage.contentFormat,
          );
        }
        const existingEntry = this.readMessageEntry(existing);
        if (
          (existingEntry.outbound !== undefined || pending !== undefined) &&
          !storedMessage.sender.isSelf
        ) {
          throw new Error(
            `Channel message ${channelMessageKey(storedMessage.route.channelId, storedMessage.messageId)} has a HuanLink outbound delivery but the observed sender is not self`,
          );
        }
        if (pending !== undefined) {
          if (
            existingEntry.outbound !== undefined &&
            !isSameConversationOutboundDelivery(
              existingEntry.outbound,
              pending.outbound,
            )
          ) {
            throw new Error(
              `Channel message ${storedMessage.messageId} already has a different outbound association`,
            );
          }
          if (existingEntry.outbound === undefined) {
            this.updateMessageEntry(existing, {
              ...existingEntry,
              outbound: pending.outbound,
            });
          }
          this.deletePendingOutboundDelivery(
            storedMessage.route.channelId,
            storedMessage.messageId,
          );
          return "associated";
        }
        return "duplicate";
      }

      if (pending !== undefined) {
        assertPendingConversationTarget(
          pending,
          channelMessageKey(
            storedMessage.route.channelId,
            storedMessage.messageId,
          ),
          sessionId,
          storedMessage.route,
          storedMessage.contentFormat,
        );
        if (!storedMessage.sender.isSelf) {
          throw new Error(
            `Channel message ${channelMessageKey(storedMessage.route.channelId, storedMessage.messageId)} has a HuanLink outbound delivery but the observed sender is not self`,
          );
        }
      }
      this.ensureSession(
        sessionId,
        storedMessage.route,
        storedMessage.contentFormat,
      );
      const entryIndex = this.nextEntryIndex(sessionId);
      const entry: ConversationChannelMessageEntry = {
        type: "channel_message",
        channelId: storedMessage.route.channelId,
        messageId: storedMessage.messageId,
        observed: storedMessage,
        ...(pending === undefined ? {} : { outbound: pending.outbound }),
      };
      this.insertEntry(sessionId, entryIndex, entry);
      this.database
        .prepare(
          `INSERT INTO channel_messages
             (channel_id, message_id, session_id, entry_index, observed_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          storedMessage.route.channelId,
          storedMessage.messageId,
          sessionId,
          entryIndex,
          JSON.stringify(storedMessage),
        );
      if (pending !== undefined) {
        this.deletePendingOutboundDelivery(
          storedMessage.route.channelId,
          storedMessage.messageId,
        );
      }
      return "appended";
    });
  }

  recordOutboundDelivery(
    targetSessionId: SessionId,
    delivery: RecordConversationOutboundDelivery,
  ): void {
    this.assertOpen();
    validateConversationOutboundDeliveryRecord(targetSessionId, delivery);
    const pending = createPendingConversationOutboundDelivery(
      targetSessionId,
      delivery,
    );
    const outbound = pending.outbound;

    this.inTransaction(() => {
      const sourceToolCall = this.findToolCall(
        delivery.sourceSessionId,
        delivery.runId,
        delivery.toolCallId,
      );
      if (sourceToolCall === undefined) {
        throw new Error(
          `Outbound delivery source Tool Call ${delivery.runId} / ${delivery.toolCallId} does not exist in session ${delivery.sourceSessionId}`,
        );
      }

      const existing = this.findMessage(
        delivery.receipt.channelId,
        delivery.receipt.messageId,
      );
      if (existing !== undefined) {
        assertSameChannelMessageSession(
          channelMessageKey(
            delivery.receipt.channelId,
            delivery.receipt.messageId,
          ),
          targetSessionId,
          existing.session_id,
        );
        this.assertSessionMetadata(
          targetSessionId,
          delivery.route,
          delivery.contentFormat,
        );
        const entry = this.readMessageEntry(existing);
        if (entry.observed !== undefined && !entry.observed.sender.isSelf) {
          throw new Error(
            `Channel message ${channelMessageKey(delivery.receipt.channelId, delivery.receipt.messageId)} is not a self message and cannot receive a HuanLink outbound association`,
          );
        }
        if (entry.outbound !== undefined) {
          if (!isSameConversationOutboundDelivery(entry.outbound, outbound)) {
            throw new Error(
              `Channel message ${delivery.receipt.messageId} already has a different outbound association`,
            );
          }
          return;
        }
        this.updateMessageEntry(existing, { ...entry, outbound });
        return;
      }

      if (this.readMetadata(targetSessionId) !== undefined) {
        this.assertSessionMetadata(
          targetSessionId,
          delivery.route,
          delivery.contentFormat,
        );
      }
      const previousPending = this.findPendingOutboundDelivery(
        delivery.receipt.channelId,
        delivery.receipt.messageId,
      );
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
      this.database
        .prepare(
          `INSERT INTO outbound_deliveries
             (channel_id, message_id, payload_json)
           VALUES (?, ?, ?)`,
        )
        .run(
          delivery.receipt.channelId,
          delivery.receipt.messageId,
          JSON.stringify(pending),
        );
    });
  }

  appendAgentToolCall(
    sessionId: SessionId,
    call: AppendConversationAgentToolCall,
  ): void {
    this.assertOpen();
    validateConversationToolIdentity(call, "Agent Tool Call");
    validateConversationToolCallPayload(call, "Agent Tool Call");
    this.inTransaction(() => {
      this.requireExistingSession(sessionId);
      const exists = this.findToolCall(sessionId, call.runId, call.toolCallId);
      if (exists !== undefined)
        throw new Error(
          `Agent Tool Call ${call.runId} / ${call.toolCallId} already exists in session ${sessionId}`,
        );
      const entryIndex = this.nextEntryIndex(sessionId);
      const entry: ConversationAgentToolCallEntry = {
        type: "agent_tool_call",
        runId: call.runId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...cloneConversationAgentToolCallPayload(call),
      };
      this.insertEntry(sessionId, entryIndex, entry);
      this.database
        .prepare(
          "INSERT INTO conversation_tool_calls (session_id, run_id, tool_call_id, tool_name, entry_index) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, call.runId, call.toolCallId, call.toolName, entryIndex);
    });
  }

  appendAgentToolResult(
    sessionId: SessionId,
    result: AppendConversationAgentToolResult,
  ): void {
    this.assertOpen();
    validateConversationToolIdentity(result, "Agent Tool Result");
    this.inTransaction(() => {
      this.requireExistingSession(sessionId);
      const call = this.findToolCall(
        sessionId,
        result.runId,
        result.toolCallId,
      );
      if (call === undefined)
        throw new Error(
          `Agent Tool Result ${result.toolCallId} has no Tool Call in session ${sessionId}`,
        );
      if (call.tool_name !== result.toolName)
        throw new Error(
          `Agent Tool Result ${result.toolCallId} does not match its Tool Call`,
        );
      const exists = this.database
        .prepare(
          "SELECT 1 FROM conversation_tool_results WHERE session_id = ? AND run_id = ? AND tool_call_id = ?",
        )
        .get(sessionId, result.runId, result.toolCallId);
      if (exists !== undefined)
        throw new Error(
          `Agent Tool Result ${result.toolCallId} already exists in session ${sessionId}`,
        );
      const entry: ConversationAgentToolResultEntry = {
        type: "agent_tool_result",
        runId: result.runId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: cloneConversationJsonValue(
          result.output,
          "Agent Tool Result output",
        ),
      };
      this.insertEntry(sessionId, call.entry_index + 1, entry);
      this.database
        .prepare(
          "INSERT INTO conversation_tool_results (session_id, run_id, tool_call_id, tool_name, entry_index) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          sessionId,
          result.runId,
          result.toolCallId,
          result.toolName,
          call.entry_index + 1,
        );
    });
  }

  getAgentToolCall(
    sessionId: SessionId,
    runId: RunId,
    toolCallId: string,
  ): ConversationAgentToolCallEntry | undefined {
    this.assertOpen();
    const call = this.findToolCall(sessionId, runId, toolCallId);
    if (call === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT entry_index, payload_json
         FROM conversation_entries
         WHERE session_id = ? AND entry_index = ?`,
      )
      .get(sessionId, call.entry_index) as SqliteEntryRow | undefined;
    if (row === undefined) {
      throw new Error("SQLite conversation Tool Call index is inconsistent");
    }
    const entry = parseSqliteStoredEntry(row);
    if (entry.type !== "agent_tool_call") {
      throw new Error(
        "SQLite conversation Tool Call index points to a non-Tool-Call entry",
      );
    }
    if (
      entry.runId !== runId ||
      entry.toolCallId !== toolCallId ||
      entry.toolName !== call.tool_name
    ) {
      throw new Error("SQLite conversation Tool Call index is inconsistent");
    }
    return {
      type: "agent_tool_call",
      runId: entry.runId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      ...cloneConversationAgentToolCallPayload(entry),
    };
  }

  getSession(sessionId: SessionId): ConversationSession | undefined {
    this.assertOpen();
    const metadata = this.readMetadata(sessionId);
    if (metadata === undefined) {
      return undefined;
    }
    const rows = this.database
      .prepare(
        `SELECT entry_index, payload_json
         FROM conversation_entries
         WHERE session_id = ?
         ORDER BY entry_index ASC`,
      )
      .all(sessionId) as SqliteEntryRow[];
    const timeline = rows.map((row) => parseSqliteStoredEntry(row));
    return cloneConversationSession({ metadata, timeline });
  }

  getSessionContextWindow(
    sessionId: SessionId,
  ): ConversationSessionContextWindow | undefined {
    this.assertOpen();
    const metadata = this.readMetadata(sessionId);
    if (metadata === undefined) {
      return undefined;
    }
    const rows = this.database
      .prepare(
        `SELECT entry_index, payload_json
         FROM conversation_entries
         WHERE session_id = ?
         ORDER BY entry_index ASC`,
      )
      .all(sessionId) as SqliteEntryRow[];
    return cloneConversationSessionContextWindow({
      metadata,
      entries: rows.map((row) => ({
        entryIndex: row.entry_index,
        entry: parseSqliteStoredEntry(row),
      })),
    });
  }

  getSessionMetadata(
    sessionId: SessionId,
  ): ConversationSessionMetadata | undefined {
    this.assertOpen();
    const metadata = this.readMetadata(sessionId);
    return metadata === undefined
      ? undefined
      : cloneConversationSessionMetadata(metadata);
  }

  /** Closes the underlying database. Safe to call more than once. */
  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private ensureSession(
    sessionId: SessionId,
    route: ChannelConversationRoute,
    contentFormat: string,
  ): void {
    requireConversationIdentifier(sessionId, "Conversation sessionId");
    const existing = this.database
      .prepare(
        `SELECT kind, route_json, content_format
         FROM conversation_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as SqliteSessionRow | undefined;
    if (existing === undefined) {
      this.database
        .prepare(
          `INSERT INTO conversation_sessions
             (session_id, kind, route_json, content_format)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          "external_channel",
          JSON.stringify(route),
          contentFormat,
        );
      return;
    }
    const metadata = parseSqliteSessionMetadata(existing);
    if (!isSameConversationRoute(metadata.route, route)) {
      throw new Error(`Conversation session ${sessionId} route cannot change`);
    }
    if (metadata.contentFormat !== contentFormat) {
      throw new Error(
        `Conversation session ${sessionId} content format cannot change`,
      );
    }
  }

  private nextEntryIndex(sessionId: SessionId): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(entry_index) + ?, ?) AS entry_index
         FROM conversation_entries
         WHERE session_id = ?`,
      )
      .get(ENTRY_INDEX_STRIDE, ENTRY_INDEX_STRIDE, sessionId) as {
      entry_index: number;
    };
    // B02 inserts a Tool Result immediately after its Tool Call, so tail entries
    // intentionally leave numeric slots without renumbering persisted history.
    return row.entry_index;
  }

  private insertEntry(
    sessionId: SessionId,
    entryIndex: number,
    entry: ConversationTimelineEntry,
  ): void {
    this.database
      .prepare(
        "INSERT INTO conversation_entries (session_id, entry_index, entry_type, payload_json) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, entryIndex, entry.type, JSON.stringify(entry));
  }

  private findToolCall(
    sessionId: SessionId,
    runId: string,
    toolCallId: string,
  ): SqliteToolCallRow | undefined {
    return this.database
      .prepare(
        "SELECT tool_name, entry_index FROM conversation_tool_calls WHERE session_id = ? AND run_id = ? AND tool_call_id = ?",
      )
      .get(sessionId, runId, toolCallId) as SqliteToolCallRow | undefined;
  }

  private findMessage(
    channelId: string,
    messageId: string,
  ): SqliteMessageRow | undefined {
    return this.database
      .prepare(
        `SELECT session_id, entry_index, observed_json
         FROM channel_messages
         WHERE channel_id = ? AND message_id = ?`,
      )
      .get(channelId, messageId) as SqliteMessageRow | undefined;
  }

  private readMessageEntry(
    location: Pick<SqliteMessageRow, "session_id" | "entry_index">,
  ): ConversationChannelMessageEntry {
    const row = this.database
      .prepare(
        `SELECT entry_index, payload_json
         FROM conversation_entries
         WHERE session_id = ? AND entry_index = ?`,
      )
      .get(location.session_id, location.entry_index) as
      | SqliteEntryRow
      | undefined;
    if (row === undefined) {
      throw new Error("SQLite conversation message index is inconsistent");
    }
    const entry = parseSqliteStoredEntry(row);
    if (entry.type !== "channel_message") {
      throw new Error(
        "SQLite conversation message index points to a non-message entry",
      );
    }
    return entry;
  }

  private updateMessageEntry(
    location: Pick<SqliteMessageRow, "session_id" | "entry_index">,
    entry: ConversationChannelMessageEntry,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE conversation_entries
         SET payload_json = ?
         WHERE session_id = ? AND entry_index = ? AND entry_type = ?`,
      )
      .run(
        JSON.stringify(entry),
        location.session_id,
        location.entry_index,
        "channel_message",
      );
    if (result.changes !== 1) {
      throw new Error("SQLite conversation message index is inconsistent");
    }
  }

  private findPendingOutboundDelivery(
    channelId: string,
    messageId: string,
  ): PendingConversationOutboundDelivery | undefined {
    const row = this.database
      .prepare(
        `SELECT payload_json
         FROM outbound_deliveries
         WHERE channel_id = ? AND message_id = ?`,
      )
      .get(channelId, messageId) as SqliteOutboundDeliveryRow | undefined;
    return row === undefined
      ? undefined
      : parseSqlitePendingOutboundDelivery(row);
  }

  private deletePendingOutboundDelivery(
    channelId: string,
    messageId: string,
  ): void {
    this.database
      .prepare(
        `DELETE FROM outbound_deliveries
         WHERE channel_id = ? AND message_id = ?`,
      )
      .run(channelId, messageId);
  }

  private assertSessionMetadata(
    sessionId: SessionId,
    route: ChannelConversationRoute,
    contentFormat: string,
  ): void {
    const metadata = this.readMetadata(sessionId);
    if (metadata === undefined) {
      throw new Error(`Unknown conversation session ${sessionId}`);
    }
    if (!isSameConversationRoute(metadata.route, route)) {
      throw new Error(`Conversation session ${sessionId} route cannot change`);
    }
    if (metadata.contentFormat !== contentFormat) {
      throw new Error(
        `Conversation session ${sessionId} content format cannot change`,
      );
    }
  }

  private requireExistingSession(sessionId: SessionId): void {
    if (this.readMetadata(sessionId) === undefined)
      throw new Error(`Unknown conversation session ${sessionId}`);
  }

  private readMetadata(
    sessionId: SessionId,
  ): ConversationSessionMetadata | undefined {
    const row = this.database
      .prepare(
        `SELECT kind, route_json, content_format
         FROM conversation_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as SqliteSessionRow | undefined;
    return row === undefined ? undefined : parseSqliteSessionMetadata(row);
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SQLite Conversation Store is closed");
    }
  }
}
