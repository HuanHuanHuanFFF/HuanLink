import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientFactory } from "@a2a-js/sdk/client";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { expect, test } from "vitest";
import { startConfiguredCodexAdapterRuntime } from "../src/runtime.js";
import { spawnCodexAppServerTransport } from "../src/codex-app-server-client.js";

test("loads the JSON entry and runs default and overridden dispatches through a controlled Codex process", async () => {
  const root = await mkdtemp(join(tmpdir(), "huanlink-dispatch-"));
  const configRoot = join(root, ".huanlink", "config");
  const projectRoot = join(configRoot, "adapters", "codex", "projects");
  await mkdir(projectRoot, { recursive: true });
  const write = (path: string, data: unknown) =>
    writeFile(path, JSON.stringify(data));
  let runtime:
    | Awaited<ReturnType<typeof startConfiguredCodexAdapterRuntime>>
    | undefined;
  try {
    for (const name of ["alpha", "beta"]) {
      await mkdir(join(root, name));
      execFileSync("git", ["init", "--initial-branch=main", join(root, name)], {
        windowsHide: true,
        stdio: "ignore",
      });
      await write(join(projectRoot, `${name}.json`), {
        version: 1,
        projectId: name,
        workspace: name,
        branch: "main",
        defaultModelId: "fixture-model",
        defaultReasoningEffort: "high",
      });
    }
    await write(join(configRoot, "config.json"), {
      version: 1,
      adapters: {
        codex: {
          runtime: "./adapters/codex/runtime.json",
          projects: [
            "./adapters/codex/projects/alpha.json",
            "./adapters/codex/projects/beta.json",
          ],
        },
      },
    });
    await write(join(configRoot, "adapters", "codex", "runtime.json"), {
      version: 1,
      host: "127.0.0.1",
      port: 0,
      codexExecutable: "controlled",
      expectedCodexVersion: "0.145.0",
      heartbeatIntervalMs: 1000,
    });
    runtime = await startConfiguredCodexAdapterRuntime({
      projectRoot: root,
      spawnTransport: (options) =>
        spawnCodexAppServerTransport({
          ...options,
          executable: process.execPath,
          args: [
            fileURLToPath(
              new URL("./fixtures/dispatch-app-server.mjs", import.meta.url),
            ),
          ],
        }),
    });
    const client = await new ClientFactory().createFromUrl(runtime.origin);
    const run = (projectId: string, overrides = {}) =>
      client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: `${projectId}-${JSON.stringify(overrides)}`,
            contextId: "one-session",
            role: "ROLE_USER",
            parts: [
              { text: "Report effective configuration" },
              {
                data: {
                  type: "huanlink.codex-task.v1",
                  projectId,
                  ...overrides,
                },
              },
            ],
          },
          configuration: { returnImmediately: false },
        }),
      );
    const results = await Promise.all([
      run("alpha"),
      run("beta", { modelId: "override-model", reasoningEffort: "low" }),
    ]);
    const payloads = results.map((result) => {
      if (!("status" in result)) throw new Error("Expected Task");
      expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      const part = result.artifacts[0]?.parts[0]?.content;
      if (part?.$case !== "text") throw new Error("Expected artifact");
      return JSON.parse(part.value.split("Summary:\n")[1]!.split("\n\n")[0]!);
    });
    expect(payloads[0]).toMatchObject({
      cwd: await realpath(join(root, "alpha")),
      model: "fixture-model",
      effort: "high",
    });
    expect(payloads[1]).toMatchObject({
      cwd: await realpath(join(root, "beta")),
      model: "override-model",
      effort: "low",
    });
    expect(payloads[0].threadId).not.toBe(payloads[1].threadId);
    await expect(run("missing")).rejects.toThrow();
    await expect(run("alpha", { reasoningEffort: "max" })).rejects.toThrow();
    const next = await run("beta");
    if (!("status" in next)) throw new Error("Expected Task");
    expect(next.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const output = next.artifacts[0]?.parts[0]?.content;
    expect(
      output?.$case === "text" &&
        JSON.parse(output.value.split("Summary:\n")[1]!.split("\n\n")[0]!),
    ).toMatchObject({
      model: "fixture-model",
      effort: "high",
      threadId: payloads[1].threadId,
    });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
