import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createServerSqlitePersistence } from "../src/server-sqlite-persistence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Server SQLite persistence", () => {
  test("creates the fixed database and reopens Conversation and Task facts through one owner", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "huanlink-server-sqlite-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = join(
      projectRoot,
      ".huanlink",
      "data",
      "huanlink.sqlite",
    );
    const first = await createServerSqlitePersistence({ projectRoot });

    first.sessionStore.appendChannelMessage("session-1", {
      messageId: "message-1",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "10001",
      },
      sender: { id: "20002", username: "Alice", isSelf: false },
      receivedAt: "2026-08-21T00:00:00.000Z",
      content: "persist me",
      contentFormat: "onebot11.cq",
      trigger: { kind: "mention" },
    });
    first.taskStore.insert({
      taskId: "task-1",
      sessionId: "session-1",
      sourceRunId: "run-1",
      sourceToolCallId: "call-1",
      kind: "agent-call",
      quotaPool: "a2a",
      toolName: "submit_codex_agent_call",
      state: "completed",
      payload: { artifacts: [{ kind: "text", text: "done" }] },
      createdAt: "2026-08-21T00:00:01.000Z",
      updatedAt: "2026-08-21T00:00:02.000Z",
    });

    expect(existsSync(databasePath)).toBe(true);
    await first.storeOwner.close();
    expect(() => first.sessionStore.getSession("session-1")).toThrow(/closed/i);
    expect(() => first.taskStore.get("session-1", "task-1")).toThrow(/closed/i);

    const reopened = await createServerSqlitePersistence({ projectRoot });
    expect(
      reopened.sessionStore.getSession("session-1")?.timeline,
    ).toHaveLength(1);
    expect(reopened.taskStore.get("session-1", "task-1")).toMatchObject({
      taskId: "task-1",
      state: "completed",
    });
    await reopened.storeOwner.close();
  });

  test("does not open a database when the data directory cannot be created", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "huanlink-server-sqlite-"));
    temporaryDirectories.push(projectRoot);
    writeFileSync(join(projectRoot, ".huanlink"), "not a directory");

    await expect(
      createServerSqlitePersistence({ projectRoot }),
    ).rejects.toBeDefined();
    expect(
      existsSync(join(projectRoot, ".huanlink", "data", "huanlink.sqlite")),
    ).toBe(false);
  });
});
