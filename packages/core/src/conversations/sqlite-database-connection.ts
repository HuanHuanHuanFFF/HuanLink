import { DatabaseSync } from "node:sqlite";

import { applySqliteConversationMigrations } from "./sqlite-migrations.js";

/**
 * One SQLite connection and its lifecycle. Store contracts remain pure facts
 * interfaces; process composition owns this handle through the public factory.
 */
export interface SqliteDatabaseConnection {
  readonly database: DatabaseSync;
  assertOpen(message: string): void;
  close(): void;
}

export function openSqliteDatabaseConnection(
  databasePath: string,
): SqliteDatabaseConnection {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA busy_timeout = 5000");
    applySqliteConversationMigrations(database);
    return new OwnedSqliteDatabaseConnection(database);
  } catch (error) {
    database?.close();
    throw error;
  }
}

class OwnedSqliteDatabaseConnection implements SqliteDatabaseConnection {
  private closed = false;

  constructor(readonly database: DatabaseSync) {}

  assertOpen(message: string): void {
    if (this.closed) {
      throw new Error(message);
    }
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
