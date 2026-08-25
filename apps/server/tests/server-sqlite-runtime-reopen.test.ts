import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AsyncToolTaskService,
  SessionTaskQuotaService,
  type ChannelAdapter,
  type ChannelDescriptor,
  type ChannelMessageListener,
  type ConversationSessionStore,
  type DeliveryReceipt,
  type InboundChannelMessage,
  type RetractChannelMessageCommand,
  type SendChannelMessageCommand,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assembleHuanLinkServerRuntime,
  createChannelRuntime,
} from "../src/index.js";
import { createServerSqlitePersistence } from "../src/server-sqlite-persistence.js";

const temporaryDirectories: string[] = [];
const openRuntimes: Array<{ close(): Promise<void> }> = [];
const openStoreOwners: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0).toReversed()) {
    await runtime.close();
  }
  for (const owner of openStoreOwners.splice(0).toReversed()) {
    await owner.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ReopenChannelAdapter implements ChannelAdapter {
  readonly descriptor: ChannelDescriptor = {
    channelId: "qq-main",
    platform: "test",
    capabilities: {
      conversationKinds: ["group"],
      threads: false,
      inboundContentFormats: ["onebot11.cq"],
      outboundPartTypes: ["text"],
      reply: true,
      edit: false,
      retract: true,
      reaction: false,
      typing: false,
      streaming: false,
    },
  };
  private readonly listeners = new Set<ChannelMessageListener>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  onMessage(listener: ChannelMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(_command: SendChannelMessageCommand): Promise<DeliveryReceipt> {
    return Promise.resolve({ channelId: "qq-main", messageId: "reply-1" });
  }

  retract(_command: RetractChannelMessageCommand): Promise<void> {
    return Promise.resolve();
  }

  emit(message: InboundChannelMessage): void {
    for (const listener of this.listeners) {
      void listener(message);
    }
  }
}

function message(
  messageId: string,
  input: { readonly self?: boolean; readonly content?: string } = {},
): InboundChannelMessage {
  return {
    messageId,
    route: {
      channelId: "qq-main",
      conversationKind: "group",
      conversationId: "10001",
    },
    sender: input.self
      ? { id: "30003", username: "HuanLink", isSelf: true }
      : { id: "20002", username: "Alice", isSelf: false },
    receivedAt: "2026-08-21T01:00:00.000Z",
    content: input.content ?? "@HuanLink persist this",
    contentFormat: "onebot11.cq",
    ...(input.self ? {} : { trigger: { kind: "mention" as const } }),
  };
}

function taskService(
  store: ConstructorParameters<typeof AsyncToolTaskService>[0]["store"],
): AsyncToolTaskService {
  return new AsyncToolTaskService({
    store,
    quotaService: new SessionTaskQuotaService({
      limits: { a2a: 2, "async-tool": 3 },
    }),
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
}

async function assembleSqliteRuntime(input: {
  readonly projectRoot: string;
  readonly runMainAgent: (facts: {
    readonly sessionId: string;
    readonly runId: string;
    readonly sessions: ConversationSessionStore;
    readonly history: SessionToolHistoryRecorder;
  }) => Promise<void> | void;
}) {
  const persistence = await createServerSqlitePersistence({
    projectRoot: input.projectRoot,
  });
  const tasks = taskService(persistence.taskStore);
  const adapter = new ReopenChannelAdapter();
  const runtime = await assembleHuanLinkServerRuntime({
    taskService: tasks,
    createStore: () => ({
      sessionStore: persistence.sessionStore,
      storeOwner: persistence.storeOwner,
    }),
    createPhase3: ({ sessionStore, historyRecorder }) => ({
      runMainAgent: async ({ sessionId, runId }) => {
        await input.runMainAgent({
          sessionId,
          runId,
          sessions: sessionStore,
          history: historyRecorder,
        });
        return { output: "done" };
      },
      close: () => undefined,
    }),
    createChannels: ({ onChannelMessage }) =>
      createChannelRuntime({
        channels: [
          {
            adapter,
            inboundPolicy: {
              groups: { mode: "denylist", ids: [] },
              directs: { mode: "denylist", ids: [] },
            },
          },
        ],
        onMessage: onChannelMessage,
      }),
  });
  openRuntimes.push(runtime);
  return {
    adapter,
    runtime,
    sessions: persistence.sessionStore,
    tasks,
  };
}

describe("Server SQLite Runtime reopen", () => {
  test("keeps facts and deduplication without resuming old execution", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "huanlink-runtime-reopen-"));
    temporaryDirectories.push(projectRoot);
    const firstTurn = vi.fn(
      ({
        sessionId,
        runId,
        sessions,
        history,
      }: {
        sessionId: string;
        runId: string;
        sessions: ConversationSessionStore;
        history: SessionToolHistoryRecorder;
      }) => {
        history.recordToolCall(sessionId, {
          runId,
          toolCallId: "call-reply",
          toolName: "reply",
          arguments: { parts: [{ type: "text", text: "done" }] },
        });
        sessions.recordOutboundDelivery(sessionId, {
          route: message("unused").route,
          contentFormat: "onebot11.cq",
          receipt: { channelId: "qq-main", messageId: "reply-1" },
          sentAt: "2026-08-21T01:00:01.000Z",
          runId,
          toolCallId: "call-reply",
          sourceSessionId: sessionId,
        });
        history.recordToolResult(sessionId, {
          runId,
          toolCallId: "call-reply",
          toolName: "reply",
          output: { status: "success", messageId: "reply-1" },
        });
      },
    );
    const first = await assembleSqliteRuntime({
      projectRoot,
      runMainAgent: firstTurn,
    });
    await first.runtime.start();
    first.adapter.emit(message("message-1"));
    await vi.waitFor(() => expect(firstTurn).toHaveBeenCalledOnce());
    const reservation = first.tasks.reserve({
      sessionId: "channel:qq-main:group:10001",
      sourceRunId: "run-async",
      sourceToolCallId: "call-async",
      kind: "agent-call",
      toolName: "submit_codex_agent_call",
      payload: { artifacts: [] },
    });
    expect(reservation.status).toBe("reserved");
    const taskId =
      reservation.status === "reserved" ? reservation.task.taskId : "";
    await first.runtime.close();

    const secondTurn = vi.fn();
    const second = await assembleSqliteRuntime({
      projectRoot,
      runMainAgent: secondTurn,
    });
    expect(
      second.tasks.getStatus("channel:qq-main:group:10001", taskId),
    ).toMatchObject({
      status: "found",
      taskId,
      state: "unknown",
      statusMessage: "reconciliation-required",
    });
    await second.runtime.start();
    second.adapter.emit(message("message-1"));
    second.adapter.emit(message("reply-1", { self: true, content: "done" }));
    await vi.waitFor(() =>
      expect(
        second.sessions.getSession("channel:qq-main:group:10001")?.timeline,
      ).toHaveLength(4),
    );
    expect(secondTurn).not.toHaveBeenCalled();
    await second.runtime.close();

    const reopened = await createServerSqlitePersistence({ projectRoot });
    openStoreOwners.push(reopened.storeOwner);
    const timeline = reopened.sessionStore.getSession(
      "channel:qq-main:group:10001",
    )?.timeline;
    expect(timeline).toHaveLength(4);
    expect(timeline?.[1]).toMatchObject({
      type: "agent_tool_call",
      toolCallId: "call-reply",
    });
    expect(timeline?.[2]).toMatchObject({
      type: "agent_tool_result",
      toolCallId: "call-reply",
    });
    expect(timeline?.[3]).toMatchObject({
      type: "channel_message",
      messageId: "reply-1",
      outbound: { toolCallId: "call-reply" },
    });
    await reopened.storeOwner.close();
  });
});
