import { TaskState, type Artifact, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  TaskNotCancelableError,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";

export const CONTROLLED_RESPONSE = "Controlled test executor completed the task.";

interface ControlledTaskExecutorOptions {
  waitBeforeComplete?: (signal: AbortSignal) => Promise<void>;
}

interface InFlightExecution {
  controller: AbortController;
  contextId: string;
}

export class ControlledTaskExecutor implements AgentExecutor {
  private readonly inFlight = new Map<string, InFlightExecution>();
  private readonly waitBeforeComplete: (signal: AbortSignal) => Promise<void>;

  constructor(options: ControlledTaskExecutorOptions = {}) {
    this.waitBeforeComplete =
      options.waitBeforeComplete ?? waitForDefaultCompletionWindow;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { contextId, taskId, userMessage } = requestContext;
    const controller = new AbortController();
    this.inFlight.set(taskId, { controller, contextId });

    const initialTask: Task = {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString()
      },
      artifacts: [],
      history: [userMessage],
      metadata: undefined
    };

    eventBus.publish(AgentEvent.task(initialTask));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );

    try {
      await this.waitBeforeComplete(controller.signal);
      if (controller.signal.aborted) {
        return;
      }

      const artifact: Artifact = {
        artifactId: `${taskId}-controlled-result`,
        name: "Controlled test result",
        description: "Test-only A2A lifecycle output.",
        parts: [
          {
            content: { $case: "text", value: CONTROLLED_RESPONSE },
            metadata: undefined,
            filename: "",
            mediaType: "text/plain"
          }
        ],
        metadata: undefined,
        extensions: []
      };

      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact,
          append: false,
          lastChunk: true,
          metadata: undefined
        })
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: new Date().toISOString()
          },
          metadata: undefined
        })
      );
      eventBus.finished();
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const execution = this.inFlight.get(taskId);
    if (!execution) {
      throw new TaskNotCancelableError(`Task ${taskId} is not running`);
    }

    execution.controller.abort();
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: execution.contextId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );
    eventBus.finished();
  }
}

function waitForDefaultCompletionWindow(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    signal.addEventListener("abort", finish, { once: true });
  });
}
