import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import type { AgentCallRequest } from "@huanlink/core";

import {
  createDeepSeekMainAgentModelBinding,
  createPhase3MainAgentRuntime
} from "../../src/index.js";

describe("real DeepSeek MainAgent smoke", () => {
  test("uses deepseek-v4-flash to call the existing Codex AgentCall tool", async () => {
    loadRepositoryEnvFile();
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY must be set for the real DeepSeek smoke"
      );
    }

    const modelId =
      process.env.HUANLINK_MAIN_AGENT_MODEL?.trim() || "deepseek-v4-flash";
    const baseURL =
      process.env.HUANLINK_DEEPSEEK_BASE_URL?.trim() ||
      "https://api.deepseek.com/beta";
    const invocations: AgentCallRequest[] = [];
    const invoke = vi.fn(async (request: AgentCallRequest) => {
      invocations.push(request);
      return {
        status: "accepted" as const,
        executionMode: request.executionMode,
        agentCallId: "real-deepseek-agent-call",
        taskId: "real-deepseek-a2a-task",
        state: "submitted" as const
      };
    });
    const getByAgentCallId = vi.fn(() => undefined);
    const getByTaskId = vi.fn(() => undefined);
    const runtime = createPhase3MainAgentRuntime({
      invoker: { invoke },
      taskReader: {
        getByAgentCallId,
        getByTaskId
      },
      taskContinuator: {
        continueTask: vi.fn(async () => {
          throw new Error("Unexpected task continuation in this smoke test");
        })
      },
      modelBinding: createDeepSeekMainAgentModelBinding({
        config: {
          provider: "deepseek",
          modelId,
          baseURL,
          apiKey
        }
      })
    });

    const result = await runtime.run({
      runId: "run-real-deepseek",
      sessionId: "session-real-deepseek",
      trigger: "user",
      input: [
        "Delegate this concrete coding task exactly once with submit_codex_agent_call:",
        "add one focused unit test for a parser.",
        "Use executionMode async, then acknowledge the accepted task."
      ].join(" ")
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getByAgentCallId).not.toHaveBeenCalled();
    expect(getByTaskId).not.toHaveBeenCalled();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      runId: "run-real-deepseek",
      sessionId: "session-real-deepseek",
      contextId: "session-real-deepseek",
      skillId: "codex-code-task",
      executionMode: "async"
    });
    expect(invocations[0]?.input.trim().length).toBeGreaterThan(0);
    expect(result.output.trim().length).toBeGreaterThan(0);

    console.log(
      "DEEPSEEK_MAIN_AGENT_REAL_EVIDENCE",
      JSON.stringify({
        finalTextNonEmpty: true,
        modelId,
        toolCalled: true
      })
    );
  });
});

function loadRepositoryEnvFile(): void {
  const envFilePath = fileURLToPath(
    new URL("../../../../.env", import.meta.url)
  );
  try {
    process.loadEnvFile(envFilePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
