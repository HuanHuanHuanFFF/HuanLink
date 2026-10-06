import { TaskState, type Task } from "@a2a-js/sdk";
import {
  InMemoryTaskStore,
  ResultManager,
  type ExecutionEventBusManager,
  type ServerCallContext,
  type AgentExecutionEvent,
} from "@a2a-js/sdk/server";

/**
 * The pinned SDK ends its normal persistence consumer at input-required.
 * Experimental out-of-band decisions therefore own persistence from a
 * permission pause until the next ordinary question or terminal event.
 */
export class DelegationTaskStore extends InMemoryTaskStore {
  private readonly drains = new Map<
    string,
    { pending: Promise<void>; stop: () => void }
  >();
  private readonly failures = new Map<string, unknown>();
  constructor(private readonly buses: ExecutionEventBusManager) {
    super();
  }
  override async save(task: Task, context: ServerCallContext): Promise<void> {
    await super.save(task, context);
    if (
      task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED ||
      !task.status.message?.parts.some(
        (p) => p.content?.$case === "data" && p.content.value.permissionRequest,
      ) ||
      this.drains.has(task.id)
    )
      return;
    const bus = this.buses.getByTaskId(task.id);
    if (!bus) throw new Error("Permission task lost its event bus");
    const manager = new ResultManager(this, context);
    const state = {
      pending: Promise.resolve(),
      stop: () => {
        bus.off("event", listener);
      },
    };
    const listener = (event: AgentExecutionEvent) => {
      const finishing =
        event.kind === "statusUpdate" &&
        !!event.data.status &&
        ([
          TaskState.TASK_STATE_COMPLETED,
          TaskState.TASK_STATE_FAILED,
          TaskState.TASK_STATE_CANCELED,
          TaskState.TASK_STATE_REJECTED,
        ].includes(event.data.status.state) ||
          (event.data.status.state === TaskState.TASK_STATE_INPUT_REQUIRED &&
            !event.data.status.message?.parts.some(
              (p) =>
                p.content?.$case === "data" &&
                p.content.value.permissionRequest,
            )));
      if (finishing) state.stop();
      state.pending = state.pending
        .then(() => manager.processEvent(event))
        .catch((error) => {
          this.failures.set(task.id, error);
          state.stop();
        });
      if (finishing)
        void state.pending.finally(() => {
          if (this.drains.get(task.id) === state) this.drains.delete(task.id);
        });
    };
    this.drains.set(task.id, state);
    bus.on("event", listener);
  }
  async flush(taskId: string) {
    await this.drains.get(taskId)?.pending;
    if (this.failures.has(taskId))
      throw new Error("Delegation state persistence failed", {
        cause: this.failures.get(taskId),
      });
  }
  async close() {
    const drains = [...this.drains.values()];
    for (const drain of drains) drain.stop();
    await Promise.all(drains.map((d) => d.pending));
    this.drains.clear();
  }
}
