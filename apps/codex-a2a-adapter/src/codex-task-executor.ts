import { Message, TaskState, type Artifact, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  TaskNotCancelableError,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import {
  NoopRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeLogLevel,
  type RuntimeLogger
} from "@huanlink/core";

import type {
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerRequestId,
  CodexRuntimeClient
} from "./codex-app-server-client.js";
import {
  validateDemoWorkspace,
  type ValidatedDemoWorkspace
} from "./workspace-guard.js";

export interface CodexTaskExecutorOptions {
  cancelTimeoutMs?: number;
  client: CodexRuntimeClient;
  expectedBranch: string;
  logger?: RuntimeLogger;
  model: string;
  validateWorkspace?: (
    workspace: string,
    expectedBranch: string
  ) => Promise<ValidatedDemoWorkspace>;
  workspace: string;
}

interface InFlightExecution {
  cancelRequested: boolean;
  changedFiles: Set<string>;
  completionPending: boolean;
  contextId: string;
  diff: string;
  eventBus: ExecutionEventBus;
  finalAnswer: string;
  lastCommentary: string;
  pendingInput?: {
    requestId: CodexAppServerRequestId;
    questions: CodexAppServerRequest["params"]["questions"];
  };
  resolveTerminal(): void;
  resolveTurnReady(): void;
  taskId: string;
  terminal: boolean;
  terminalPromise: Promise<void>;
  threadId?: string;
  turnId?: string;
  turnReadyPromise: Promise<void>;
  turnStarting: boolean;
  workingPublished: boolean;
}

const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

export class CodexTaskExecutor implements AgentExecutor {
  private readonly client: CodexRuntimeClient;
  private readonly cancelTimeoutMs: number;
  private readonly expectedBranch: string;
  private readonly logger: RuntimeLogger;
  private readonly model: string;
  private readonly executions = new Map<string, InFlightExecution>();
  private readonly executionByThread = new Map<string, InFlightExecution>();
  private readonly executionByTurn = new Map<string, InFlightExecution>();
  private readonly threadByContext = new Map<string, Promise<string>>();
  private readonly validateWorkspace: NonNullable<
    CodexTaskExecutorOptions["validateWorkspace"]
  >;
  private readonly workspace: string;
  private readonly unsubscribeClose: () => void;
  private readonly unsubscribeNotifications: () => void;
  private readonly unsubscribeServerRequests: () => void;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: CodexTaskExecutorOptions) {
    this.client = options.client;
    this.cancelTimeoutMs =
      options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.expectedBranch = options.expectedBranch;
    this.logger = options.logger ?? new NoopRuntimeLogger();
    this.model = options.model;
    this.validateWorkspace = options.validateWorkspace ?? validateDemoWorkspace;
    this.workspace = options.workspace;
    this.unsubscribeNotifications = this.client.onNotification((notification) =>
      this.handleNotification(notification)
    );
    this.unsubscribeServerRequests = this.client.onServerRequest((request) =>
      this.handleServerRequest(request)
    );
    this.unsubscribeClose = this.client.onClose((error) =>
      this.handleClientClose(error)
    );
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const existing = this.executions.get(requestContext.taskId);
    if (existing) {
      await this.continueExecution(existing, requestContext, eventBus);
      return;
    }

    const execution = createExecution(requestContext, eventBus);
    this.executions.set(execution.taskId, execution);
    this.writeLog("info", "adapter.task.received", {
      ...executionLogFields(execution),
      messageId: requestContext.userMessage.messageId
    });
    eventBus.publish(AgentEvent.task(createInitialTask(requestContext)));

    if (this.closing) {
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        "Codex task executor is shutting down"
      );
      this.cleanup(execution);
      return;
    }

    try {
      const validated = await this.validateWorkspace(
        this.workspace,
        this.expectedBranch
      );
      if (execution.terminal) {
        return;
      }

      execution.threadId = await this.getOrCreateThread(
        execution.contextId,
        validated.workspace
      );
      this.writeLog("info", "codex.thread.ready", {
        ...executionLogFields(execution),
        threadId: execution.threadId
      });
      if (execution.terminal) {
        return;
      }
      if (this.executionByThread.has(execution.threadId)) {
        throw new Error(
          `Codex thread ${execution.threadId} already has an active task`
        );
      }
      this.executionByThread.set(execution.threadId, execution);

      execution.turnStarting = true;
      const started = await this.client.startTurn({
        threadId: execution.threadId,
        prompt: extractText(requestContext)
      });
      this.setTurnId(execution, started.turnId);
      this.writeLog("info", "codex.turn.started", {
        ...executionLogFields(execution),
        threadId: execution.threadId,
        turnId: started.turnId
      });
      this.publishWorking(execution);

      await execution.terminalPromise;
    } catch (error) {
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.cleanup(execution);
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    const execution = this.executions.get(taskId);
    if (!execution || execution.terminal) {
      throw new TaskNotCancelableError(`Task ${taskId} is not running`);
    }

    execution.cancelRequested = true;
    if (!execution.turnStarting) {
      this.finish(execution, TaskState.TASK_STATE_CANCELED);
      return;
    }

    if (!execution.turnId) {
      await Promise.race([
        execution.turnReadyPromise,
        execution.terminalPromise
      ]);
    }
    if (execution.terminal) {
      return;
    }
    if (!execution.threadId || !execution.turnId) {
      throw new Error(`Task ${taskId} did not expose a Codex turn to interrupt`);
    }

    await this.client.interruptTurn({
      threadId: execution.threadId,
      turnId: execution.turnId
    });
    const terminalReached = await waitForTerminal(
      execution.terminalPromise,
      this.cancelTimeoutMs
    );
    if (!terminalReached) {
      await this.failRuntimeAfterCancellationTimeout(execution);
    }
  }

  close(timeoutMs = 10_000): Promise<void> {
    this.closePromise ??= this.closeExecutions(timeoutMs);
    return this.closePromise;
  }

  private async closeExecutions(timeoutMs: number): Promise<void> {
    this.closing = true;
    const active = [...this.executions.values()];
    await Promise.all(
      active.map(async (execution) => {
        if (execution.terminal) {
          return;
        }
        if (!execution.threadId || !execution.turnId) {
          this.finish(execution, TaskState.TASK_STATE_CANCELED);
          return;
        }
        if (!execution.cancelRequested) {
          execution.cancelRequested = true;
          try {
            await this.client.interruptTurn({
              threadId: execution.threadId,
              turnId: execution.turnId
            });
          } catch (error) {
            this.finish(
              execution,
              TaskState.TASK_STATE_FAILED,
              `Failed to interrupt Codex turn during shutdown: ${describeError(error)}`
            );
          }
        }
      })
    );

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(active.map((execution) => execution.terminalPromise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      })
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      for (const execution of active) {
        this.finish(
          execution,
          TaskState.TASK_STATE_FAILED,
          "Timed out waiting for Codex turn shutdown"
        );
      }
    }
    this.unsubscribeNotifications();
    this.unsubscribeServerRequests();
    this.unsubscribeClose();
  }

  private async continueExecution(
    execution: InFlightExecution,
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    if (execution.terminal || !execution.pendingInput) {
      throw new Error(`Task ${execution.taskId} is not awaiting user input`);
    }
    if (requestContext.contextId !== execution.contextId) {
      throw new Error(
        `Task ${execution.taskId} continuation has a mismatched context`
      );
    }
    const pending = execution.pendingInput;
    let answers: Record<string, string[]>;
    try {
      answers = extractAnswers(requestContext);
      validateAnswerIds(pending.questions, answers);
    } catch (error) {
      publishInputRequiredUpdate(
        execution,
        eventBus,
        pending.questions,
        `Invalid user-input response: ${describeError(error)}`,
        requestContext.userMessage.messageId
      );
      await execution.terminalPromise;
      return;
    }

    execution.pendingInput = undefined;
    this.writeLog("info", "adapter.task.input_submitted", {
      ...executionLogFields(execution),
      questionIds: pending.questions.map((question) => question.id)
    });
    publishWorkingUpdate(execution, eventBus);
    try {
      await this.client.respondToServerRequest(pending.requestId, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [
            questionId,
            { answers: values }
          ])
        )
      });
    } catch (error) {
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        `Failed to answer Codex user-input request: ${describeError(error)}`
      );
      return;
    }
    await execution.terminalPromise;
  }

  private async failRuntimeAfterCancellationTimeout(
    canceledExecution: InFlightExecution
  ): Promise<void> {
    this.closing = true;
    let closeFailure = "";
    try {
      await this.client.close();
    } catch (error) {
      closeFailure = `; app-server close failed: ${describeError(error)}`;
    }
    for (const execution of this.executions.values()) {
      const failure =
        execution === canceledExecution
          ? `Timed out waiting for Codex interrupted terminal status${closeFailure}`
          : `Codex app-server closed after another task timed out during cancellation${closeFailure}`;
      this.finish(execution, TaskState.TASK_STATE_FAILED, failure);
    }
  }

  private async getOrCreateThread(
    contextId: string,
    workspace: string
  ): Promise<string> {
    const existing = this.threadByContext.get(contextId);
    if (existing) {
      return existing;
    }

    const creating = this.client
      .startThread({
        cwd: workspace,
        developerInstructions: createDeveloperInstructions(this.expectedBranch),
        model: this.model
      })
      .then(({ threadId }) => threadId)
      .catch((error: unknown) => {
        this.threadByContext.delete(contextId);
        throw error;
      });
    this.threadByContext.set(contextId, creating);
    return creating;
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    const params = notification.params;
    if (!params) {
      return;
    }

    if (notification.method === "turn/started") {
      const execution = this.findExecution(params);
      const turn = asRecord(params.turn);
      if (execution && turn && typeof turn.id === "string") {
        this.setTurnId(execution, turn.id);
        this.publishWorking(execution);
      }
      return;
    }

    if (notification.method === "item/started") {
      const execution = this.findExecution(params);
      if (execution) {
        this.publishWorking(execution);
      }
      return;
    }

    if (notification.method === "item/completed") {
      const execution = this.findExecution(params);
      const item = asRecord(params.item);
      if (execution && item) {
        collectCompletedItem(execution, item);
      }
      return;
    }

    if (notification.method === "turn/diff/updated") {
      const execution = this.findExecution(params);
      if (execution && typeof params.diff === "string") {
        execution.diff = params.diff;
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const execution = this.findExecution(params);
      const turn = asRecord(params.turn);
      if (!execution || !turn || typeof turn.status !== "string") {
        return;
      }
      if (typeof turn.id === "string") {
        this.setTurnId(execution, turn.id);
      }
      this.writeLog("info", "codex.turn.completed", {
        ...executionLogFields(execution),
        threadId: execution.threadId,
        turnId: execution.turnId,
        status: turn.status
      });
      if (execution.pendingInput && turn.status === "completed") {
        return;
      }

      if (turn.status === "completed") {
        void this.completeAfterValidation(execution);
      } else if (turn.status === "interrupted") {
        this.finish(execution, TaskState.TASK_STATE_CANCELED);
      } else if (turn.status === "failed") {
        const error = asRecord(turn.error);
        this.finish(
          execution,
          TaskState.TASK_STATE_FAILED,
          typeof error?.message === "string" ? error.message : "Codex turn failed"
        );
      } else {
        this.finish(
          execution,
          TaskState.TASK_STATE_FAILED,
          `Unexpected completed Codex turn status: ${turn.status}`
        );
      }
    }
  }

  private handleServerRequest(request: CodexAppServerRequest): void {
    const execution = this.findServerRequestExecution(request);
    if (!execution || execution.terminal) {
      return;
    }
    if (execution.pendingInput) {
      this.client.discardServerRequest(request.id);
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        "Codex requested additional input before the previous request was answered"
      );
      return;
    }
    execution.pendingInput = {
      requestId: request.id,
      questions: cloneInputQuestions(request.params.questions)
    };
    this.writeLog("info", "adapter.task.input_required", {
      ...executionLogFields(execution),
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      questionIds: request.params.questions.map((question) => question.id)
    });
    publishInputRequiredUpdate(
      execution,
      execution.eventBus,
      request.params.questions,
      undefined,
      request.params.itemId
    );
  }

  private findServerRequestExecution(
    request: CodexAppServerRequest
  ): InFlightExecution | undefined {
    const execution = this.executionByTurn.get(request.params.turnId);
    return execution?.turnId === request.params.turnId &&
      execution.threadId === request.params.threadId
      ? execution
      : undefined;
  }

  private async completeAfterValidation(
    execution: InFlightExecution
  ): Promise<void> {
    if (execution.terminal || execution.completionPending) {
      return;
    }
    execution.completionPending = true;
    try {
      await this.validateWorkspace(this.workspace, this.expectedBranch);
      if (hasMeaningfulResult(execution)) {
        this.finish(execution, TaskState.TASK_STATE_COMPLETED);
      } else {
        this.finish(
          execution,
          TaskState.TASK_STATE_FAILED,
          createEmptyResultFailure(execution)
        );
      }
    } catch (error) {
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        `Workspace changed before Codex completion: ${describeError(error)}`
      );
    }
  }

  private handleClientClose(error: unknown): void {
    this.threadByContext.clear();
    for (const execution of this.executions.values()) {
      this.finish(
        execution,
        TaskState.TASK_STATE_FAILED,
        `Codex app-server connection closed: ${describeError(error)}`
      );
    }
  }

  private findExecution(
    params: Record<string, unknown>
  ): InFlightExecution | undefined {
    const turn = asRecord(params.turn);
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof turn?.id === "string"
          ? turn.id
          : undefined;
    if (turnId) {
      const byTurn = this.executionByTurn.get(turnId);
      if (byTurn) {
        return byTurn;
      }
    }
    return typeof params.threadId === "string"
      ? this.executionByThread.get(params.threadId)
      : undefined;
  }

  private setTurnId(execution: InFlightExecution, turnId: string): void {
    if (execution.turnId && execution.turnId !== turnId) {
      throw new Error(
        `Task ${execution.taskId} received conflicting Codex turn ids`
      );
    }
    execution.turnId = turnId;
    this.executionByTurn.set(turnId, execution);
    execution.resolveTurnReady();
  }

  private publishWorking(execution: InFlightExecution): void {
    if (execution.terminal || execution.workingPublished) {
      return;
    }
    execution.workingPublished = true;
    this.writeLog("info", "adapter.task.working", executionLogFields(execution));
    execution.eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: execution.taskId,
        contextId: execution.contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );
  }

  private finish(
    execution: InFlightExecution,
    state: TaskState,
    failure?: string
  ): void {
    if (execution.terminal) {
      return;
    }
    if (execution.pendingInput) {
      this.client.discardServerRequest(execution.pendingInput.requestId);
      execution.pendingInput = undefined;
    }
    execution.terminal = true;
    execution.resolveTurnReady();

    if (state === TaskState.TASK_STATE_COMPLETED) {
      this.writeLog("info", "adapter.artifact.published", {
        ...executionLogFields(execution),
        changedFileCount: execution.changedFiles.size,
        threadId: execution.threadId,
        turnId: execution.turnId
      });
      execution.eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId: execution.taskId,
          contextId: execution.contextId,
          artifact: createResultArtifact(execution),
          append: false,
          lastChunk: true,
          metadata: undefined
        })
      );
    }

    execution.eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: execution.taskId,
        contextId: execution.contextId,
        status: {
          state,
          message: failure
            ? Message.fromJSON({
                messageId: `${execution.taskId}-failure`,
                contextId: execution.contextId,
                taskId: execution.taskId,
                role: "ROLE_AGENT",
                parts: [{ text: failure }]
              })
            : undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      })
    );
    this.writeLog("info", "adapter.task.terminal", {
      ...executionLogFields(execution),
      state,
      threadId: execution.threadId,
      turnId: execution.turnId,
      ...(failure === undefined ? {} : { failureLength: failure.length })
    });
    execution.eventBus.finished();
    execution.resolveTerminal();
  }

  private cleanup(execution: InFlightExecution): void {
    if (this.executions.get(execution.taskId) === execution) {
      this.executions.delete(execution.taskId);
    }
    if (
      execution.threadId &&
      this.executionByThread.get(execution.threadId) === execution
    ) {
      this.executionByThread.delete(execution.threadId);
    }
    if (
      execution.turnId &&
      this.executionByTurn.get(execution.turnId) === execution
    ) {
      this.executionByTurn.delete(execution.turnId);
    }
  }

  private writeLog(
    level: RuntimeLogLevel,
    message: string,
    fields?: RuntimeLogFields
  ): void {
    try {
      this.logger[level](message, fields);
    } catch {
      // Logging must not change the A2A task lifecycle.
    }
  }
}

