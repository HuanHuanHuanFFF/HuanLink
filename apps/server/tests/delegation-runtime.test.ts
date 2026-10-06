import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RunContext } from "@openai/agents";
import { expect, test } from "vitest";
import {
  AGENT_CALL_TASK_KIND_DEFINITION,
  AsyncToolTaskService,
  InMemoryConversationSessionStore,
  InMemoryDelegationStore,
  ConversationSessionStoreToolHistoryRecorder,
  type DelegationModel,
  type ConversationJsonValue,
} from "@huanlink/core";
import { startCodexAdapterRuntime } from "../../codex-a2a-adapter/src/runtime.js";
import { spawnCodexAppServerTransport } from "../../codex-a2a-adapter/src/codex-app-server-client.js";
import { createPhase3HuanLinkRuntime } from "../src/phase3-runtime.js";

test.each([
  { manual: false, ordinary: false },
  { manual: true, ordinary: false },
  { manual: false, ordinary: true },
])(
  "delegation goes through MainAgent, real HTTP and a stdio process (owner confirmation: $manual, ordinary question: $ordinary)",
  async ({ manual, ordinary }) => {
    const workspace = await mkdtemp(join(tmpdir(), "huanlink-delegation-e2e-"));
    await promisify(execFile)("git", ["init", "--initial-branch=experiment"], {
      cwd: workspace,
      windowsHide: true,
    });
    const adapter = await startCodexAdapterRuntime({
      projectRoot: workspace,
      codexExecutable: process.execPath,
      expectedCodexVersion: "0.145.0",
      host: "127.0.0.1",
      port: 0,
      experimentalDelegation: true,
      projects: [
        {
          projectId: "fixture",
          workspace,
          branch: "experiment",
          defaultModelId: "fixture",
          defaultReasoningEffort: "high",
        },
      ],
      spawnTransport: (options) =>
        spawnCodexAppServerTransport({
          ...options,
          args: [
            fileURLToPath(
              new URL(
                "../../codex-a2a-adapter/tests/fixtures/delegation-app-server.mjs",
                import.meta.url,
              ),
            ),
            ...(ordinary ? ["--ordinary-question"] : []),
          ],
        }),
    });
    const sessions = new InMemoryConversationSessionStore();
    const append = (id: string, content: string, self = false) =>
      sessions.appendChannelMessage("s", {
        messageId: id,
        route: {
          channelId: "qq",
          conversationKind: "direct",
          conversationId: "owner",
        },
        sender: {
          id: self ? "bot" : "owner",
          username: self ? "bot" : "owner",
          isSelf: self,
        },
        receivedAt: new Date().toISOString(),
        content,
        contentFormat: "text",
      });
    append("u1", "Run npm test; do not push");
    const store = new InMemoryDelegationStore();
    const tasks = new AsyncToolTaskService({
      maxActiveTasksPerSession: 2,
      taskKinds: [AGENT_CALL_TASK_KIND_DEFINITION],
    });
    let confirmed = false,
      submitted = false,
      taskId = "",
      questions = 0,
      terminal = false;
    const backgroundErrors: string[] = [];
    const compact: DelegationModel["compact"] = async ({ previous }) => ({
      summary: ordinary && confirmed ? "Run unit tests" : "Run npm test",
      progress: [],
      decisions: [],
      constraints: ["do not push"],
      openQuestions: [],
      retainedMessageIds: confirmed ? ["u1", "u2"] : ["u1"],
      authorization: {
        allowed: [
          {
            scope: "run npm test",
            evidenceMessageIds: confirmed ? ["u1", "u2"] : ["u1"],
          },
        ],
        denied: [{ scope: "push", evidenceMessageIds: ["u1"] }],
        uncertain: [],
      },
      change: previous
        ? confirmed && !previous.userEvidence.some((e) => e.messageId === "u2")
          ? "authority"
          : "none"
        : "context",
      stop: false,
    });
    const runtime = createPhase3HuanLinkRuntime({
      onBackgroundError: (error) => {
        backgroundErrors.push(error.message);
      },
      codexA2aOrigin: adapter.origin,
      sessionStore: sessions,
      taskService: tasks,
      historyRecorder: new ConversationSessionStoreToolHistoryRecorder(
        sessions,
      ),
      delegation: {
        model: {
          compact,
          review: async () => ({
            decision: manual && !confirmed ? "ask-user" : "approve",
            evidenceMessageIds: [confirmed ? "u2" : "u1"],
            reason: "fixture decision",
          }),
        },
        store,
        authorizedSenderIds: ["owner"],
      },
      runner: {
        run: async (agent, input, options) => {
          if (options?.context?.trigger === "agent_call_terminal") {
            terminal = true;
            return { finalOutput: "Finished" };
          }
          if (options?.context?.trigger === "agent_call_input_required") {
            questions++;
            append(
              "question-" + questions,
              "请确认当前任务的 npm test 操作 " +
                JSON.stringify(
                  tasks.get("s", taskId)?.payload.permissionRequest,
                ),
              true,
            );
            return { finalOutput: "Please confirm npm test" };
          }
          if (!submitted) {
            submitted = true;
            const tool = agent.tools.find(
              (t) =>
                t.type === "function" && t.name === "submit_codex_agent_call",
            );
            if (!tool || tool.type !== "function")
              throw new Error("submit tool missing");
            const args = JSON.stringify({
              projectId: "fixture",
              task: "Run npm test",
            });
            const result = JSON.parse(
              String(
                await tool.invoke(new RunContext(options!.context), args, {
                  toolCall: {
                    type: "function_call",
                    callId: "submit-1",
                    name: tool.name,
                    arguments: args,
                  },
                }),
              ),
            ) as { taskId: string };
            taskId = result.taskId;
          } else if (ordinary && confirmed) {
            expect(tasks.get("s", taskId)?.payload.questions).toMatchObject([
              { id: "suite" },
            ]);
            const tool = agent.tools.find(
              (t) => t.type === "function" && t.name === "continue_task",
            );
            if (!tool || tool.type !== "function")
              throw new Error("continuation tool missing");
            const args = JSON.stringify({
              taskId,
              answers: [{ questionId: "suite", answers: ["unit"] }],
            });
            const output = JSON.parse(
              String(
                await tool.invoke(new RunContext(options!.context), args, {
                  toolCall: {
                    type: "function_call",
                    callId: "continue-1",
                    name: tool.name,
                    arguments: args,
                  },
                }),
              ),
            );
            expect(output.status).toBe("continued");
          }
          return { finalOutput: "Accepted" };
        },
      },
    });
    try {
      await runtime.runMainAgent({
        sessionId: "s",
        runId: "r1",
        input: "Run npm test",
      });
      if (manual || ordinary) {
        await expect.poll(() => questions).toBe(1);
        confirmed = true;
        append(
          "u2",
          ordinary
            ? "只运行单元测试，仍然禁止推送"
            : "允许当前任务执行这次 npm test；仍然禁止推送",
        );
        await runtime.runMainAgent({
          sessionId: "s",
          runId: "r2",
          input: "Confirmed",
        });
      }
      await expect
        .poll(() => ({
          terminal,
          errors: backgroundErrors,
          state: tasks.getStatus("s", taskId),
        }))
        .toMatchObject({ terminal: true, errors: [] });
      const result = tasks.getStatus("s", taskId);
      expect(result.status).toBe("found");
      if (result.status !== "found") throw new Error("missing result");
      const artifacts = result.payload.artifacts as Array<
        Record<string, ConversationJsonValue>
      >;
      const output = String(artifacts[0]?.text);
      expect(output).toContain(
        '\\\"approvalPolicy\\\":\\\"on-request\\\"'.replaceAll('\\\"', '"'),
      );
      expect(output).toContain('"decision":"accept"');
      expect(output).toContain('"sandbox":"read-only"');
      expect(output).toContain("Run npm test; do not push");
      expect(questions).toBe(manual || ordinary ? 1 : 0);
      if (ordinary) {
        expect(output).toContain("Run unit tests");
        expect(store.list("s")[0]?.syncState).toBe("received");
      }
      expect(store.list("s")[0]?.receivedRevision).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.close();
      await adapter.close();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  20000,
);
