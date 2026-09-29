import {
  projectConversationSessionContext,
  type ConversationAgentToolCallEntry,
  type ConversationAgentToolCallLocation,
  type ConversationJsonValue,
  type ConversationSessionContextWindow,
  type AsyncToolTaskStatus,
} from "@huanlink/core";

/**
 * Builds the model-visible Session context for one Task re-entry.
 *
 * The source Call is appended only when it fell before the current Window.
 * An appended copy omits its lookup IDs; a source Call already present in the
 * Window keeps the projector's original structure so Call/Result pairs remain
 * intact.
 */
export function buildTaskReentrySessionContext(
  window: ConversationSessionContextWindow,
  sourceToolCall: ConversationAgentToolCallLocation,
): string {
  const projected = projectConversationSessionContext(window);
  const sourceIsInWindow =
    window.summary === undefined ||
    sourceToolCall.entryIndex > window.summary.throughEntryIndex;

  if (sourceIsInWindow) {
    return projected;
  }
  const context = JSON.parse(projected) as ConversationJsonValue;
  if (
    context === null ||
    Array.isArray(context) ||
    typeof context !== "object"
  ) {
    throw new Error("Projected Session context must be a JSON object");
  }
  return JSON.stringify({
    ...context,
    sourceToolCall: projectSourceToolCall(sourceToolCall.entry),
  });
}

function projectSourceToolCall(
  sourceToolCall: ConversationAgentToolCallEntry,
): ConversationJsonValue {
  return {
    type: "source_tool_call",
    toolName: sourceToolCall.toolName,
    ...(sourceToolCall.rawArguments === undefined
      ? { arguments: sourceToolCall.arguments }
      : { rawArguments: sourceToolCall.rawArguments }),
  };
}

export function buildAsyncToolTaskReentryInput(
  task: AsyncToolTaskStatus,
  latestContext: string,
): string {
  return [
    "A previously accepted asynchronous Tool Task reached a terminal state.",
    "Task result:",
    JSON.stringify(task),
    "Latest conversation context at completion:",
    latestContext || "(none)",
    "Respond with a concise result for the user.",
    "If the latest conversation context contains an explicit, unambiguous follow-up that the user already authorized and no confirmation is required, submit that next task asynchronously in this same session.",
    "Never repeat the completed task or invent a follow-up; a task already accepted or completed in the supplied result or context is not pending and must not be submitted again.",
    "Include the completed result and any newly accepted HuanLink task ID in the response. If an authorized follow-up needs a material choice, ask the user instead.",
  ].join("\n");
}

export function buildAsyncToolTaskInputRequiredReentryInput(
  task: AsyncToolTaskStatus,
  latestContext: string,
): string {
  const continuationInstruction =
    task.kind === "agent-call"
      ? "If the available conversation context already supplies complete answers to every pending question, call continue_task for this same HuanLink task."
      : "If the available conversation context already supplies complete answers to every pending question, use only this Task kind's enabled continuation Tool; otherwise ask the user.";
  return [
    "A previously accepted asynchronous Tool Task requires user input before it can continue.",
    "Paused Task result:",
    JSON.stringify(task),
    "Latest conversation context:",
    latestContext || "(none)",
    "Use get_task_status if the current state needs confirmation.",
    continuationInstruction,
    "If a material choice is missing or ambiguous, ask the user a concise question and wait for their answer.",
    "Never submit a replacement task for this paused Task.",
  ].join("\n");
}