function executionLogFields(execution: InFlightExecution): RuntimeLogFields {
  return {
    a2aTaskId: execution.taskId,
    contextId: execution.contextId
  };
}

function createInitialTask(requestContext: RequestContext): Task {
  return {
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [requestContext.userMessage],
    metadata: undefined
  };
}

function createExecution(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus
): InFlightExecution {
  let resolveTerminal!: () => void;
  let resolveTurnReady!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const turnReadyPromise = new Promise<void>((resolve) => {
    resolveTurnReady = resolve;
  });

  return {
    cancelRequested: false,
    changedFiles: new Set(),
    completionPending: false,
    contextId: requestContext.contextId,
    diff: "",
    eventBus,
    finalAnswer: "",
    lastCommentary: "",
    resolveTerminal,
    resolveTurnReady,
    taskId: requestContext.taskId,
    terminal: false,
    terminalPromise,
    turnReadyPromise,
    turnStarting: false,
    workingPublished: false
  };
}

function extractText(requestContext: RequestContext): string {
  const text = requestContext.userMessage.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Codex tasks require at least one text part");
  }
  return text;
}

function extractAnswers(
  requestContext: RequestContext
): Record<string, string[]> {
  const answerParts = requestContext.userMessage.parts.flatMap((part) => {
    if (part.content?.$case !== "data") {
      return [];
    }
    const data = asRecord(part.content.value);
    return data && asRecord(data.answers) ? [data.answers] : [];
  });
  if (answerParts.length !== 1) {
    throw new Error("Task continuation requires one structured answers data part");
  }

  const answers: Record<string, string[]> = {};
  for (const [questionId, value] of Object.entries(answerParts[0]!)) {
    if (!Array.isArray(value) || value.some((answer) => typeof answer !== "string")) {
      throw new Error(`Answer ${questionId} must be an array of strings`);
    }
    answers[questionId] = [...value];
  }
  return answers;
}

