// 验证最小 replay reducer 和 reader 能从事件流恢复 RunView。
import {describe, expect, test} from "vitest";

import {
    AgentLoop,
    AllowPolicyEngine,
    EventLogRunViewReader,
    InMemoryEventLog,
    ToolGateway,
    createRunView,
    echoTool
} from "../src/index.js";
import type {
    AgentEventDraft,
    ModelClient,
    ModelMessage,
    ModelResponse,
    Tool
} from "../src/index.js";

// 用脚本化响应驱动 replay 测试里的最小 model 行为。
class ScriptedModelClient implements ModelClient {
    constructor(
        private readonly responses: ModelResponse[]
    ) {}

    // 按预设顺序返回下一个模型响应。
    async complete(): Promise<ModelResponse> {
        const response = this.responses.shift();

        if (!response) {
            throw new Error("No scripted model response available");
        }

        return response;
    }
}

// 复用现有测试模式，组装最小 AgentLoop。
function createLoop(input: {
    eventLog: InMemoryEventLog;
    modelClient: ModelClient;
    tools?: Tool[];
}): AgentLoop {
    const toolGateway = new ToolGateway({
        eventWriter: input.eventLog,
        policyEngine: new AllowPolicyEngine(),
        tools: input.tools ?? [echoTool]
    });

    return new AgentLoop({
        eventWriter: input.eventLog,
        modelClient: input.modelClient,
        toolGateway
    });
}

// 把 RunView 序列化成稳定字符串，供测试在内存里收集断言。
function formatRunView(label: string, view: unknown): string {
    return `${label}\n${JSON.stringify(view, null, 2)}`;
}

// 向内存事件日志追加一组最小测试事件。
function appendEvents(
    eventLog: InMemoryEventLog,
    events: AgentEventDraft[]
): void {
    for (const event of events) {
        eventLog.append(event);
    }
}

describe("replay reducer", () => {
    test("restores a completed run into the minimal RunView", async () => {
        const logs: string[] = [];
        const eventLog = new InMemoryEventLog();
        const loop = createLoop({
            eventLog,
            modelClient: new ScriptedModelClient([
                {
                    message: {
                        role: "assistant",
                        content: "Call echo"
                    },
                    toolCalls: [
                        {
                            id: "call_replay_echo_01",
                            name: "echo",
                            args: {text: "hello replay"}
                        }
                    ]
                },
                {
                    message: {
                        role: "assistant",
                        content: "Final answer from replay"
                    }
                }
            ])
        });

        await loop.run({
            runId: "run_replay_success_01",
            sessionId: "session_replay_success_01",
            userMessage: "Run replay success"
        });

        const view = createRunView(
            eventLog.readRunEvents("run_replay_success_01")
        );
        logs.push(formatRunView("run_replay_success_01 RunView", view));

        expect(view).toMatchObject({
            runId: "run_replay_success_01",
            sessionId: "session_replay_success_01",
            status: "completed",
            eventCount: 11,
            lastSeq: 11,
            finalAnswer: "Final answer from replay",
            toolCalls: [
                {
                    toolCallId: "call_replay_echo_01",
                    toolName: "echo",
                    step: 0,
                    status: "completed",
                    output: "hello replay"
                }
            ]
        });
        expect(view?.startedAt).toEqual(expect.any(String));
        expect(view?.endedAt).toEqual(expect.any(String));
        expect(view?.durationSeconds).toBe(
            (Date.parse(view!.endedAt!) - Date.parse(view!.startedAt)) / 1000
        );
        expect(view?.toolCalls[0]?.parentEventId).toEqual(expect.any(String));
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("run_replay_success_01 RunView");
        expect(logs[0]).toContain('"status": "completed"');
    });

    test("returns null when the reducer receives no events", () => {
        expect(createRunView([])).toBeNull();
    });

    test("returns running when events exist but no terminal event is present", () => {
        const eventLog = new InMemoryEventLog();
        appendEvents(eventLog, [
            {
                type: "run.created",
                runId: "run_replay_running_01",
                sessionId: "session_replay_running_01",
                source: "agent_loop",
                data: {
                    userMessage: "Still running"
                }
            },
            {
                type: "context.built",
                runId: "run_replay_running_01",
                sessionId: "session_replay_running_01",
                source: "agent_loop",
                data: {
                    messages: [
                        {
                            role: "user",
                            content: "Still running"
                        }
                    ],
                    messageCount: 1
                }
            },
            {
                type: "model.requested",
                runId: "run_replay_running_01",
                sessionId: "session_replay_running_01",
                source: "agent_loop",
                step: 0,
                data: {
                    step: 0
                }
            }
        ]);

        const view = createRunView(
            eventLog.readRunEvents("run_replay_running_01")
        );

        expect(view).toMatchObject({
            runId: "run_replay_running_01",
            sessionId: "session_replay_running_01",
            status: "running",
            eventCount: 3,
            lastSeq: 3
        });
        expect(view?.endedAt).toBeUndefined();
        expect(view?.durationSeconds).toBeUndefined();
    });

    test("restores run.failed explicitly from terminal run events", () => {
        const eventLog = new InMemoryEventLog();
        appendEvents(eventLog, [
            {
                type: "run.created",
                runId: "run_replay_failed_01",
                sessionId: "session_replay_failed_01",
                source: "agent_loop",
                data: {
                    userMessage: "Fail explicitly"
                }
            },
            {
                type: "run.failed",
                runId: "run_replay_failed_01",
                sessionId: "session_replay_failed_01",
                source: "agent_loop",
                data: {
                    error: "Explicit failure"
                }
            }
        ]);

        const view = createRunView(
            eventLog.readRunEvents("run_replay_failed_01")
        );

        expect(view).toMatchObject({
            runId: "run_replay_failed_01",
            sessionId: "session_replay_failed_01",
            status: "failed",
            error: "Explicit failure",
            eventCount: 2,
            lastSeq: 2
        });
        expect(view?.endedAt).toEqual(expect.any(String));
        expect(view?.durationSeconds).toBe(
            (Date.parse(view!.endedAt!) - Date.parse(view!.startedAt)) / 1000
        );
    });

    test("restores run.cancelled explicitly from terminal run events", () => {
        const eventLog = new InMemoryEventLog();
        appendEvents(eventLog, [
            {
                type: "run.created",
                runId: "run_replay_cancelled_01",
                sessionId: "session_replay_cancelled_01",
                source: "agent_loop",
                data: {
                    userMessage: "Cancel explicitly"
                }
            },
            {
                type: "run.cancelled",
                runId: "run_replay_cancelled_01",
                sessionId: "session_replay_cancelled_01",
                source: "agent_loop",
                data: {
                    reason: "Explicit cancellation"
                }
            }
        ]);

        const view = createRunView(
            eventLog.readRunEvents("run_replay_cancelled_01")
        );

        expect(view).toMatchObject({
            runId: "run_replay_cancelled_01",
            sessionId: "session_replay_cancelled_01",
            status: "cancelled",
            error: "Explicit cancellation",
            eventCount: 2,
            lastSeq: 2
        });
        expect(view?.endedAt).toEqual(expect.any(String));
        expect(view?.durationSeconds).toBe(
            (Date.parse(view!.endedAt!) - Date.parse(view!.startedAt)) / 1000
        );
    });

    test("prefers max_steps_exceeded over the trailing run.failed event", async () => {
        const logs: string[] = [];
        const eventLog = new InMemoryEventLog();
        const loop = createLoop({
            eventLog,
            modelClient: new ScriptedModelClient([
                {
                    message: {
                        role: "assistant",
                        content: "Loop once"
                    },
                    toolCalls: [
                        {
                            id: "call_replay_loop_01",
                            name: "echo",
                            args: {text: "again"}
                        }
                    ]
                }
            ])
        });

        await expect(
            loop.run({
                runId: "run_replay_max_steps_01",
                sessionId: "session_replay_max_steps_01",
                userMessage: "Loop until max steps",
                maxSteps: 1
            })
        ).rejects.toThrow("AgentLoop exceeded maxSteps: 1");

        const view = createRunView(
            eventLog.readRunEvents("run_replay_max_steps_01")
        );
        logs.push(formatRunView("run_replay_max_steps_01 RunView", view));

        expect(view).toMatchObject({
            runId: "run_replay_max_steps_01",
            sessionId: "session_replay_max_steps_01",
            status: "max_steps_exceeded",
            error: "AgentLoop exceeded maxSteps: 1",
            toolCalls: [
                {
                    toolCallId: "call_replay_loop_01",
                    toolName: "echo",
                    status: "completed",
                    output: "again"
                }
            ]
        });
        expect(view?.endedAt).toEqual(expect.any(String));
        expect(view?.durationSeconds).toBe(
            (Date.parse(view!.endedAt!) - Date.parse(view!.startedAt)) / 1000
        );
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("run_replay_max_steps_01 RunView");
        expect(logs[0]).toContain('"status": "max_steps_exceeded"');
    });
});

