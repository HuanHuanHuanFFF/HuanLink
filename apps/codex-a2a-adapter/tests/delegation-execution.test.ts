import { expect, test } from "vitest";
import { CodexDelegationExecution } from "../src/delegation-execution.js";

test("orphaned and closed permission requests receive a native denial rather than a local discard", async () => {
  const decisions: unknown[] = [];
  const discarded: unknown[] = [];
  const session = new CodexDelegationExecution({
    pack,
    workspace: "/workspace",
    permissionKinds: ["command"],
    ttlMs: 60000,
    getTurn: () => ({ threadId: "t", turnId: "r" }),
    validate: async () => {},
    steer: async () => {},
    decide: async (id, decision) => {
      decisions.push({ id, decision });
    },
    discard: (id) => {
      discarded.push(id);
    },
    paused: () => {},
    resumed: () => {},
    stop: async () => {},
    failed: () => {},
  });
  await session.request({
    id: "orphan",
    kind: "command",
    threadId: "wrong",
    turnId: "r",
    itemId: "i",
    command: "npm test",
    cwd: "/workspace",
    reason: "test",
  });
  await session.request({
    id: "pending",
    kind: "command",
    threadId: "t",
    turnId: "r",
    itemId: "i",
    command: "npm test",
    cwd: "/workspace",
    reason: "test",
  });
  session.close();
  await Promise.resolve();
  expect(decisions).toEqual([
    { id: "orphan", decision: "deny" },
    { id: "pending", decision: "deny" },
  ]);
  expect(discarded).toEqual([]);
});

test.each(["expiry", "canceled", "stale revision", "conflicting decision"])(
  "permission cannot resume after %s",
  async (scenario) => {
    const decisions: unknown[] = [];
    const session = new CodexDelegationExecution({
      pack,
      workspace: "/workspace",
      permissionKinds: ["command"],
      ttlMs: 20,
      getTurn: () => ({ threadId: "thread", turnId: "turn" }),
      validate: async () => {},
      steer: async () => {},
      decide: async (id, decision) => {
        decisions.push({ id, decision });
      },
      discard: () => {},
      paused: () => {},
      resumed: () => {},
      stop: async () => {},
      failed: (error) => {
        throw error;
      },
    });
    await session.request({
      id: "p",
      kind: "command",
      threadId: "thread",
      turnId: "turn",
      itemId: "i",
      command: "npm test",
      cwd: "/workspace",
      reason: "test",
    });
    const id = session.permission!.approvalId;
    const decision = {
      type: "huanlink.delegation-decision.v1" as const,
      delegationId: "d",
      approvalId: id,
      contextRevision: 1,
      decision: "approve" as const,
    };
    if (scenario === "expiry") {
      await new Promise((r) => setTimeout(r, 35));
    }
    if (scenario === "canceled") session.close();
    if (scenario === "stale revision") decision.contextRevision = 0;
    if (scenario === "conflicting decision")
      await session.control({ ...decision, decision: "deny" });
    await expect(session.control(decision)).rejects.toThrow();
    expect(
      decisions.every(
        (d) => (d as { decision: string }).decision !== "approve",
      ),
    ).toBe(true);
    session.close();
  },
);
test("context synchronization refuses changed bytes at the same revision and a wider approval ceiling", async () => {
  const session = new CodexDelegationExecution({
    pack,
    workspace: "/workspace",
    permissionKinds: ["command"],
    ttlMs: 60000,
    getTurn: () => ({ threadId: "t", turnId: "r" }),
    validate: async () => {},
    steer: async () => {},
    decide: async () => {},
    discard: () => {},
    paused: () => {},
    resumed: () => {},
    stop: async () => {},
    failed: () => {},
  });
  await expect(
    session.control({
      type: "huanlink.delegation-sync.v1",
      pack: { ...pack, summary: "changed" },
    }),
  ).rejects.toThrow(/revision/);
  await expect(
    session.control({
      type: "huanlink.delegation-sync.v1",
      pack: {
        ...pack,
        revision: 2,
        authorityCeiling: ["command", "file-change"],
      },
    }),
  ).rejects.toThrow(/ceiling/);
  session.close();
});
test("unidentified file changes and session-wide root grants are declined", async () => {
  const decisions: unknown[] = [];
  const session = new CodexDelegationExecution({
    pack: { ...pack, authorityCeiling: ["file-change"] },
    workspace: "/workspace",
    permissionKinds: ["file-change"],
    ttlMs: 60000,
    getTurn: () => ({ threadId: "t", turnId: "r" }),
    validate: async () => {},
    steer: async () => {},
    decide: async (id, decision) => {
      decisions.push({ id, decision });
    },
    discard: () => {},
    paused: () => {},
    resumed: () => {},
    stop: async () => {},
    failed: () => {},
  });
  await session.request({
    id: "missing-patch",
    kind: "file-change",
    threadId: "t",
    turnId: "r",
    itemId: "missing",
    reason: "write",
  });
  session.recordItem({
    id: "patch",
    type: "fileChange",
    changes: [{ path: "a.txt", diff: "+hello" }],
  });
  await session.request({
    id: "root-grant",
    kind: "file-change",
    threadId: "t",
    turnId: "r",
    itemId: "patch",
    grantRoot: "/workspace",
    reason: "write",
  });
  expect(decisions).toEqual([
    { id: "missing-patch", decision: "deny" },
    { id: "root-grant", decision: "deny" },
  ]);
  session.close();
});

