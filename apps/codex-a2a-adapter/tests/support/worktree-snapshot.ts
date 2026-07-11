import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeSnapshot {
  branch: string;
  files: Record<string, string>;
  head: string;
  stagedDiff: string;
  status: string;
  unstagedDiff: string;
}

export async function captureWorktreeSnapshot(
  workspace: string,
  excludedPaths: readonly string[]
): Promise<WorktreeSnapshot> {
  const pathspec = [
    ".",
    ...excludedPaths.map((path) => `:(exclude)${normalizePath(path)}`)
  ];
  const [branch, head, listedFiles, stagedDiff, status, unstagedDiff] =
    await Promise.all([
      git(workspace, ["branch", "--show-current"]),
      git(workspace, ["rev-parse", "HEAD"]),
      git(workspace, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...pathspec
      ]),
      git(workspace, [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--",
        ...pathspec
      ]),
      git(workspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ...pathspec
      ]),
      git(workspace, [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--",
        ...pathspec
      ])
    ]);
  const paths = listedFiles
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
  const files = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await fingerprint(join(workspace, path))
      ] as const)
    )
  );

  return {
    branch: branch.trimEnd(),
    files,
    head: head.trimEnd(),
    stagedDiff,
    status,
    unstagedDiff
  };
}

async function git(workspace: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function fingerprint(path: string): Promise<string> {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) {
      return `file:${digest(await readFile(path))}`;
    }
    if (stats.isSymbolicLink()) {
      return `symlink:${digest(await readlink(path))}`;
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    return `other:${stats.mode}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