describe("EventLogRunViewReader", () => {
    test("returns null when the reader cannot find a run", async () => {
        const reader = new EventLogRunViewReader({
            eventReader: new InMemoryEventLog()
        });

        await expect(reader.readRunView("run_missing_01")).resolves.toBeNull();
    });

    test("restores blocked tool calls from EventReader-backed events", async () => {
        const logs: string[] = [];
        const eventLog = new InMemoryEventLog();
        const toolGateway = new ToolGateway({
            eventWriter: eventLog,
            policyEngine: {
                decide() {
                    return {
                        kind: "deny",
                        reason: "policy blocked replay tool"
                    };
                }
            },
            tools: [echoTool]
        });
        const loop = new AgentLoop({
            eventWriter: eventLog,
            modelClient: new ScriptedModelClient([
                {
                    message: {
                        role: "assistant",
                        content: "Call denied echo"
                    },
                    toolCalls: [
                        {
                            id: "call_replay_blocked_01",
                            name: "echo",
                            args: {text: "blocked"}
                        }
                    ]
                },
                {
                    message: {
                        role: "assistant",
                        content: "Recovered after blocked tool"
                    }
                }
            ]),
            toolGateway
        });

        await loop.run({
            runId: "run_replay_blocked_01",
            sessionId: "session_replay_blocked_01",
            userMessage: "Run replay blocked"
        });

        const reader = new EventLogRunViewReader({
            eventReader: eventLog
        });
        const view = await reader.readRunView("run_replay_blocked_01");
        logs.push(formatRunView("run_replay_blocked_01 RunView", view));

        expect(view).toMatchObject({
            runId: "run_replay_blocked_01",
            sessionId: "session_replay_blocked_01",
            status: "completed",
            finalAnswer: "Recovered after blocked tool",
            toolCalls: [
                {
                    toolCallId: "call_replay_blocked_01",
                    toolName: "echo",
                    step: 0,
                    status: "blocked",
                    output:
                        "Tool call blocked by policy: policy blocked replay tool"
                }
            ]
        });
        expect(view?.toolCalls[0]?.parentEventId).toEqual(expect.any(String));
        expect(view?.durationSeconds).toBe(
            (Date.parse(view!.endedAt!) - Date.parse(view!.startedAt)) / 1000
        );
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("run_replay_blocked_01 RunView");
        expect(logs[0]).toContain('"status": "blocked"');
    });
});
