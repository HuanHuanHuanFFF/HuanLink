// replay 侧最小视图类型，只保留当前 P0 需要的 run 恢复信息。
import type {RunId, SessionId} from "../shared/ids.js";

// RunView 当前支持的最小运行状态集合。
export const RUN_VIEW_STATUSES = [
    "running",
    "completed",
    "failed",
    "cancelled",
    "max_steps_exceeded"
] as const;

export type RunViewStatus = (typeof RUN_VIEW_STATUSES)[number];

// ToolCallView 当前支持的最小工具调用状态集合。
export const RUN_VIEW_TOOL_CALL_STATUSES = [
    "requested",
    "completed",
    "failed",
    "blocked"
] as const;

export type RunViewToolCallStatus =
    (typeof RUN_VIEW_TOOL_CALL_STATUSES)[number];

// 单次工具调用的最小派生视图。
export interface ToolCallView {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly step?: number;
    readonly status: RunViewToolCallStatus;
    readonly output?: string;
    readonly parentEventId?: string;
}

// 单个 run 的最小 replay 摘要视图。
export interface RunView {
    readonly runId: RunId;
    readonly sessionId: SessionId;
    readonly status: RunViewStatus;
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly durationSeconds?: number;
    readonly eventCount: number;
    readonly lastSeq: number;
    readonly finalAnswer?: string;
    readonly error?: string;
    readonly toolCalls: ToolCallView[];
}
