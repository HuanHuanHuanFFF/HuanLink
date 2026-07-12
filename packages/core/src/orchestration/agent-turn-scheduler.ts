import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult
} from "../runtime/agent-runtime.js";
import type { SessionId } from "../shared/ids.js";

export type AgentTurnSchedulerOptions = {
  runtime: AgentRuntime;
};

// 同一 session 的 fresh turns 串行执行，不把远端长任务放进本地 run。
export class AgentTurnScheduler implements AgentRuntime {
  private readonly runtime: AgentRuntime;
  private readonly tails = new Map<SessionId, Promise<void>>();

  constructor(options: AgentTurnSchedulerOptions) {
    this.runtime = options.runtime;
  }

  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => this.runtime.run(input));
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(input.sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(input.sessionId) === tail) {
        this.tails.delete(input.sessionId);
      }
    });
    return result;
  }
}
