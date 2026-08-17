import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { SqliteConversationSessionStore } from "../src/index.js";
import { SqliteAsyncToolTaskStore } from "../src/async-tool-task/sqlite-async-tool-task-store.js";

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

  test("applies the Task tables through the existing migration chain", () => {
    const databasePath = temporaryDatabasePath();
    const store = new SqliteAsyncToolTaskStore(databasePath);
    store.close();

    const inspection = new DatabaseSync(databasePath);
    expect(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'async_tool_tasks'",
        )
        .get(),
    ).toEqual({ name: "async_tool_tasks" });
    expect(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'async_tool_task_private_refs'",
        )
        .get(),
    ).toEqual({ name: "async_tool_task_private_refs" });
    expect(
      inspection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    inspection.close();
  });

  test("upgrades a persisted v2 database without changing its recorded migrations", () => {
    const databasePath = temporaryDatabasePath();
    const initial = new SqliteConversationSessionStore(databasePath);
    initial.close();
    const database = new DatabaseSync(databasePath);
    const originalV1AndV2 = database
      .prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 2 ORDER BY version",
      )
      .all();
    database.exec(`
      DROP TABLE async_tool_task_private_refs;
      DROP TABLE async_tool_tasks;
      DELETE FROM schema_migrations WHERE version = 3;
    `);
    database.close();

    const fresh = new SqliteConversationSessionStore(databasePath);
    fresh.close();

    const inspection = new DatabaseSync(databasePath);
    expect(
      inspection
        .prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version <= 2 ORDER BY version",
        )
        .all(),
    ).toEqual(originalV1AndV2);
    expect(
      inspection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    inspection.close();
  });

  test("rolls back the whole v3 migration when its second table conflicts", () => {
    const databasePath = temporaryDatabasePath();
    const initial = new SqliteConversationSessionStore(databasePath);
    initial.close();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TABLE async_tool_task_private_refs;
      DROP TABLE async_tool_tasks;
      DELETE FROM schema_migrations WHERE version = 3;
      CREATE TABLE async_tool_task_private_refs (sentinel TEXT);
    `);
    database.close();

    expect(() => new SqliteAsyncToolTaskStore(databasePath)).toThrow();

    const inspection = new DatabaseSync(databasePath);
    expect(
      inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'async_tool_tasks'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      inspection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      inspection
        .prepare("PRAGMA table_info(async_tool_task_private_refs)")
        .all(),
    ).toMatchObject([{ name: "sentinel" }]);
    inspection.close();
  });
});
