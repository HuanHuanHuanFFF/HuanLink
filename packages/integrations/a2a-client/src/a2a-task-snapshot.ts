import {
  TaskState,
  type Artifact,
  type Message,
  type Task
} from "@a2a-js/sdk";
import {
  type AgentCallArtifact,
  type AgentCallInputQuestion,
  type AgentCallTaskSnapshot,
  type AgentCallTaskState
} from "@huanlink/core";

export function snapshotFromTask(task: Task): AgentCallTaskSnapshot {
  return {
    taskId: task.id,
    contextId: task.contextId,
    state: stateFromTaskState(task.status?.state),
    artifacts: task.artifacts.map(artifactFromA2a),
    ...messageFields(task.status?.message)
  };
}

function artifactFromA2a(artifact: Artifact): AgentCallArtifact {
  const text = artifact.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");

  return {
    id: artifact.artifactId,
    ...(artifact.name === "" ? {} : { name: artifact.name }),
    ...(artifact.description === ""
      ? {}
      : { description: artifact.description }),
    ...(text === "" ? {} : { text })
  };
}

export function messageFields(
  message: Message | undefined
): Pick<AgentCallTaskSnapshot, "statusMessage" | "questions"> {
  if (!message) {
    return {};
  }
  const text = message.parts
    .flatMap((part) =>
      part.content?.$case === "text" ? [part.content.value] : []
    )
    .join("\n");
  const questions = message.parts.flatMap((part) =>
    part.content?.$case === "data"
      ? questionsFromData(part.content.value)
      : []
  );
  return {
    ...(text === "" ? {} : { statusMessage: text }),
    ...(questions.length === 0 ? {} : { questions })
  };
}

function questionsFromData(value: unknown): AgentCallInputQuestion[] {
  const data = asRecord(value);
  if (!data || !Array.isArray(data.questions)) {
    return [];
  }
  const questions = data.questions.map(questionFromData);
  return questions.some((question) => question === undefined)
    ? []
    : (questions as AgentCallInputQuestion[]);
}

function questionFromData(value: unknown): AgentCallInputQuestion | undefined {
  const question = asRecord(value);
  if (
    !question ||
    typeof question.id !== "string" ||
    typeof question.header !== "string" ||
    typeof question.question !== "string"
  ) {
    return undefined;
  }
  if (
    question.options !== undefined &&
    question.options !== null &&
    !Array.isArray(question.options)
  ) {
    return undefined;
  }
  const options =
    question.options === undefined || question.options === null
      ? null
      : question.options.map(optionFromData);
  if (options?.some((option) => option === undefined)) {
    return undefined;
  }
  return {
    header: question.header,
    id: question.id,
    isOther: question.isOther === true,
    isSecret: question.isSecret === true,
    options: options as AgentCallInputQuestion["options"],
    question: question.question
  };
}

function optionFromData(
  value: unknown
): NonNullable<AgentCallInputQuestion["options"]>[number] | undefined {
  const option = asRecord(value);
  return option &&
    typeof option.label === "string" &&
    typeof option.description === "string"
    ? { label: option.label, description: option.description }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stateFromTaskState(
  state: TaskState | undefined
): AgentCallTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    default:
      return "unknown";
  }
}

export function isTerminal(state: AgentCallTaskState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected"
  );
}

export function isPaused(state: AgentCallTaskState): boolean {
  return state === "input-required" || state === "auth-required";
}
