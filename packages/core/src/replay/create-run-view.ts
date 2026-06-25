// 把单个 run 的事件流压成最小 RunView，供 replay/debug 读取。
import type {AgentEvent} from "../events/types.js";
import type {
    RunView,
    RunViewStatus,
    RunViewToolCallStatus,
    ToolCallView
} from "./types.js";

// reducer 内部使用的可变工具调用聚合对象。
type MutableToolCallView = {
    toolCallId: string;
    toolName: string;
    step?: number;
    status: RunViewToolCallStatus;
    output?: string;
    parentEventId?: string;
};

// 终态冲突时使用的优先级，避免被后续补充事件覆盖。
const TERMINAL_STATUS_PRIORITY: Record<Exclude<RunViewStatus, "running">, number> = {
    completed: 1,
    cancelled: 2,
    failed: 3,
    max_steps_exceeded: 4
};

// 纯 reducer：输入事件数组，输出最小但可用的 run 视图。
export function createRunView(events: AgentEvent[]): RunView | null {
    if (events.length === 0) {
        return null;
    }

    const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
    const firstEvent = orderedEvents[0];
    const lastEvent = orderedEvents[orderedEvents.length - 1];
    const toolCalls = new Map<string, MutableToolCallView>();
    const toolCallOrder: string[] = [];

    let status: RunViewStatus = "running";
    let statusPriority = 0;
    let endedAt: string | undefined;
    let finalAnswer: string | undefined;
    let error: string | undefined;

    for (const event of orderedEvents) {
        switch (event.type) {
            case "tool.requested": {
                mergeToolCall(
                    toolCalls,
                    toolCallOrder,
                    event.toolCallId ?? event.data.toolCall.id,
                    event.data.toolCall.name,
                    event.step,
                    "requested"
                );
                break;
            }
            case "tool.completed": {
                mergeToolCall(
                    toolCalls,
                    toolCallOrder,
                    event.toolCallId ?? event.data.result.callId,
                    event.data.result.toolName,
                    event.step,
                    "completed",
                    event.data.result.output
                );
                break;
            }
            case "tool.failed": {
                mergeToolCall(
                    toolCalls,
                    toolCallOrder,
                    event.toolCallId ?? event.data.result.callId,
                    event.data.result.toolName,
                    event.step,
                    "failed",
                    event.data.result.output
                );
                break;
            }
            case "tool.blocked": {
                mergeToolCall(
                    toolCalls,
                    toolCallOrder,
                    event.toolCallId ?? event.data.result.callId,
                    event.data.result.toolName,
                    event.step,
                    "blocked",
                    event.data.result.output
                );
                break;
            }
            case "observation.appended": {
                const toolCall = mergeToolCall(
                    toolCalls,
                    toolCallOrder,
                    event.data.toolCallId,
                    event.data.toolName,
                    event.step,
                    "requested"
                );

                toolCall.parentEventId = event.parentEventId;
                if (toolCall.output === undefined) {
                    toolCall.output = event.data.message.content;
                }
                break;
            }
            case "run.completed": {
                const nextPriority = TERMINAL_STATUS_PRIORITY.completed;
                if (nextPriority >= statusPriority) {
                    status = "completed";
                    statusPriority = nextPriority;
                    endedAt = event.timestamp;
                    finalAnswer = event.data.finalAnswer;
                    error = undefined;
                }
                break;
            }
            case "run.cancelled": {
                const nextPriority = TERMINAL_STATUS_PRIORITY.cancelled;
                if (nextPriority >= statusPriority) {
                    status = "cancelled";
                    statusPriority = nextPriority;
                    endedAt = event.timestamp;
                    error = event.data.reason;
                }
                break;
            }
            case "run.failed": {
                const nextPriority = TERMINAL_STATUS_PRIORITY.failed;
                if (nextPriority >= statusPriority) {
                    status = "failed";
                    statusPriority = nextPriority;
                    endedAt = event.timestamp;
                    error = event.data.error;
                }
                break;
            }
            case "run.max_steps_exceeded": {
                const nextPriority = TERMINAL_STATUS_PRIORITY.max_steps_exceeded;
                if (nextPriority >= statusPriority) {
                    status = "max_steps_exceeded";
                    statusPriority = nextPriority;
                    endedAt = event.timestamp;
                    error = `AgentLoop exceeded maxSteps: ${event.data.maxSteps}`;
                }
                break;
            }
            default:
                break;
        }
    }

    return {
        runId: firstEvent.runId,
        sessionId: firstEvent.sessionId,
        status,
        startedAt: firstEvent.timestamp,
        endedAt,
        durationSeconds:
            endedAt === undefined
                ? undefined
                : (Date.parse(endedAt) - Date.parse(firstEvent.timestamp)) /
                  1000,
        eventCount: orderedEvents.length,
        lastSeq: lastEvent.seq,
        finalAnswer,
        error,
        toolCalls: toolCallOrder.map((toolCallId) =>
            freezeToolCallView(toolCalls.get(toolCallId)!)
        )
    };
}

// 按 toolCallId 聚合同一次工具调用的分散事件。
function mergeToolCall(
    toolCalls: Map<string, MutableToolCallView>,
    toolCallOrder: string[],
    toolCallId: string,
    toolName: string,
    step: number | undefined,
    status: RunViewToolCallStatus,
    output?: string
): MutableToolCallView {
    let toolCall = toolCalls.get(toolCallId);

    if (!toolCall) {
        toolCall = {
            toolCallId,
            toolName,
            step,
            status,
            output
        };
        toolCalls.set(toolCallId, toolCall);
        toolCallOrder.push(toolCallId);
        return toolCall;
    }

    toolCall.toolName = toolName;
    toolCall.step ??= step;
    if (!(status === "requested" && toolCall.status !== "requested")) {
        toolCall.status = status;
    }
    if (output !== undefined) {
        toolCall.output = output;
    }

    return toolCall;
}

// 把内部可变聚合对象转成对外只读视图。
function freezeToolCallView(toolCall: MutableToolCallView): ToolCallView {
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        step: toolCall.step,
        status: toolCall.status,
        output: toolCall.output,
        parentEventId: toolCall.parentEventId
    };
}
