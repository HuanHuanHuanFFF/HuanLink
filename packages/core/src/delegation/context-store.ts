import type { SqliteDatabaseConnection } from "../conversations/sqlite-database-connection.js";
import type { DelegationRecord, DelegationStore } from "./types.js";
import { delegationSourceKey } from "./types.js";
import { integer, parseDelegationContext } from "./validation.js";

function validated(
  record: DelegationRecord,
  previous?: DelegationRecord,
): DelegationRecord {
  const copy = structuredClone(record);
  copy.pack = parseDelegationContext(copy.pack);
  if (
    previous &&
    previous.pack.revision === copy.pack.revision &&
    JSON.stringify(previous.pack) !== JSON.stringify(copy.pack)
  )
    throw new Error(
      "Delegation revision cannot be rebound to different context bytes",
    );
  integer(copy.receivedRevision);
  if (
    copy.sourceKey !==
      delegationSourceKey(copy.sessionId, copy.runId, copy.sourceToolCallId) ||
    copy.pack.sessionId !== copy.sessionId ||
    copy.receivedRevision > copy.pack.revision ||
    !["pending", "received", "uncertain"].includes(copy.syncState)
  )
    throw new Error("Invalid delegation snapshot");
  if (
    previous &&
    (previous.pack.delegationId !== copy.pack.delegationId ||
      previous.pack.goal !== copy.pack.goal ||
      previous.pack.revision > copy.pack.revision ||
      previous.pack.throughEntryIndex > copy.pack.throughEntryIndex ||
      previous.receivedRevision > copy.receivedRevision ||
      (previous.taskId && previous.taskId !== copy.taskId))
  )
    throw new Error("Conflicting or stale delegation snapshot");
  return copy;
}
export class InMemoryDelegationStore implements DelegationStore {
  private readonly rows = new Map<string, DelegationRecord>();
  get(key: string) {
    const row = this.rows.get(key);
    return row ? structuredClone(row) : undefined;
  }
  list(sessionId: string) {
    return [...this.rows.values()]
      .filter((r) => r.sessionId === sessionId)
      .map((r) => structuredClone(r));
  }
  put(row: DelegationRecord) {
    this.rows.set(row.sourceKey, validated(row, this.rows.get(row.sourceKey)));
  }
}
export class SqliteDelegationStore implements DelegationStore {
  constructor(private readonly connection: SqliteDatabaseConnection) {}
  get(key: string): DelegationRecord | undefined {
    this.connection.assertOpen("Delegation store is closed");
    const row = this.connection.database
      .prepare(
        "SELECT payload_json FROM delegation_contexts WHERE source_key=?",
      )
      .get(key) as { payload_json: string } | undefined;
    return row
      ? validated(JSON.parse(row.payload_json) as DelegationRecord)
      : undefined;
  }
  list(sessionId: string): DelegationRecord[] {
    this.connection.assertOpen("Delegation store is closed");
    const rows = this.connection.database
      .prepare(
        "SELECT payload_json FROM delegation_contexts WHERE session_id=? ORDER BY source_key",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    return rows.map((r) =>
      validated(JSON.parse(r.payload_json) as DelegationRecord),
    );
  }
  put(row: DelegationRecord) {
    this.connection.assertOpen("Delegation store is closed");
    const db = this.connection.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const next = validated(row, this.get(row.sourceKey));
      db.prepare(
        "INSERT INTO delegation_contexts(source_key,session_id,payload_json) VALUES (?,?,?) ON CONFLICT(source_key) DO UPDATE SET payload_json=excluded.payload_json",
      ).run(next.sourceKey, next.sessionId, JSON.stringify(next));
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}
