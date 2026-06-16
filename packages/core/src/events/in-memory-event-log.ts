// 内存事件日志，用于 mock run 阶段验证事件写入和读取顺序。

import type { AgentEvent, EventLog, RunId } from "../types.js";

// 把事件保存在数组中，方便测试直接断言。
export class InMemoryEventLog implements EventLog {
  readonly events: AgentEvent[] = [];

  // 记录一个事件到内存数组。
  append(event: AgentEvent): void {
    this.events.push(event);
  }

  // 按 runId 读取事件，保留原始写入顺序。
  readByRun(runId: RunId): AgentEvent[] {
    return this.events.filter((event) => event.runId === runId);
  }
}
