import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createJsonlFileRuntimeLogger,
  type FlushableRuntimeLogger
} from "../src/index.js";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    [...tempDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirectories.clear();
});

describe("createJsonlFileRuntimeLogger", () => {
  test("creates parent directories and appends parseable JSON lines", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "nested", "runtime.jsonl");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(logPath, "existing-line\n", "utf8");

    const logger = createJsonlFileRuntimeLogger(logPath, {
      level: "debug",
      base: { service: "core-runtime" }
    });

    logger.info("first", { sequence: 1 });
    logger.debug("second", { sequence: 2 });
    await logger.flush();
    await logger.close();

    const [existing, ...jsonLines] = (await readFile(logPath, "utf8"))
      .trimEnd()
      .split("\n");

    expect(existing).toBe("existing-line");
    expect(jsonLines.map(parseLine)).toEqual([
      expect.objectContaining({
        level: 30,
        service: "core-runtime",
        sequence: 1,
        msg: "first"
      }),
      expect.objectContaining({
        level: 20,
        service: "core-runtime",
        sequence: 2,
        msg: "second"
      })
    ]);
  });

  test("creates a missing nested parent directory on first write", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "missing", "parents", "runtime.jsonl");
    const logger = createJsonlFileRuntimeLogger(logPath);

    logger.info("created", { ready: true });
    await logger.close();

    expect(parseLine((await readFile(logPath, "utf8")).trim())).toMatchObject({
      ready: true,
      msg: "created"
    });
  });

  test("redacts secret keys recursively in fields, arrays, base and child bindings", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const logger = createJsonlFileRuntimeLogger(logPath, {
      level: "debug",
      base: {
        service: "core-runtime",
        API_KEY: "base-api-key"
      }
    });
    const child = logger.child({
      Authorization: "Bearer child-secret",
      client_secret: "child-client-secret",
      module: "gateway"
    });

    child.debug("secret coverage", {
      payload: [
        {
          token: "nested-token",
          nested: {
            access_token: "nested-access-token",
            refresh_token: "nested-refresh-token"
          }
        },
        {
          Cookie: "session=cookie-secret",
          "Set-Cookie": "session=set-cookie-secret",
          password: "nested-password",
          PASSWD: "nested-passwd",
          secret: "nested-secret"
        }
      ]
    });
    await logger.close();

    const rawLine = (await readFile(logPath, "utf8")).trim();
    const line = parseLine(rawLine);

    for (const secret of [
      "base-api-key",
      "child-secret",
      "nested-token",
      "nested-access-token",
      "nested-refresh-token",
      "cookie-secret",
      "set-cookie-secret",
      "nested-password",
      "nested-passwd",
      "nested-secret"
    ]) {
      expect(rawLine).not.toContain(secret);
    }
    expect(line).toMatchObject({
      service: "core-runtime",
      API_KEY: "[Redacted]",
      Authorization: "[Redacted]",
      client_secret: "[Redacted]",
      module: "gateway",
      payload: [
        {
          token: "[Redacted]",
          nested: {
            access_token: "[Redacted]",
            refresh_token: "[Redacted]"
          }
        },
        {
          Cookie: "[Redacted]",
          "Set-Cookie": "[Redacted]",
          password: "[Redacted]",
          PASSWD: "[Redacted]",
          secret: "[Redacted]"
        }
      ]
    });
  });

  test("truncates info business strings while preserving complete debug content", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const longText = "业务内容".repeat(400);
    const logger = createJsonlFileRuntimeLogger(logPath, { level: "debug" });

    logger.info(longText, {
      payload: {
        text: longText
      }
    });
    logger.debug(longText, {
      payload: {
        text: longText
      }
    });
    await logger.close();

    const [infoLine, debugLine] = (await readFile(logPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map(parseLine);

    expect(String(infoLine?.msg)).toMatch(/^业务内容/);
    expect(String(infoLine?.msg)).toMatch(/\[truncated \d+ chars\]$/);
    expect(String(infoLine?.msg).length).toBeLessThan(longText.length);
    expect(infoLine?.payload).toEqual({
      text: expect.stringMatching(/\[truncated \d+ chars\]$/)
    });
    expect(debugLine).toMatchObject({
      msg: longText,
      payload: {
        text: longText
      }
    });
  });

  test(
    "redacts configured credential values from messages and ordinary string fields at every level",
    async () => {
      const directory = await createTempDirectory();
      const logPath = join(directory, "runtime.jsonl");
      const apiKey = "deepseek-key-that-must-never-leak";
      const oneBotToken = "onebot-token-that-must-never-leak";
      const logger = createJsonlFileRuntimeLogger(logPath, {
        level: "debug",
        redactValues: [apiKey, oneBotToken]
      });

      logger.debug(`debug credential ${apiKey}`, {
        ordinary: `token value ${oneBotToken}`
      });
      logger.info(`info credential ${apiKey}`, {
        nested: [{ text: `value=${oneBotToken}` }]
      });
      logger.warn(`warn credential ${apiKey}`, {
        ordinary: oneBotToken
      });
      logger.error(`error credential ${apiKey}`, {
        errorMessage: `provider rejected ${oneBotToken}`
      });
      await logger.close();

      const raw = await readFile(logPath, "utf8");
      expect(raw).not.toContain(apiKey);
      expect(raw).not.toContain(oneBotToken);

      const lines = raw.trimEnd().split("\n").map(parseLine);
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(JSON.stringify(line)).toContain("[Redacted]");
      }
    }
  );

  test("redacts configured credential values from object keys and Error names", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const apiKey = "deepseek-key-inside-metadata";
    const logger = createJsonlFileRuntimeLogger(logPath, {
      level: "debug",
      redactValues: [apiKey]
    });
    const error = new Error("provider failed");
    error.name = `Provider-${apiKey}-Error`;

    logger.debug("metadata credential coverage", {
      [`provider-${apiKey}-field`]: "visible business value",
      error
    });
    await logger.close();

    const rawLine = (await readFile(logPath, "utf8")).trim();
    const line = parseLine(rawLine);

    expect(rawLine).not.toContain(apiKey);
    expect(line).toMatchObject({
      "provider-[Redacted]-field": "visible business value",
      error: {
        type: "Provider-[Redacted]-Error",
        message: "provider failed"
      }
    });
  });

  test("does not inspect disabled debug payloads", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const logger = createJsonlFileRuntimeLogger(logPath, { level: "info" });
    let getterReads = 0;
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "explosive", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("disabled debug payload must stay unread");
      }
    });

    expect(() => logger.debug("disabled", payload)).not.toThrow();
    await logger.close();

    expect(getterReads).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  test("preserves repeated references while marking real cycles", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const logger = createJsonlFileRuntimeLogger(logPath, { level: "debug" });
    const shared = { text: "complete shared content" };
    const cycle: { label: string; self?: unknown } = { label: "cycle" };
    cycle.self = cycle;

    logger.debug("reference coverage", {
      a: shared,
      b: shared,
      cycle
    });
    await logger.close();

    expect(parseLine((await readFile(logPath, "utf8")).trim())).toMatchObject({
      a: { text: "complete shared content" },
      b: { text: "complete shared content" },
      cycle: {
        label: "cycle",
        self: "[Circular]"
      }
    });
  });

  test("shares flush and close lifecycle across child loggers", async () => {
    const directory = await createTempDirectory();
    const logPath = join(directory, "runtime.jsonl");
    const logger = createJsonlFileRuntimeLogger(logPath);
    const child = logger.child({ module: "child" });

    child.info("before flush", { sequence: 1 });
    await child.flush();

    expect((await readFile(logPath, "utf8")).trim()).not.toBe("");

    await child.close();
    await expect(logger.flush()).resolves.toBeUndefined();
    await expect(logger.close()).resolves.toBeUndefined();
    expect(() => logger.info("ignored after close", { sequence: 2 })).not.toThrow();

    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0] ?? "")).toMatchObject({
      module: "child",
      sequence: 1,
      msg: "before flush"
    });
  });

  test("reports mkdir failures to stderr without throwing into callers", async () => {
    const directory = await createTempDirectory();
    const credential = "prefix-long-secret";
    const blocker = join(directory, credential);
    await writeFile(blocker, "block", "utf8");
    const logPath = join(blocker, "nested", "runtime.jsonl");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const logger = createJsonlFileRuntimeLogger(logPath, {
      redactValues: ["prefix", credential]
    });

    expect(() => logger.info("mkdir failure", { sequence: 1 })).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    await expect(logger.close()).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalled();
    const stderrText = stderr.mock.calls.flat().join(" ");
    expect(stderrText).toContain("HuanLink runtime log sink error");
    expect(stderrText).not.toContain("long-secret");
  });

  test("reports append failures to stderr without throwing into callers", async () => {
    const directory = await createTempDirectory();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const logger = createJsonlFileRuntimeLogger(directory);

    expect(() => logger.error("append failure", { sequence: 1 })).not.toThrow();
    await expect(logger.close()).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).toContain(
      "HuanLink runtime log sink error"
    );
  });

  test("returns a flushable logger contract from root and child", async () => {
    const directory = await createTempDirectory();
    const logger: FlushableRuntimeLogger = createJsonlFileRuntimeLogger(
      join(directory, "runtime.jsonl")
    );
    const child: FlushableRuntimeLogger = logger.child({ module: "child" });

    expect(typeof logger.flush).toBe("function");
    expect(typeof logger.close).toBe("function");
    expect(typeof child.flush).toBe("function");
    expect(typeof child.close).toBe("function");

    await logger.close();
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "huanlink-jsonl-"));
  tempDirectories.add(directory);
  return directory;
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}
