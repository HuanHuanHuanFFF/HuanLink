// 基于 JSONL 文件的 EventLog，用于持久化单次 run 的事件序列。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEvent, EventLog, RunId } from "../types.js";

const DEFAULT_BASE_DIR = ".huaness";
const RUNS_DIR = "runs";
const EVENTS_FILE_NAME = "events.jsonl";

// 将事件按 runId 写入独立 JSONL 文件，并支持按 run 读回。
export class JsonlEventLog implements EventLog {
  private readonly baseDir: string;

  // 设置事件日志根目录，默认写入仓库本地的 .huaness。
  constructor(input: { baseDir?: string } = {}) {
    this.baseDir = path.resolve(input.baseDir ?? DEFAULT_BASE_DIR);
  }

  // 追加一个完整事件为单行 JSON。
  async append(event: AgentEvent): Promise<void> {
    try {
      const eventFilePath = this.eventFilePath(event.runId);
      await mkdir(path.dirname(eventFilePath), { recursive: true });
      await appendFile(eventFilePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      throw new Error(
        `Failed to append JSONL EventLog event for run "${event.runId}": ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  // 按 runId 读取事件，保持文件中的写入顺序。
  async readByRun(runId: RunId): Promise<AgentEvent[]> {
    const eventFilePath = this.eventFilePath(runId);
    let content: string;

    try {
      content = await readFile(eventFilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw new Error(
        `Failed to read JSONL EventLog events for run "${runId}": ${errorMessage(error)}`,
        { cause: error }
      );
    }

    const events: AgentEvent[] = [];

    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      const trimmedLine = line.trim();

      if (trimmedLine.length === 0) {
        continue;
      }

      let event: AgentEvent;

      try {
        event = JSON.parse(trimmedLine) as AgentEvent;
      } catch (error) {
        throw new Error(
          `Failed to parse JSONL EventLog line ${index + 1} for run "${runId}": ${errorMessage(error)}`,
          { cause: error }
        );
      }

      if (event.runId === runId) {
        events.push(event);
      }
    }

    return events;
  }

  // 生成某个 run 对应的事件文件路径。
  private eventFilePath(runId: RunId): string {
    const eventFilePath = path.resolve(
      this.baseDir,
      RUNS_DIR,
      encodeRunId(runId),
      EVENTS_FILE_NAME
    );

    this.assertInsideBaseDir(eventFilePath);

    return eventFilePath;
  }

  // 防止事件文件路径逃出 baseDir。
  private assertInsideBaseDir(filePath: string): void {
    const relativePath = path.relative(this.baseDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`JSONL EventLog path escapes baseDir: ${filePath}`);
    }
  }
}

// 将 runId 转成路径安全的目录名。
function encodeRunId(runId: RunId): string {
  return Buffer.from(runId, "utf8").toString("base64url") || "_";
}

// 提取可读的错误信息。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 识别带 code 的 Node.js 错误。
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
