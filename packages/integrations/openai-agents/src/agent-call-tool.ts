import {
  TASK_EXECUTION_MODES,
  type AgentCallArtifact,
  type AgentCallInputQuestion,
  type AgentCallInvocationResult,
  type AgentCallInvoker,
  type AgentCallRequest,
  type RuntimeLogger,
  type SessionToolHistoryRecorder,
} from "@huanlink/core";
import { tool } from "@openai/agents";
import { z } from "zod";

import { combineAbortSignals } from "./abort-signals.js";
import {
  bestEffortRuntimeLogger,
  safeRuntimeErrorType,
} from "./best-effort-runtime-logger.js";
import type { OpenAiAgentsRunContext } from "./openai-agents-runtime.js";
import { withSessionToolHistory } from "./session-tool-history-tool.js";

export const SUBMIT_CODEX_AGENT_CALL_TOOL_NAME =
  "submit_codex_agent_call" as const;

const parameters = z.object({
  task: z
    .string()
    .trim()
    .min(1)
    .describe("The concrete coding task that Codex should perform."),
  executionMode: z
    .enum(TASK_EXECUTION_MODES)
    .optional()
    .describe(
      "Use async unless the user explicitly asks to block until completion.",
    ),
});

export type CreateCodexAgentCallToolOptions = {
  invoker: AgentCallInvoker;
  logger?: RuntimeLogger;
  skillId?: string;
  historyRecorder?: SessionToolHistoryRecorder;
};

export function createCodexAgentCallTool(
  options: CreateCodexAgentCallToolOptions,
) {
  const logger = bestEffortRuntimeLogger(options.logger);
  const skillId = options.skillId ?? "codex-code-task";

  const functionTool = tool<typeof parameters, OpenAiAgentsRunContext>({
    name: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
    description:
      "Submit a coding task to the remote Codex agent. Async mode returns an accepted task ID; blocking mode returns the observed task outcome. Terminal re-entry follow-ups always run asynchronously.",
    parameters,
    isEnabled: ({ runContext }) =>
      runContext.context.trigger === "user" ||
      runContext.context.trigger === "agent_call_terminal",
    execute: async ({ task, executionMode = "async" }, runContext, details) => {
      if (!runContext) {
        throw new Error("Codex AgentCall tool requires a HuanLink RunContext");
      }

      const effectiveExecutionMode =
        runContext.context.trigger === "agent_call_terminal"
          ? "async"
          : executionMode;

      const toolLogger = logger.child({
        runId: runContext.context.runId,
        sessionId: runContext.context.sessionId,
        toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
      });
      const inputFields = {
        executionMode: effectiveExecutionMode,
        inputLength: task.length,
      };
      toolLogger.info("main_agent.tool.started", inputFields);

      const signal = combineAbortSignals(
        runContext.context.signal,
        details?.signal,
      );

      try {
        const sourceToolCallId = details?.toolCall?.callId;
        const baseRequest = {
          runId: runContext.context.runId,
          sessionId: runContext.context.sessionId,
          contextId: runContext.context.sessionId,
          skillId,
          toolName: SUBMIT_CODEX_AGENT_CALL_TOOL_NAME,
          input: task,
          ...(signal === undefined ? {} : { signal }),
        };
        let request: AgentCallRequest;
        if (effectiveExecutionMode === "async") {
          if (sourceToolCallId === undefined) {
            throw new Error("Async AgentCall requires the SDK Tool Call ID");
          }
          request = {
            ...baseRequest,
            executionMode: "async",
            sourceToolCallId,
          };
        } else {
          if (sourceToolCallId === undefined) {
            throw new Error("Blocking AgentCall requires the SDK Tool Call ID");
          }
          request = {
            ...baseRequest,
            executionMode: "blocking",
            sourceToolCallId,
          };
        }
        const result = publicAgentCallResult(
          await options.invoker.invoke(request),
        );
        toolLogger.info(
          "main_agent.tool.completed",
          result.status === "accepted"
            ? {
                status: result.status,
                taskId: result.taskId,
                state: result.state,
              }
            : result.status === "error"
              ? {
                  status: result.status,
                  error: result.error,
                  ...(result.error === "task-limit-reached"
                    ? {
                        maxActiveTasksPerSession:
                          result.maxActiveTasksPerSession,
                      }
                    : result.error === "remote-task-conflict"
                      ? { retrySafe: false }
                      : {}),
                }
              : {
                  status: result.status,
                  executionMode: result.executionMode,
                  state: result.state,
                },
        );
        return JSON.stringify(result);
      } catch (error) {
        toolLogger.error("main_agent.tool.failed", {
          ...inputFields,
          errorType: safeRuntimeErrorType(error),
        });
        throw error;
      }
    },
  });
  return withSessionToolHistory(
    functionTool,
    options.historyRecorder,
    logger,
    (rawArguments) => parameters.parse(JSON.parse(rawArguments)),
  );
}

function publicAgentCallResult(
  result: AgentCallInvocationResult,
): AgentCallInvocationResult {
  if (result.status === "accepted") {
    return {
      status: "accepted",
      taskId: result.taskId,
      state: result.state,
    };
  }
  if (result.status === "error") {
    if (result.error === "task-limit-reached") {
      return {
        status: "error",
        error: "task-limit-reached",
        maxActiveTasksPerSession: result.maxActiveTasksPerSession,
      };
    }
    if (result.error === "remote-task-conflict") {
      return {
        status: "error",
        error: "remote-task-conflict",
        retrySafe: false,
      };
    }
    return {
      status: "error",
      error: "task-preaccept-rejected",
    };
  }
  if (result.status === "result") {
    return {
      status: "result",
      executionMode: "blocking",
      state: result.state,
      artifacts: result.artifacts.map(publicArtifact),
      ...(result.statusMessage === undefined
        ? {}
        : { statusMessage: result.statusMessage }),
    };
  }
  if (result.status === "blocking-uncertain") {
    return {
      status: "blocking-uncertain",
      executionMode: "blocking",
      taskId: result.taskId,
      state: "unknown",
      retrySafe: false,
    };
  }
  return {
    status: "blocking-interrupted",
    executionMode: "blocking",
    state: result.state,
    ...(result.questions === undefined
      ? {}
      : { questions: result.questions.map(publicQuestion) }),
    ...(result.statusMessage === undefined
      ? {}
      : { statusMessage: result.statusMessage }),
  };
}

function publicArtifact(artifact: AgentCallArtifact): AgentCallArtifact {
  return {
    id: artifact.id,
    ...(artifact.name === undefined ? {} : { name: artifact.name }),
    ...(artifact.description === undefined
      ? {}
      : { description: artifact.description }),
    ...(artifact.text === undefined ? {} : { text: artifact.text }),
  };
}

function publicQuestion(
  question: AgentCallInputQuestion,
): AgentCallInputQuestion {
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    isOther: question.isOther,
    isSecret: question.isSecret,
    options:
      question.options === null
        ? null
        : question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
  };
}
