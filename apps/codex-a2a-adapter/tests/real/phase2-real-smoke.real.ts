import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState,
  type SendMessageResult,
  type StreamResponse,
  type Task
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { describe, expect, it } from "vitest";

import { startCodexAdapterRuntime } from "../../src/runtime.js";
import { captureWorktreeSnapshot } from "../support/worktree-snapshot.js";

const execFileAsync = promisify(execFile);
const EXPECTED_BRANCH = "spike/demo-v0";
const TARGET_FILES = [
  "apps/codex-a2a-adapter/src/runtime-config.ts",
  "apps/codex-a2a-adapter/src/main.ts",
  "apps/codex-a2a-adapter/tests/runtime-config.test.ts"
] as const;
const TASK_PROMPT = [
  "Implement one focused Phase 2 safety improvement in this repository.",
  "Only modify apps/codex-a2a-adapter/src/runtime-config.ts, apps/codex-a2a-adapter/src/main.ts, and apps/codex-a2a-adapter/tests/runtime-config.test.ts.",
  "Add loopback host validation that accepts exactly 127.0.0.1, localhost, and ::1, and rejects blank or whitespace values, 0.0.0.0, and every other non-loopback host.",
  "Export the validator as parseHost(value: string): string.",
  "Wire the validated host into main.ts.",
  "Add focused tests, then run the Adapter package test suite and typecheck.",
  "Do not modify any other file. Do not switch branches, commit, merge, or push.",
  "In the final answer, report changed files and verification results."
].join(" ");

function requireTask(result: SendMessageResult): Task {
  if (!("status" in result)) {
    throw new Error("Expected the real A2A server to create a Task");
  }
  return result;
}

function stateFrom(event: StreamResponse): TaskState | undefined {
  if (event.payload?.$case === "task") {
    return event.payload.value.status?.state;
  }
  if (event.payload?.$case === "statusUpdate") {
    return event.payload.value.status?.state;
  }
  return undefined;
}

function artifactText(task: Task): string {
  return task.artifacts
    .flatMap((artifact) => artifact.parts)
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");
}

function messageText(task: Task): string {
  return (
    task.status?.message?.parts
      .flatMap((part) =>
        part.content?.$case === "text" ? [part.content.value] : []
      )
      .join("\n") ?? ""
  );
}

async function readTargets(workspace: string): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      TARGET_FILES.map(async (path) => [
        path,
        await readFile(`${workspace}/${path}`, "utf8")
      ] as const)
    )
  );
}

async function runAdapterCommand(
  workspace: string,
  script: "build" | "test" | "typecheck"
): Promise<void> {
  const pnpmArgs = [
    "pnpm",
    "--filter",
    "@huanlink/codex-a2a-adapter",
    script
  ];
  if (process.platform === "win32") {
    await execFileAsync(
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `corepack.cmd ${pnpmArgs.join(" ")}`],
      { cwd: workspace, maxBuffer: 16 * 1024 * 1024 }
    );
    return;
  }
  await execFileAsync("corepack", pnpmArgs, {
    cwd: workspace,
    maxBuffer: 16 * 1024 * 1024
  });
}

