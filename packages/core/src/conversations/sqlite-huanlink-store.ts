import type { AsyncToolTaskStore } from "../async-tool-task/async-tool-task-store.js";
import { SqliteAsyncToolTaskStore } from "../async-tool-task/sqlite-async-tool-task-store.js";

import type { ConversationSessionStore } from "./conversation-session-store.js";
import {
  openSqliteDatabaseConnection,
  type SqliteDatabaseConnection,
} from "./sqlite-database-connection.js";
import { SqliteConversationSessionStore } from "./sqlite-conversation-session-store.js";

/** The paired SQLite Store facades owned by one process-level database handle. */
export type SqliteHuanLinkStore = {
  readonly sessionStore: ConversationSessionStore;
  readonly taskStore: AsyncToolTaskStore;
  close(): void;
};

/**
 * Opens the single SQLite connection used by HuanLink production runtime.
 * It configures and migrates the database once, then shares it between facts
 * Stores. Call close once during process shutdown.
 */
export function openSqliteHuanLinkStore(
  databasePath: string,
): SqliteHuanLinkStore {
  const connection = openSqliteDatabaseConnection(databasePath);
  try {
    return createSqliteHuanLinkStore(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}

function createSqliteHuanLinkStore(
  connection: SqliteDatabaseConnection,
): SqliteHuanLinkStore {
  return {
    sessionStore:
      SqliteConversationSessionStore.fromSharedConnection(connection),
    taskStore: SqliteAsyncToolTaskStore.fromSharedConnection(connection),
    close: () => connection.close(),
  };
}
