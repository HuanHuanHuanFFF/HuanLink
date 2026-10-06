import { expect, test } from "vitest";
import {
  AgentCallService,
  AsyncToolTaskService,
  AGENT_CALL_TASK_KIND_DEFINITION,
  InMemoryConversationSessionStore,
  InMemoryDelegationStore,
  type AgentCallTransport,
  type DelegationContextPack,
} from "../src/index.js";
import { DelegationCoordinator } from "../src/delegation/coordinator.js";

test("reviews an exact pending permission against source evidence without asking the user again", async () => {
  const sessions = new InMemoryConversationSessionStore();
  sessions.appendChannelMessage("s", {
    messageId: "u",
    route: {
      channelId: "qq",
      conversationKind: "direct",
      conversationId: "owner",
    },
    sender: { id: "owner", username: "owner", isSelf: false },
    receivedAt: new Date().toISOString(),
    content: "Run npm test, but do not push",
    contentFormat: "text",
  });
  const tasks = new AsyncToolTaskService({
    maxActiveTasksPerSession: 2,
    taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
  });
  const decisions: unknown[] = [];
  let sentPack: DelegationContextPack | undefined;
  const transport: AgentCallTransport = {
    discoverCapability: async () => ({ id: "code", name: "code" }),
    submitTask: async (r) => {
      sentPack = r.inputData!.delegation as DelegationContextPack;
      return {
        outcome: "accepted",
        snapshot: {
          taskId: "remote",
          contextId: r.contextId,
          state: "input-required",
          artifacts: [],
          permissionRequest: {
            approvalId: "p",
            delegationId: sentPack.delegationId,
            requestedAtRevision: sentPack.revision,
            kind: "command",
            operation: "npm test",
            targets: ["/workspace"],
            reason: "tests",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      };
    },
    continueTask: async () => {
      throw new Error("Approval must not use question answers");
    },
    async *watchTask() {
      yield {
        taskId: "remote",
        contextId: sentPack!.delegationId,
        state: "completed" as const,
        artifacts: [],
      };
    },
    cancelTask: async () => ({
      taskId: "remote",
      state: "canceled",
      artifacts: [],
    }),
    controlTask: async (r) => {
      decisions.push(r.control);
      return {
        receipt: {
          delegationId: sentPack!.delegationId,
          revision: sentPack!.revision,
          status: "decided",
          approvalId: "p",
        },
        snapshot: {
          taskId: "remote",
          contextId: sentPack!.delegationId,
          state: "working",
          artifacts: [],
        },
      };
    },
  };
  const calls = new AgentCallService({ transport, taskService: tasks });
  const coordinator = new DelegationCoordinator({
    sessions,
    tasks,
    agentCalls: calls,
    store: new InMemoryDelegationStore(),
    authorizedSenderIds: ["owner"],
    model: {
      compact: async () => ({
        summary: "run tests",
        progress: [],
        decisions: [],
        constraints: ["no push"],
        openQuestions: [],
        retainedMessageIds: ["u"],
        authorization: {
          allowed: [{ scope: "run npm test", evidenceMessageIds: ["u"] }],
          denied: [{ scope: "push", evidenceMessageIds: ["u"] }],
          uncertain: [],
        },
        change: "context",
        stop: false,
      }),
      review: async () => ({
        decision: "approve",
        evidenceMessageIds: ["u"],
        reason: "Explicit test authorization",
      }),
    },
  });
  const result = await coordinator.invoke({
    sessionId: "s",
    runId: "r",
    sourceToolCallId: "c",
    toolName: "submit",
    skillId: "code",
    executionMode: "async",
    input: "Run tests",
    inputData: { type: "huanlink.codex-task.v1", projectId: "p" },
  });
  if (result.status !== "accepted") throw new Error("Expected acceptance");
  expect(
    await coordinator.resolvePermission(tasks.get("s", result.taskId)!),
  ).toBe(true);
  expect(decisions).toEqual([
    {
      type: "huanlink.delegation-decision.v1",
      delegationId: sentPack!.delegationId,
      approvalId: "p",
      contextRevision: sentPack!.revision,
      decision: "approve",
    },
  ]);
  await calls.close();
});
