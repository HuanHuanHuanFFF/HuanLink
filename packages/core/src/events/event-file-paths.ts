// 负责生成运行事件 JSONL 文件路径，并做路径安全保护。
import path from "node:path";

import type {RunId} from "../shared/ids.js";

const RUNS_DIR = "runs";
const EVENTS_FILE_NAME = "events.jsonl";

// 解析某个 run 对应的 events.jsonl 绝对路径，并保证路径不会逃出 baseDir。
export function getEventFilePath(baseDir: string, runId: RunId): string {
    const eventFilePath = path.resolve(
        baseDir,
        RUNS_DIR,
        encodeRunId(runId),
        EVENTS_FILE_NAME
    );

    assertInsideBaseDir(baseDir, eventFilePath);

    return eventFilePath;
}

// 把 runId 编码成可安全落盘的目录名。
export function encodeRunId(runId: RunId): string {
    return Buffer.from(runId, "utf8").toString("base64url") || "_";
}

// 拒绝逃出配置 baseDir 的目标路径。
function assertInsideBaseDir(baseDir: string, filePath: string): void {
    const relativePath = path.relative(baseDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`JSONL EventLog path escapes baseDir: ${filePath}`);
    }
}
