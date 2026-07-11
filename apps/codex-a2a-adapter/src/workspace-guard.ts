import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ValidatedDemoWorkspace {
  branch: string;
  workspace: string;
}

export async function validateDemoWorkspace(
  workspace: string,
  expectedBranch: string
): Promise<ValidatedDemoWorkspace> {
  const canonicalWorkspace = await realpath(workspace);
  const gitRoot = await runGit(canonicalWorkspace, [
    "rev-parse",
    "--show-toplevel"
  ]);
  const canonicalGitRoot = await realpath(gitRoot);

  if (pathKey(canonicalGitRoot) !== pathKey(canonicalWorkspace)) {
    throw new Error(
      `Configured workspace must be the Git root: ${canonicalWorkspace}; found ${canonicalGitRoot}`
    );
  }

  const branch = await runGit(canonicalWorkspace, ["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(`Expected branch ${expectedBranch}, found ${branch || "detached HEAD"}`);
  }

  return { branch, workspace: canonicalWorkspace };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.stdout.trim();
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
