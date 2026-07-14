import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCodexAdapterRuntimeLogger,
  resolveCodexAdapterLogPath
} from "../src/adapter-runtime-logger.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Codex adapter runtime logger", () => {
  it("writes JSONL under the shared repository log directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "huanlink-adapter-log-"));
    tempDirectories.push(directory);
    const moduleUrl = pathToFileURL(
      join(directory, "apps", "codex-a2a-adapter", "dist", "main.js")
    ).href;
    const expectedPath = join(
      directory,
      ".huanlink",
      "logs",
      "codex-a2a-adapter.jsonl"
    );
    const logger = createCodexAdapterRuntimeLogger({
      level: "debug",
      moduleUrl
    });

    logger.info("adapter.test", { a2aTaskId: "task-1" });
    await logger.close();

    expect(resolveCodexAdapterLogPath(moduleUrl)).toBe(expectedPath);
    const entry = JSON.parse((await readFile(expectedPath, "utf8")).trim());
    expect(entry).toMatchObject({
      level: 30,
      msg: "adapter.test",
      service: "codex-a2a-adapter",
      a2aTaskId: "task-1"
    });
  });
});
