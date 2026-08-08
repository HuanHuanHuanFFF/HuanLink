import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type SqliteConversationMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
};

const SCHEMA_V1_SQL = `
CREATE TABLE conversation_sessions (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  route_json TEXT NOT NULL,
  content_format TEXT NOT NULL
);
CREATE TABLE conversation_entries (
  session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id),
  entry_index INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, entry_index)
);
CREATE TABLE channel_messages (
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entry_index INTEGER NOT NULL,
  observed_json TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id),
  FOREIGN KEY (session_id, entry_index)
    REFERENCES conversation_entries(session_id, entry_index)
);
CREATE TABLE outbound_deliveries (
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);`;

const SCHEMA_V2_SQL = `
CREATE TABLE conversation_tool_calls (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entry_index INTEGER NOT NULL,
  PRIMARY KEY (session_id, run_id, tool_call_id),
  FOREIGN KEY (session_id, entry_index)
    REFERENCES conversation_entries(session_id, entry_index)
);
CREATE TABLE conversation_tool_results (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entry_index INTEGER NOT NULL,
  PRIMARY KEY (session_id, run_id, tool_call_id),
  FOREIGN KEY (session_id, entry_index)
    REFERENCES conversation_entries(session_id, entry_index),
  FOREIGN KEY (session_id, run_id, tool_call_id)
    REFERENCES conversation_tool_calls(session_id, run_id, tool_call_id)
);`;

const MIGRATIONS: readonly SqliteConversationMigration[] = [
  defineMigration(1, "conversation-store-v1", SCHEMA_V1_SQL),
  defineMigration(2, "conversation-store-v2", SCHEMA_V2_SQL),
];

/** Applies the embedded Conversation schema atomically and only in order. */
export function applySqliteConversationMigrations(
  database: DatabaseSync,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = database
      .prepare(
        `SELECT version, name, checksum
         FROM schema_migrations
         ORDER BY version`,
      )
      .all() as Array<{ version: number; name: string; checksum: string }>;

    for (let index = 0; index < applied.length; index += 1) {
      const actual = applied[index]!;
      const expected = MIGRATIONS[index];
      if (actual.version !== index + 1) {
        throw new Error(
          "Conversation schema migration history must be contiguous",
        );
      }
      if (
        expected === undefined ||
        actual.version !== expected.version ||
        actual.name !== expected.name ||
        actual.checksum !== expected.checksum
      ) {
        throw new Error(
          `Conversation schema migration ${actual.version} does not match the embedded definition`,
        );
      }
    }

    for (let index = applied.length; index < MIGRATIONS.length; index += 1) {
      const migration = MIGRATIONS[index]!;
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations
             (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function defineMigration(
  version: number,
  name: string,
  sql: string,
): SqliteConversationMigration {
  return {
    version,
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}
