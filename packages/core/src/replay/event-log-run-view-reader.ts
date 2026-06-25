// 基于 EventReader 读取单个 run 事件，再交给 reducer 还原最小视图。
import type {EventReader} from "../events/event-log.js";
import type {RunId} from "../shared/ids.js";
import {createRunView} from "./create-run-view.js";
import type {RunView} from "./types.js";
import type {RunViewReader} from "./run-view-reader.js";

// 基于 EventReader 实现最小 RunView 读取器。
export class EventLogRunViewReader implements RunViewReader {
    private readonly eventReader: EventReader;

    // 注入事件读取边界，保持 replay 不依赖具体 EventLog 实现。
    constructor(input: {
        eventReader: EventReader;
    }) {
        this.eventReader = input.eventReader;
    }

    // 先读取单个 run 的事件流，再交给 reducer 还原视图。
    async readRunView(runId: RunId): Promise<RunView | null> {
        const events = await this.eventReader.readRunEvents(runId);
        return createRunView(events);
    }
}
