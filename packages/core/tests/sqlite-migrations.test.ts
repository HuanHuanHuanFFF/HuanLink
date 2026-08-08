import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { SqliteConversationSessionStore } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "huanlink-sqlite-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "conversation.sqlite");
}

describe("SQLite Conversation migrations", () => {
  test("rejects non-contiguous migration history", () => {
    const databasePath = temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (2, 'invalid', 'invalid', 'now');
    `);
    database.close();

    expect(() => new SqliteConversationSessionStore(databasePath)).toThrow(
      /migration history must be contiguous/i,
    );
  });

  test("rejects a changed applied migration definition", () => {
    const databasePath = temporaryDatabasePath();
    const store = new SqliteConversationSessionStore(databasePath);
    store.close();
    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE schema_migrations SET name = ? WHERE version = 1")
      .run("changed-name");
    database.close();

    expect(() => new SqliteConversationSessionStore(databasePath)).toThrow(
      /migration 1 does not match the embedded definition/i,
    );
  });

  test("rolls back migration bootstrap when the first migration fails", () => {
    const databasePath = temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE conversation_sessions (invalid TEXT)");
    database.close();

    expect(() => new SqliteConversationSessionStore(databasePath)).toThrow();

    const inspection = new DatabaseSync(databasePath);
    expect(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get(),
    ).toBeUndefined();
    inspection.close();
  });
});
