import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { openSqliteHuanLinkStore } from "../src/index.js";

test("delegation snapshots and receipts survive SQLite reopen without changing source facts", async () => {
  const path = databasePath();
  const first = openSqliteHuanLinkStore(path);
  const record = {
    sourceKey: '["s","r","c"]',
    sessionId: "s",
    runId: "r",
    sourceToolCallId: "c",
    taskId: "task",
    receivedRevision: 2,
    syncState: "received" as const,
    pendingApprovalId: "approval",
    askedAtRevision: 2,
    askedThroughEntryIndex: 2048,
    pack: {
      type: "huanlink.delegation-context.v1" as const,
      delegationId: "d",
      sessionId: "s",
      goal: "inspect",
      revision: 2,
      throughEntryIndex: 2048,
      summary: "inspect only",
      progress: [],
      decisions: [],
      constraints: ["no push"],
      openQuestions: [],
      userEvidence: [
        {
          messageId: "u",
          senderId: "owner",
          text: "inspect only; no push",
          entryIndex: 1024,
        },
      ],
      authorization: {
        allowed: [{ scope: "inspect", evidenceMessageIds: ["u"] }],
        denied: [{ scope: "push", evidenceMessageIds: ["u"] }],
        uncertain: [],
      },
      change: "context" as const,
      stop: false,
      authorityCeiling: ["command" as const],
    },
  };
  first.delegationStore.put(record);
  first.close();
  expect(() => first.delegationStore.list("s")).toThrow(/closed/);
  const second = openSqliteHuanLinkStore(path);
  try {
    expect(second.delegationStore.get(record.sourceKey)).toEqual(record);
    expect(second.delegationStore.list("other-session")).toEqual([]);
    expect(() =>
      second.delegationStore.put({
        ...record,
        pack: { ...record.pack, summary: "different" },
      }),
    ).toThrow(/revision/);
  } finally {
    second.close();
  }
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "huanlink-shared-sqlite-"));
  directories.push(directory);
  return join(directory, "huanlink.sqlite");
}

describe("openSqliteHuanLinkStore", () => {
  test("shares durable conversation and Task facts, then closes both Store facades", () => {
    const path = databasePath();
    const first = openSqliteHuanLinkStore(path);
    first.sessionStore.appendChannelMessage("session-1", {
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      messageId: "message-1",
      sender: { id: "20002", username: "User", isSelf: false },
      content: "hello",
      contentFormat: "text/plain",
      receivedAt: "2026-08-21T00:00:00.000Z",
    });
    first.taskStore.insert({
      taskId: "task-1",
      kind: "agent-call",
      quotaPool: "a2a",
      sessionId: "session-1",
      sourceRunId: "run-1",
      sourceToolCallId: "call-1",
      toolName: "submit_codex_agent_call",
      state: "submitted",
      payload: { artifacts: [] },
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    });

    first.close();
    first.close();

    expect(() => first.sessionStore.getSession("session-1")).toThrow(/closed/i);
    expect(() => first.taskStore.get("session-1", "task-1")).toThrow(/closed/i);

    const reopened = openSqliteHuanLinkStore(path);
    expect(reopened.sessionStore.getSession("session-1")?.timeline).toEqual([
      {
        type: "channel_message",
        channelId: "qq-main",
        messageId: "message-1",
        observed: {
          route: {
            channelId: "qq-main",
            conversationKind: "group",
            conversationId: "10001",
          },
          messageId: "message-1",
          sender: { id: "20002", username: "User", isSelf: false },
          content: "hello",
          contentFormat: "text/plain",
          receivedAt: "2026-08-21T00:00:00.000Z",
        },
      },
    ]);
    expect(reopened.taskStore.get("session-1", "task-1")).toMatchObject({
      taskId: "task-1",
      state: "submitted",
    });
    reopened.close();
  });

  test("releases the database handle when migration validation fails", () => {
    const path = databasePath();
    const corrupted = new DatabaseSync(path);
    corrupted.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    corrupted
      .prepare(
        `INSERT INTO schema_migrations
           (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        1,
        "conversation-store-v1",
        "corrupted-checksum",
        "2026-08-21T00:00:00.000Z",
      );
    corrupted.close();

    expect(() => openSqliteHuanLinkStore(path)).toThrow(
      /does not match the embedded definition/i,
    );
    expect(() =>
      rmSync(dirname(path), { recursive: true, force: true }),
    ).not.toThrow();
  });
});
