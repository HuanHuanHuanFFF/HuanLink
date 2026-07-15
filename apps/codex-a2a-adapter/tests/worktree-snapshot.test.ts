import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { captureWorktreeSnapshot } from "./support/worktree-snapshot.js";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("captureWorktreeSnapshot", () => {
  it("detects an existing untracked file change while excluding target files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "huanlink-snapshot-"));
    temporaryRepositories.push(workspace);
    await git(workspace, "init", "-b", "spike/demo-v0");
    await git(workspace, "config", "user.email", "phase2@example.invalid");
    await git(workspace, "config", "user.name", "Phase 2 Test");
    await writeFile(join(workspace, "tracked.txt"), "tracked\n");
    await writeFile(join(workspace, "target.txt"), "target before\n");
    await git(workspace, "add", "tracked.txt", "target.txt");
    await git(workspace, "commit", "-m", "test baseline");
    await writeFile(join(workspace, "untracked.txt"), "untracked before\n");

    const before = await captureWorktreeSnapshot(workspace, ["target.txt"]);
    await writeFile(join(workspace, "target.txt"), "target after\n");
    await writeFile(join(workspace, "untracked.txt"), "untracked after\n");
    const after = await captureWorktreeSnapshot(workspace, ["target.txt"]);

    expect(after.head).toBe(before.head);
    expect(after.branch).toBe("spike/demo-v0");
    expect(before.files["target.txt"]).toBeUndefined();
    expect(after.files["untracked.txt"]).not.toBe(
      before.files["untracked.txt"]
    );
    expect(after.status).toBe(before.status);
  });
});
