import {errorMessage} from "../shared/errors.js";
import {
    AGENT_EVENT_SOURCES,
    AGENT_EVENT_TYPES,
    CORE_SCHEMA_VERSION
} from "./types.js";
import type {
    AgentEvent,
    AgentEventSource,
    AgentEventType
} from "./types.js";
import type {RunId} from "../shared/ids.js";

// 负责事件的 JSONL 编解码和 envelope 校验。

// 把完整事件序列化成一行 JSONL 内容。
export function serializeEvent(event: AgentEvent): string {
    return JSON.stringify(event);
}

// 解析 JSONL 文本，跳过空行，并返回校验后的事件列表。
export function parseEventsJsonl(content: string, runId: RunId): AgentEvent[] {
    const events: AgentEvent[] = [];

    for (const [index, line] of content.split(/\r?\n/u).entries()) {
        const trimmedLine = line.trim();

        if (trimmedLine.length === 0) {
            continue;
        }

        events.push(parseEventLine(trimmedLine, index + 1, runId));
    }

    return events;
}

// 解析单行 JSONL，并把 JSON 语法错误包装成带上下文的异常。
function parseEventLine(
    line: string,
    lineNumber: number,
    runId: RunId
): AgentEvent {
    let value: unknown;

    try {
        value = JSON.parse(line);
    } catch (error) {
        throw new Error(
            `Failed to parse JSONL EventLog line ${lineNumber} for run "${runId}": ${errorMessage(error)}`,
            {cause: error}
        );
    }

    assertAgentEventEnvelope(value, lineNumber, runId);

    return value;
}

// 校验稳定的事件 envelope，避免调用方信任非法数据。
function assertAgentEventEnvelope(
    value: unknown,
    lineNumber: number,
    runId: RunId
): asserts value is AgentEvent {
    const record = isRecord(value) ? value : undefined;
    const seq = record?.seq;
    const step = record?.step;
    const toolCallId = record?.toolCallId;
    const parentEventId = record?.parentEventId;

    if (
        record === undefined ||
        record.schemaVersion !== CORE_SCHEMA_VERSION ||
        typeof record.id !== "string" ||
        typeof seq !== "number" ||
        !Number.isInteger(seq) ||
        seq < 1 ||
        (
            step !== undefined &&
            (typeof step !== "number" || !Number.isInteger(step) || step < 0)
        ) ||
        (toolCallId !== undefined && typeof toolCallId !== "string") ||
        (parentEventId !== undefined && typeof parentEventId !== "string") ||
        typeof record.timestamp !== "string" ||
        !isAgentEventType(record.type) ||
        typeof record.runId !== "string" ||
        typeof record.sessionId !== "string" ||
        !isAgentEventSource(record.source) ||
        !isRecord(record.data)
    ) {
        throw new Error(
            `Invalid JSONL EventLog event envelope on line ${lineNumber} for run "${runId}"`
        );
    }
}

// 判断解析出的 type 是否属于支持的事件类型集合。
function isAgentEventType(value: unknown): value is AgentEventType {
    return (
        typeof value === "string" &&
        (AGENT_EVENT_TYPES as readonly string[]).includes(value)
    );
}

// 判断解析出的 source 是否属于支持的来源集合。
function isAgentEventSource(value: unknown): value is AgentEventSource {
    return (
        typeof value === "string" &&
        (AGENT_EVENT_SOURCES as readonly string[]).includes(value)
    );
}

// 把未知 JSON 值收窄为普通对象记录。
function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}
