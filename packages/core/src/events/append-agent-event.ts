// 统一构造事件 draft 并写入 EventWriter 的共享助手，集中收敛类型转换。
import type {EventWriter} from "./event-log.js";
import type {
    AgentEvent,
    AgentEventDataByType,
    AgentEventDraft,
    AgentEventSource,
    AgentEventType
} from "./types.js";
import type {RunId, SessionId} from "../shared/ids.js";

// 事件写入方提供的公共 envelope 字段与关联信息。
export type AppendAgentEventInput<Type extends AgentEventType> = {
    type: Type;
    runId: RunId;
    sessionId: SessionId;
    source: AgentEventSource;
    step?: number;
    toolCallId?: string;
    parentEventId?: string;
    data: AgentEventDataByType[Type];
};

// 把基础字段与业务 payload 组装成 draft，再交给 EventWriter 补齐完整事件。
export function appendAgentEvent<Type extends AgentEventType>(
    eventWriter: EventWriter,
    input: AppendAgentEventInput<Type>
): Promise<AgentEvent> | AgentEvent {
    return eventWriter.append(input as AgentEventDraft);
}
