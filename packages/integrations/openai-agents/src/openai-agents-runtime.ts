// 用 @openai/agents Runner 适配 Core 的 AgentRuntime 合同。
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
  AgentRuntimeTrigger,
  RunId,
  SessionId
} from "@huanlink/core";
import { Agent, Runner } from "@openai/agents";

// 约束运行时真正依赖的最小 Runner 形状，便于测试替身注入。
export type OpenAiAgentsRunner = {
  run(
    agent: Agent<any, any>,
    input: string,
    options?: {
      signal?: AbortSignal;
      context?: OpenAiAgentsRunContext;
    }
  ): Promise<{ finalOutput: unknown }>;
};

export type OpenAiAgentsRunContext = {
  runId: RunId;
  sessionId: SessionId;
  trigger: AgentRuntimeTrigger;
};

// 描述 OpenAI Agents 适配运行时的构造参数。
export type OpenAiAgentsRuntimeOptions = {
  agent: Agent<any, any>;
  runner?: OpenAiAgentsRunner;
};

// 把 OpenAI Agents JS 的单次 run 映射为 Core 的统一运行接口。
export class OpenAiAgentsRuntime implements AgentRuntime {
  private readonly agent: Agent<any, any>;
  private readonly runner: OpenAiAgentsRunner;

  // 初始化一个面向单次文本 run 的 OpenAI Agents 适配器。
  constructor(options: OpenAiAgentsRuntimeOptions) {
    this.agent = options.agent;
    this.runner = options.runner ?? new Runner({ tracingDisabled: true });
  }

  // 调用真实 Runner，并把最终文本输出收敛为 Core 结果。
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const result = await this.runner.run(this.agent, input.input, {
      signal: input.signal,
      context: {
        runId: input.runId,
        sessionId: input.sessionId,
        trigger: input.trigger ?? "user"
      }
    });

    if (typeof result.finalOutput !== "string") {
      throw new Error(
        "OpenAiAgentsRuntime expected a text finalOutput from @openai/agents"
      );
    }

    return {
      output: result.finalOutput
    };
  }
}