import type {
  DelegationContextPack,
  DelegationPermissionRequest,
} from "@huanlink/core";

export const pack: DelegationContextPack = {
  type: "huanlink.delegation-context.v1",
  delegationId: "d",
  sessionId: "s",
  goal: "修复测试",
  revision: 1,
  throughEntryIndex: 1024,
  summary: "修复测试",
  progress: [],
  decisions: [],
  constraints: ["不要推送"],
  openQuestions: [],
  userEvidence: [
    {
      messageId: "u",
      senderId: "owner",
      text: "修复测试，可以运行 npm test，不要推送",
      entryIndex: 1024,
    },
  ],
  authorization: {
    allowed: [{ scope: "npm test", evidenceMessageIds: ["u"] }],
    denied: [{ scope: "push", evidenceMessageIds: ["u"] }],
    uncertain: [],
  },
  change: "context",
  stop: false,
  authorityCeiling: ["command"],
};
test("remote context updates are idempotent and approval resumes only the original native operation", async () => {
  const steers: string[] = [];
  const decisions: unknown[] = [];
  let pending: DelegationPermissionRequest | undefined;
  const session = new CodexDelegationExecution({
    pack,
    workspace: "/workspace",
    permissionKinds: ["command"],
    ttlMs: 60000,
    getTurn: () => ({ threadId: "thread", turnId: "turn" }),
    validate: async () => {},
    steer: async (prompt) => {
      steers.push(prompt);
    },
    decide: async (id, decision) => {
      decisions.push({ id, decision });
    },
    paused: (request) => {
      pending = request;
    },
    resumed: () => {},
    stop: async () => {},
    failed: () => {},
    discard: () => {},
  });
  const next = {
    ...pack,
    revision: 2,
    throughEntryIndex: 2048,
    summary: "先运行测试再修复",
  };
  await session.control({ type: "huanlink.delegation-sync.v1", pack: next });
  await session.control({ type: "huanlink.delegation-sync.v1", pack: next });
  expect(steers).toHaveLength(1);
  await session.request({
    id: "native-request",
    kind: "command",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    command: "npm test",
    cwd: "/workspace",
    reason: "需要运行测试",
  });
  expect(pending?.operation).toBe("npm test");
  await expect(
    session.control({
      type: "huanlink.delegation-decision.v1",
      delegationId: "other-task",
      approvalId: pending!.approvalId,
      contextRevision: 2,
      decision: "approve",
    }),
  ).rejects.toThrow(/binding/);
  const decision = {
    type: "huanlink.delegation-decision.v1" as const,
    delegationId: "d",
    approvalId: pending!.approvalId,
    contextRevision: 2,
    decision: "approve" as const,
  };
  await session.control(decision);
  await session.control(decision);
  expect(decisions).toEqual([{ id: "native-request", decision: "approve" }]);
  session.close();
});