function validateAnswerIds(
  questions: CodexAppServerRequest["params"]["questions"],
  answers: Record<string, string[]>
): void {
  const expected = new Set(questions.map((question) => question.id));
  const actual = Object.keys(answers);
  const unknown = actual.filter((questionId) => !expected.has(questionId));
  const missing = questions
    .map((question) => question.id)
    .filter((questionId) => !(questionId in answers));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      [
        unknown.length > 0 ? `unknown question ids: ${unknown.join(", ")}` : "",
        missing.length > 0 ? `missing question ids: ${missing.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; ")
    );
  }
}

function createInputRequiredMessage(
  execution: InFlightExecution,
  questions: CodexAppServerRequest["params"]["questions"],
  failure: string | undefined,
  messageSuffix: string
): Message {
  const readable = questions
    .map((question) => `${question.header}: ${question.question}`)
    .join("\n");
  return Message.fromJSON({
    messageId: `${execution.taskId}-input-required-${messageSuffix}`,
    contextId: execution.contextId,
    taskId: execution.taskId,
    role: "ROLE_AGENT",
    parts: [
      { text: failure ? `${failure}\n${readable}` : readable },
      { data: { questions } }
    ]
  });
}

function publishInputRequiredUpdate(
  execution: InFlightExecution,
  eventBus: ExecutionEventBus,
  questions: CodexAppServerRequest["params"]["questions"],
  failure: string | undefined,
  messageSuffix: string
): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId: execution.taskId,
      contextId: execution.contextId,
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: createInputRequiredMessage(
          execution,
          questions,
          failure,
          messageSuffix
        ),
        timestamp: new Date().toISOString()
      },
      metadata: undefined
    })
  );
}

function cloneInputQuestions(
  questions: CodexAppServerRequest["params"]["questions"]
): CodexAppServerRequest["params"]["questions"] {
  return questions.map((question) => ({
    ...question,
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({ ...option }))
  }));
}

function publishWorkingUpdate(
  execution: InFlightExecution,
  eventBus: ExecutionEventBus
): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId: execution.taskId,
      contextId: execution.contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString()
      },
      metadata: undefined
    })
  );
}

function collectCompletedItem(
  execution: InFlightExecution,
  item: Record<string, unknown>
): void {
  if (item.type === "agentMessage" && typeof item.text === "string") {
    const text = item.text.trim();
    if (!text) {
      return;
    }
    if (item.phase === "commentary") {
      execution.lastCommentary = text;
    } else if (
      item.phase === "final_answer" ||
      item.phase === undefined ||
      item.phase === null
    ) {
      execution.finalAnswer = text;
    }
    return;
  }
  if (
    item.type !== "fileChange" ||
    item.status !== "completed" ||
    !Array.isArray(item.changes)
  ) {
    return;
  }
  for (const value of item.changes) {
    const change = asRecord(value);
    if (change && typeof change.path === "string") {
      execution.changedFiles.add(change.path);
    }
  }
}

function createResultArtifact(execution: InFlightExecution): Artifact {
  const files = [...execution.changedFiles].sort();
  const sections = [
    `Codex thread: ${execution.threadId ?? "unknown"}`,
    `Codex turn: ${execution.turnId ?? "unknown"}`,
    `Summary:\n${execution.finalAnswer || "Codex completed without a final answer."}`
  ];
  if (execution.lastCommentary) {
    sections.push(`Last commentary:\n${execution.lastCommentary}`);
  }
  sections.push(
    `Changed files:\n${files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- none reported"}`,
    `Diff:\n${execution.diff || "No unified diff was reported."}`
  );
  return {
    artifactId: `${execution.taskId}-codex-result`,
    name: "Codex code task result",
    description: "Result emitted by the real Codex app-server turn.",
    parts: [
      {
        content: { $case: "text", value: sections.join("\n\n") },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain"
      }
    ],
    metadata: undefined,
    extensions: []
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasMeaningfulResult(execution: InFlightExecution): boolean {
  return (
    execution.finalAnswer.length > 0 ||
    execution.changedFiles.size > 0 ||
    execution.diff.trim().length > 0
  );
}

function createEmptyResultFailure(execution: InFlightExecution): string {
  const failure =
    "Codex turn completed without a final answer or any reported changes.";
  return execution.lastCommentary
    ? `${failure} Last commentary: ${execution.lastCommentary}`
    : failure;
}

function createDeveloperInstructions(expectedBranch: string): string {
  return [
    "Work only in the configured HuanLink workspace.",
    `Stay on branch ${expectedBranch}.`,
    "Do not switch branches, commit, merge, or push.",
    "Make minor implementation or wording choices yourself instead of pausing to ask.",
    "When genuinely blocked by missing user input, use request_user_input.",
    "Make only the requested focused change and report the files and verification run."
  ].join(" ");
}

async function waitForTerminal(
  terminal: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      terminal.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
