// 验证事件 JSONL 路径生成的编码规则和 baseDir 逃逸防护。
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  encodeRunId,
  getEventFilePath
} from "../src/events/event-file-paths.js";

describe("encodeRunId", () => {
  test("encodes a runId into a filesystem-safe base64url segment", () => {
    const encoded = encodeRunId("run/with:unsafe chars");

    expect(encoded).toBe(
      Buffer.from("run/with:unsafe chars", "utf8").toString("base64url")
    );
    expect(encoded).not.toMatch(/[/:\\]/);
  });

  test("falls back to an underscore for an empty runId", () => {
    expect(encodeRunId("")).toBe("_");
  });
});

describe("getEventFilePath", () => {
  test("resolves the events.jsonl path under runs/<encoded runId>", () => {
    const baseDir = path.resolve("/tmp/huanlink-base");
    const filePath = getEventFilePath(baseDir, "run_paths_01");

    expect(filePath).toBe(
      path.resolve(
        baseDir,
        "runs",
        encodeRunId("run_paths_01"),
        "events.jsonl"
      )
    );
  });

  test("keeps the resolved path inside baseDir even for traversal-like runIds", () => {
    const baseDir = path.resolve("/tmp/huanlink-base");
    // encodeRunId base64url-encodes the runId, so traversal sequences cannot
    // escape baseDir and getEventFilePath must not throw.
    const filePath = getEventFilePath(baseDir, "../../escape");

    expect(filePath.startsWith(path.join(baseDir, "runs"))).toBe(true);
    expect(path.relative(baseDir, filePath).startsWith("..")).toBe(false);
  });
});
