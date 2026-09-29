import type { FunctionTool, RunContext } from "@openai/agents";
import type {
  ConversationJsonValue,
  RuntimeLogger,
  SessionToolHistoryRecorder,
} from "@huanlink/core";

type HistoryJson = ConversationJsonValue;

type SessionToolHistoryContext = {
  readonly runId: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
};

export type SessionToolHistoryArgumentParser = (
  rawArguments: string,
) => Readonly<Record<string, HistoryJson>>;

const HISTORY_WARNING = "Tool result history was not persisted.";

/**
 * Adds best-effort Session history around the SDK's public FunctionTool invoke
 * boundary. The SDK-generated Call ID is mandatory: callers must not replace
 * it with a locally generated identifier.
 */
export function withSessionToolHistory<
  Context extends SessionToolHistoryContext,
  Result,
>(
  functionTool: FunctionTool<Context, any, Result>,
  recorder: SessionToolHistoryRecorder | undefined,
  logger?: RuntimeLogger,
  parseArguments?: SessionToolHistoryArgumentParser,
): FunctionTool<Context, any, Result> {
  if (recorder === undefined) {
    return functionTool;
  }

  const invoke = functionTool.invoke;
  return {
    ...functionTool,
    invoke: async (
      runContext: RunContext<Context>,
      rawArguments: string,
      details,
    ) => {
      const toolCallId = details?.toolCall?.callId;
      if (!isNonBlankString(toolCallId)) {
        throw new Error("Tool history requires the SDK Tool Call ID");
      }
      const historyBase = {
        runId: runContext.context.runId,
        toolCallId,
        toolName: functionTool.name,
      };
      try {
        recorder.recordToolCall(runContext.context.sessionId, {
          ...historyBase,
          ...historyArguments(rawArguments, parseArguments),
        });
      } catch (error) {
        logHistoryWriteFailure(
          logger,
          runContext.context.sessionId,
          historyBase,
          "call",
          error,
        );
        throw new Error("Tool history Call recording failed");
      }

      try {
        const result = await invoke(runContext, rawArguments, details);
        const output = toHistoryJson(result, { outcome: "returned" });
        try {
          recorder.recordToolResult(runContext.context.sessionId, {
            ...historyBase,
            output,
          });
          return result;
        } catch (error) {
          logHistoryWriteFailure(
            logger,
            runContext.context.sessionId,
            historyBase,
            "result",
            error,
          );
          return appendHistoryWarning(result) as Result;
        }
      } catch (error) {
        const output: HistoryJson = {
          outcome: isCanceled(details?.signal, runContext.context.signal)
            ? "canceled"
            : "thrown",
          errorType: errorType(error),
        };
        try {
          recorder.recordToolResult(runContext.context.sessionId, {
            ...historyBase,
            output,
          });
        } catch (recordError) {
          logHistoryWriteFailure(
            logger,
            runContext.context.sessionId,
            historyBase,
            "result",
            recordError,
          );
          // Preserve the original Tool failure. It is more truthful than a
          // history-write error and contains no recorder details in logs.
        }
        throw error;
      }
    },
  };
}

function historyArguments(
  rawArguments: string,
  parseArguments: SessionToolHistoryArgumentParser | undefined,
):
  | { readonly arguments: Readonly<Record<string, HistoryJson>> }
  | { readonly rawArguments: string } {
  try {
    const parsed: unknown =
      parseArguments === undefined
        ? JSON.parse(rawArguments)
        : parseArguments(rawArguments);
    return isHistoryRecord(parsed) ? { arguments: parsed } : { rawArguments };
  } catch {
    return { rawArguments };
  }
}

function isHistoryRecord(
  value: unknown,
): value is Readonly<Record<string, HistoryJson>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isHistoryJson(value)
  );
}

function isHistoryJson(value: unknown): value is HistoryJson {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function toHistoryJson(value: unknown, fallback: HistoryJson): HistoryJson {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isHistoryJson(parsed)) {
        return JSON.parse(JSON.stringify(parsed)) as HistoryJson;
      }
    } catch {
      // Opaque text is already a valid JSON string value.
    }
  }
  if (!isHistoryJson(value)) {
    return fallback;
  }
  return JSON.parse(JSON.stringify(value)) as HistoryJson;
}

function appendHistoryWarning(value: unknown): unknown {
  if (isHistoryRecord(value)) {
    return { ...value, historyWarning: HISTORY_WARNING };
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isHistoryRecord(parsed)) {
        return JSON.stringify({ ...parsed, historyWarning: HISTORY_WARNING });
      }
    } catch {
      // Keep the opaque result below; it remains model-visible and recoverable.
    }
  }
  return {
    result: toHistoryJson(value, null),
    historyWarning: HISTORY_WARNING,
  };
}

function isCanceled(
  detailsSignal: AbortSignal | undefined,
  runSignal: AbortSignal | undefined,
): boolean {
  return detailsSignal?.aborted === true || runSignal?.aborted === true;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function logHistoryWriteFailure(
  logger: RuntimeLogger | undefined,
  sessionId: string,
  historyBase: {
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
  },
  historyStage: "call" | "result",
  error: unknown,
): void {
  try {
    logger
      ?.child({
        runId: historyBase.runId,
        sessionId,
        toolCallId: historyBase.toolCallId,
        toolName: historyBase.toolName,
      })
      .error("main_agent.tool.history.write_failed", {
        historyStage,
        errorType: errorType(error),
      });
  } catch {
    // History diagnostic logging must not affect the Tool outcome.
  }
}
