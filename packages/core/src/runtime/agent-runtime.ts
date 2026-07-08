// 定义框架无关的本地 Agent 单次运行合同。
import type { RunId, SessionId } from "../shared/ids.js";

// 描述一次本地 Agent 运行所需的最小输入。
export type AgentRuntimeInput = {
  runId: RunId;
  sessionId: SessionId;
  input: string;
  signal?: AbortSignal;
};

// 描述一次本地 Agent 运行返回的最小文本结果。
export type AgentRuntimeResult = {
  output: string;
};

// 抽象可替换的本地 Agent 运行时适配接口。
export interface AgentRuntime {
  // 执行一次文本输入的本地 Agent 运行。
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
}
