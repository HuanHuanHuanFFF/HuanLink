import { expect, test } from "vitest";
import {
  AgentCallService,
  AsyncToolTaskService,
  AGENT_CALL_TASK_KIND_DEFINITION,
  DelegationCoordinator,
  InMemoryConversationSessionStore,
  InMemoryDelegationStore,
  type AgentCallTransport,
  type AgentCallTaskSnapshot,
  type DelegationContextPack,
} from "../src/index.js";

test("a bare yes cannot confirm two pending tasks and an explicit answer confirms only its target", async () => {
  const sessions = new InMemoryConversationSessionStore();
  const append = (
    id: string,
    text: string,
    self = false,
    replyToMessageId?: string,
  ) =>
    sessions.appendChannelMessage("s", {
      messageId: id,
      route: {
        channelId: "qq",
        conversationKind: "direct",
        conversationId: "owner",
      },
      sender: { id: self ? "bot" : "owner", username: "user", isSelf: self },
      receivedAt: new Date().toISOString(),
      content: text,
      contentFormat: "text",
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
  append("u1", "准备两个任务，需要权限时分别确认。");
  const store = new InMemoryDelegationStore();
  const tasks = new AsyncToolTaskService({
    maxActiveTasksPerSession: 3,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const snapshots = new Map<string, AgentCallTaskSnapshot>(),
    packs = new Map<string, DelegationContextPack>();
  const approvals: string[] = [];
  let evidence = "u1",
    shouldApprove = false;
  const transport: AgentCallTransport = {
    discoverCapability: async () => ({ id: "code", name: "code" }),
    submitTask: async (request) => {
      const pack = request.inputData!.delegation as DelegationContextPack,
        taskId = "remote-" + pack.delegationId;
      packs.set(taskId, pack);
      const snapshot: AgentCallTaskSnapshot = {
        taskId,
        contextId: pack.delegationId,
        state: "input-required",
        artifacts: [],
        permissionRequest: {
          approvalId: "approval-" + pack.goal,
          delegationId: pack.delegationId,
          requestedAtRevision: pack.revision,
          kind: "command",
          operation: "npm test",
          targets: ["/workspace"],
          reason: "tests",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
      snapshots.set(taskId, snapshot);
      return { outcome: "accepted", snapshot };
    },
    continueTask: async () => {
      throw new Error("wrong continuation");
    },
    async *watchTask(taskId) {
      yield snapshots.get(taskId)!;
    },
    cancelTask: async (taskId) => ({
      ...snapshots.get(taskId)!,
      state: "canceled",
    }),
    controlTask: async (r) => {
      if (r.control.type === "huanlink.delegation-sync.v1") {
        packs.set(r.taskId, r.control.pack);
        return {
          receipt: {
            delegationId: r.control.pack.delegationId,
            revision: r.control.pack.revision,
            status: "received",
          },
          snapshot: snapshots.get(r.taskId)!,
        };
      }
      approvals.push(r.control.approvalId);
      const snapshot = {
        ...snapshots.get(r.taskId)!,
        state: "completed" as const,
        permissionRequest: undefined,
      };
      snapshots.set(r.taskId, snapshot);
      return {
        receipt: {
          delegationId: r.control.delegationId,
          revision: r.control.contextRevision,
          status: "decided",
          approvalId: r.control.approvalId,
        },
        snapshot,
      };
    },
  };
  const calls = new AgentCallService({ transport, taskService: tasks });
  const coordinator = new DelegationCoordinator({
    sessions,
    tasks,
    agentCalls: calls,
    store,
    authorizedSenderIds: ["owner"],
    model: {
      compact: async ({ goal, previous }) => ({
        summary: goal,
        progress: [],
        decisions: [],
        constraints: [],
        openQuestions: [],
        retainedMessageIds: evidence === "u1" ? ["u1"] : ["u1", evidence],
        authorization: {
          allowed: [{ scope: "run tests", evidenceMessageIds: [evidence] }],
          denied: [],
          uncertain: [],
        },
        change: previous ? "authority" : "context",
        stop: false,
      }),
      review: async () => ({
        decision: shouldApprove ? "approve" : "ask-user",
        evidenceMessageIds: [evidence],
        reason: "apparently unique question",
      }),
    },
  });
  try {
    for (const goal of ["A", "B"]) {
      const result = await coordinator.invoke({
        sessionId: "s",
        runId: goal,
        sourceToolCallId: "call",
        toolName: "submit",
        skillId: "code",
        executionMode: "async",
        input: goal,
        inputData: {},
      });
      if (result.status !== "accepted") throw new Error("not accepted");
      expect(
        await coordinator.resolvePermission(tasks.get("s", result.taskId)!),
      ).toBe(false);
      append("q" + goal, "请确认 approval-" + goal + " 的 npm test", true);
    }
    append("u2", "可以");
    evidence = "u2";
    shouldApprove = true;
    await coordinator.synchronizeSession("s");
    expect(approvals).toEqual([]);
    append("u3", "批准 approval-B", false, "qA");
    evidence = "u3";
    await coordinator.synchronizeSession("s");
    expect(approvals).toEqual([]);
    append("u4", "批准 approval-A 的这次操作，另一个继续等待");
    evidence = "u4";
    await coordinator.synchronizeSession("s");
    expect(approvals).toEqual(["approval-A"]);
  } finally {
    await calls.close();
  }
});