async function verifyLoopbackHostBehavior(workspace: string): Promise<void> {
  const moduleUrl = pathToFileURL(
    `${workspace}/apps/codex-a2a-adapter/dist/runtime-config.js`
  );
  moduleUrl.searchParams.set("phase2-real", randomUUID());
  const runtimeConfig = (await import(moduleUrl.href)) as {
    parseHost?: unknown;
  };
  expect(runtimeConfig.parseHost).toBeTypeOf("function");
  const parseHost = runtimeConfig.parseHost as (value: string) => string;
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    expect(parseHost(host)).toBe(host);
  }
  for (const host of [
    "",
    "   ",
    "0.0.0.0",
    "LOCALHOST",
    " localhost ",
    "[::1]",
    "192.168.1.10",
    "example.com"
  ]) {
    expect(() => parseHost(host)).toThrow();
  }

  const mainSource = await readFile(
    `${workspace}/apps/codex-a2a-adapter/src/main.ts`,
    "utf8"
  );
  expect(mainSource).toMatch(
    /const\s+host\s*=\s*parseHost\(\s*process\.env\.HUANLINK_CODEX_A2A_HOST\s*\?\?\s*["']127\.0\.0\.1["']\s*\)/s
  );
}

describe("Phase 2 real A2A to Codex app-server smoke", () => {
  it("uses a standard A2A Task to make and report a real code change", async () => {
    if (process.env.HUANLINK_REAL_CODEX_TEST !== "1") {
      throw new Error(
        "Set HUANLINK_REAL_CODEX_TEST=1 to authorize the real model-backed smoke"
      );
    }
    const codexExecutable = process.env.HUANLINK_CODEX_EXECUTABLE;
    if (!codexExecutable) {
      throw new Error("HUANLINK_CODEX_EXECUTABLE must point to Codex 0.144.1");
    }

    const workspace = await realpath(
      process.env.HUANLINK_CODEX_WORKSPACE ??
        fileURLToPath(new URL("../../../..", import.meta.url))
    );
    const beforeTargets = await readTargets(workspace);
    const beforeWorktree = await captureWorktreeSnapshot(
      workspace,
      TARGET_FILES
    );
    expect(beforeWorktree.branch).toBe(EXPECTED_BRANCH);
    const runtime = await startCodexAdapterRuntime({
      codexExecutable,
      codexModel: "gpt-5.4-mini",
      expectedBranch: EXPECTED_BRANCH,
      expectedCodexVersion: "0.144.1",
      host: "127.0.0.1",
      port: 0,
      workspace
    });

    try {
      const client = await new ClientFactory().createFromUrl(runtime.origin);
      const submitted = requireTask(
        await client.sendMessage(
          SendMessageRequest.fromJSON({
            message: {
              messageId: randomUUID(),
              role: "ROLE_USER",
              parts: [{ text: TASK_PROMPT }]
            },
            configuration: { returnImmediately: true }
          })
        )
      );
      expect(submitted.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);

      const states = [submitted.status?.state];
      const subscription = client.resubscribeTask(
        SubscribeToTaskRequest.fromJSON({ id: submitted.id })
      );
      for await (const event of subscription) {
        const state = stateFrom(event);
        if (state !== undefined) {
          states.push(state);
        }
      }

      const completed = await client.getTask(
        GetTaskRequest.fromJSON({ id: submitted.id })
      );
      const resultText = artifactText(completed);
      console.log(
        "PHASE2_REAL_TASK_DIAGNOSTIC",
        JSON.stringify({
          artifactCount: completed.artifacts.length,
          failure: messageText(completed),
          state: completed.status?.state,
          states,
          taskId: submitted.id
        })
      );
      expect(states).toContain(TaskState.TASK_STATE_WORKING);
      expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(completed.artifacts).toHaveLength(1);
      expect(resultText).toContain("diff --git");
      expect(resultText).not.toContain(
        "Codex completed without a final message."
      );
      expect(resultText).not.toContain("No unified diff was reported.");
      for (const path of TARGET_FILES) {
        expect(resultText).toContain(path);
      }

      const afterTargets = await readTargets(workspace);
      for (const path of TARGET_FILES) {
        expect(afterTargets.get(path)).not.toBe(beforeTargets.get(path));
      }
      await runAdapterCommand(workspace, "test");
      await runAdapterCommand(workspace, "typecheck");
      await runAdapterCommand(workspace, "build");
      await verifyLoopbackHostBehavior(workspace);
      const afterWorktree = await captureWorktreeSnapshot(
        workspace,
        TARGET_FILES
      );
      expect(afterWorktree).toEqual(beforeWorktree);

      console.log(
        "PHASE2_REAL_EVIDENCE",
        JSON.stringify({
          artifactContainsDiff: true,
          branch: afterWorktree.branch,
          changedFiles: TARGET_FILES,
          head: afterWorktree.head,
          independentlyVerified: ["test", "typecheck", "build", "host behavior"],
          states,
          taskId: submitted.id
        })
      );
    } finally {
      await runtime.close();
    }
  });
});
