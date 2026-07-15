import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { validateDemoWorkspace } from "../src/workspace-guard.js";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

async function createRepository(branch: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "huanlink-workspace-guard-"));
  tempDirectories.push(directory);
  await execFileAsync("git", ["init", "-b", branch, directory]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("validateDemoWorkspace", () => {
  it("returns the canonical Git root on the expected branch", async () => {
    const repository = await createRepository("spike/demo-v0");

    await expect(
      validateDemoWorkspace(repository, "spike/demo-v0")
    ).resolves.toEqual({
      branch: "spike/demo-v0",
      workspace: await realpath(repository)
    });
  });

  it("rejects a workspace on any other branch", async () => {
    const repository = await createRepository("main");

    await expect(
      validateDemoWorkspace(repository, "spike/demo-v0")
    ).rejects.toThrow("Expected branch spike/demo-v0, found main");
  });
});
