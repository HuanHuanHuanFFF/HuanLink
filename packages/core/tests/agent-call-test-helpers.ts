import type {
  AgentCallTaskSnapshot,
  AgentCallTransport
} from "../src/index.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function task(
  state: AgentCallTaskSnapshot["state"],
  overrides: Partial<AgentCallTaskSnapshot> = {}
): AgentCallTaskSnapshot {
  return {
    taskId: "a2a-task-01",
    contextId: "a2a-context-01",
    state,
    artifacts: [],
    ...overrides
  };
}

export function scopeQuestion() {
  return {
    id: "scope",
    header: "Scope",
    question: "Which files may be changed?",
    isOther: false,
    isSecret: false,
    options: null
  };
}

export const rejectUnexpectedContinuation: AgentCallTransport["continueTask"] =
  async () => {
    throw new Error("Unexpected task continuation in this test");
  };
