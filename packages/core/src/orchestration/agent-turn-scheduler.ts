import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from "../runtime/agent-runtime.js";
import type { SessionId } from "../shared/ids.js";

export type AgentTurnSchedulerOptions = {
  runtime: AgentRuntime;
};

export type AgentTurnOperation<T> = {
  sessionId: SessionId;
  signal?: AbortSignal;
  operation: () => Promise<T>;
};

// 同一 session 的 fresh turns 串行执行，不把远端长任务放进本地 run。
export class AgentTurnScheduler implements AgentRuntime {
  private readonly runtime: AgentRuntime;
  private readonly tails = new Map<SessionId, Promise<void>>();

  constructor(options: AgentTurnSchedulerOptions) {
    this.runtime = options.runtime;
  }

  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runOperation({
      sessionId: input.sessionId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      operation: () => this.runtime.run(input),
    });
  }

  runOperation<T>(request: AgentTurnOperation<T>): Promise<T> {
    const previous = this.tails.get(request.sessionId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => {
        request.signal?.throwIfAborted();
        return request.operation();
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(request.sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(request.sessionId) === tail) {
        this.tails.delete(request.sessionId);
      }
    });
    return result;
  }
}
