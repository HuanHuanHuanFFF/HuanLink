// 验证 Core 导出的 AgentRuntime 合同保持框架无关。
import { describe, expect, test } from "vitest";

import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
  RunId,
  SessionId
} from "../src/index.js";

describe("agent runtime contract", () => {
  // 验证公共类型足以表达一次最小文本 run。
  test("exports a framework-agnostic text run contract", async () => {
    const runId: RunId = "run_local_runtime_01";
    const sessionId: SessionId = "session_local_runtime_01";
    const abortController = new AbortController();

    const runtime: AgentRuntime = {
      // 用最小假实现验证合同形状即可被消费。
      async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
        return {
          output: `${input.runId}:${input.sessionId}:${input.input}`
        };
      }
    };

    const result = await runtime.run({
      runId,
      sessionId,
      input: "hello local runtime",
      signal: abortController.signal
    });

    expect(result).toEqual({
      output: "run_local_runtime_01:session_local_runtime_01:hello local runtime"
    });
  });
});
