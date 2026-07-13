import type { AgentCallBackgroundErrorListener } from "@huanlink/core";
import type { OpenAiAgentsRunner } from "@huanlink/integration-openai-agents";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPhase4QqRuntime,
  type Phase4QqRuntime
} from "../src/index.js";
import {
  AskThenContinuePausedModel,
  AutoContinuePausedModel,
  BlockSendAtIndexChannel,
  ImmediateResumeTransport,
  PauseThenRecoverModel,
  RejectSendAtIndexChannel,
  SESSION_ID,
  TARGET_GROUP,
  deferred,
  message,
  runIds,
  runner,
  waitForSentCount
} from "./support/phase4-egress-test-helpers.js";

const runtimes: Phase4QqRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("Phase 4 QQ session egress ordering", () => {
  test("keeps immediate terminal re-entry behind the paused auto-continuation reply", async () => {
    const channel = new BlockSendAtIndexChannel(1);
    const model = new AutoContinuePausedModel();
    const transport = new ImmediateResumeTransport();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds(
        "run-auto-initial",
        "run-auto-paused",
        "run-auto-terminal"
      )
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("auto-trigger", {
        text: "/huanlink use the Safe option",
        trigger: {
          kind: "command",
          text: "use the Safe option for the original task"
        }
      })
    );
    await waitForSentCount(channel, 1);
    await channel.blockedSendStarted.promise;

    try {
      expect(channel.sendCalls).toHaveLength(2);
      expect(model.requests).toHaveLength(4);
    } finally {
      channel.releaseBlockedSend();
    }
    await waitForSentCount(channel, 3);

    const [record] = runtime.agentCalls.listByRunId("run-auto-initial");
    expect(record).toMatchObject({
      sessionId: SESSION_ID,
      taskId: transport.taskId,
      contextId: transport.contextId,
      state: "completed"
    });
    expect(runtime.agentCalls.listByRunId("run-auto-paused")).toEqual([]);
    expect(transport.submitTask).toHaveBeenCalledTimes(1);
    expect(transport.continueTask).toHaveBeenCalledTimes(1);
    expect(transport.continueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: transport.taskId,
        contextId: transport.contextId,
        answers: { approach: ["Safe"] }
      })
    );
    expect(channel.sent.map(({ text }) => text)).toEqual([
      expect.stringContaining("The task was accepted."),
      "The paused task was automatically continued.",
      "The automatically continued task completed."
    ]);
    expect(JSON.stringify(model.requests[4]?.input)).toContain(
      "HuanLink: The paused task was automatically continued."
    );
  });

  test("keeps immediate terminal re-entry behind the later user-answer reply", async () => {
    const channel = new BlockSendAtIndexChannel(2);
    const model = new AskThenContinuePausedModel();
    const transport = new ImmediateResumeTransport();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds(
        "run-answer-initial",
        "run-answer-paused",
        "run-answer-user",
        "run-answer-terminal"
      )
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("answer-trigger", {
        text: "/huanlink start the task",
        trigger: { kind: "command", text: "start the original task" }
      })
    );
    await waitForSentCount(channel, 2);
    expect(channel.sent[1]?.text).toBe("Which approach should Codex use?");

    await channel.emit(
      message("answer-choice", {
        text: "/huanlink Safe",
        trigger: { kind: "command", text: "Safe" }
      })
    );
    await channel.blockedSendStarted.promise;

    try {
      expect(channel.sendCalls).toHaveLength(3);
      expect(model.requests).toHaveLength(5);
    } finally {
      channel.releaseBlockedSend();
    }
    await waitForSentCount(channel, 4);

    const [record] = runtime.agentCalls.listByRunId("run-answer-initial");
    expect(record).toMatchObject({
      sessionId: SESSION_ID,
      taskId: transport.taskId,
      contextId: transport.contextId,
      state: "completed"
    });
    expect(runtime.agentCalls.listByRunId("run-answer-user")).toEqual([]);
    expect(transport.submitTask).toHaveBeenCalledTimes(1);
    expect(transport.continueTask).toHaveBeenCalledTimes(1);
    expect(transport.continueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: transport.taskId,
        contextId: transport.contextId,
        answers: { approach: ["Safe"] }
      })
    );
    expect(channel.sent.map(({ text }) => text)).toEqual([
      expect.stringContaining("The task was accepted."),
      "Which approach should Codex use?",
      "The user's answer continued the task.",
      "The user-continued task completed."
    ]);
    expect(JSON.stringify(model.requests[5]?.input)).toContain(
      "HuanLink: The user's answer continued the task."
    );
  });

  test("releases the session after a paused re-entry send fails", async () => {
    const channel = new RejectSendAtIndexChannel(1);
    const model = new PauseThenRecoverModel();
    const transport = new ImmediateResumeTransport();
    const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: runner(model),
      createRunId: runIds(
        "run-reentry-send-failure-initial",
        "run-reentry-send-failure-paused",
        "run-after-reentry-send-failure"
      ),
      onBackgroundError
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("reentry-send-failure", {
        trigger: { kind: "command", text: "start a pausing task" }
      })
    );
    await waitForSentCount(channel, 1);
    await vi.waitFor(
      () => expect(onBackgroundError).toHaveBeenCalledOnce(),
      { timeout: 1_000 }
    );

    expect(channel.sendCalls).toHaveLength(2);
    expect(onBackgroundError.mock.calls[0]?.[0].message).toContain(
      "QQ send 1 failed"
    );
    expect(onBackgroundError.mock.calls[0]?.[1]).toMatchObject({
      state: "input-required"
    });
    expect(runtime.conversations.formatLatestContext(SESSION_ID)).not.toContain(
      "This paused re-entry send must fail."
    );

    await channel.emit(
      message("after-reentry-send-failure", {
        trigger: { kind: "command", text: "run after the failed re-entry" }
      })
    );
    await waitForSentCount(channel, 2);

    expect(model.requests).toHaveLength(4);
    expect(channel.sent[1]?.text).toBe("The later user turn succeeded.");
    expect(runtime.conversations.formatLatestContext(SESSION_ID)).toContain(
      "HuanLink: The later user turn succeeded."
    );
    expect(runtime.conversations.formatLatestContext(SESSION_ID)).not.toContain(
      "This paused re-entry send must fail."
    );
  });

  test("aborts a hanging paused re-entry and releases its queued session reservation on close", async () => {
    const channel = new BlockSendAtIndexChannel(-1);
    const model = new PauseThenRecoverModel();
    const initialRunner = runner(model);
    const reentryStarted = deferred<AbortSignal | undefined>();
    const manualRelease = deferred();
    let runnerCalls = 0;
    const hangingRunner: OpenAiAgentsRunner = {
      async run(agent, input, options) {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          return initialRunner.run(agent, input, options);
        }
        reentryStarted.resolve(options?.signal);
        await waitForReleaseOrAbort(manualRelease.promise, options?.signal);
        throw new Error("manually released hanging re-entry");
      }
    };
    const transport = new ImmediateResumeTransport();
    const onBackgroundError = vi.fn<AgentCallBackgroundErrorListener>();
    const runtime = createPhase4QqRuntime({
      channel,
      targetConversationId: TARGET_GROUP,
      codexA2aOrigin: "http://127.0.0.1:1",
      transport,
      runner: hangingRunner,
      createRunId: runIds(
        "run-hanging-close-initial",
        "run-hanging-close-paused",
        "run-hanging-close-queued-user"
      ),
      onBackgroundError
    });
    runtimes.push(runtime);

    await runtime.start();
    await channel.emit(
      message("hanging-close-initial", {
        trigger: { kind: "command", text: "start a pausing task" }
      })
    );
    await waitForSentCount(channel, 1);
    const reentrySignal = await reentryStarted.promise;

    await channel.emit(
      message("hanging-close-queued-user", {
        trigger: { kind: "command", text: "queue behind the re-entry" }
      })
    );
    expect(runnerCalls).toBe(2);

    const closeOperation = runtime.close();
    try {
      await expect(settlesWithin(closeOperation, 1_000)).resolves.toBe(true);
    } finally {
      manualRelease.resolve();
      await Promise.allSettled([closeOperation]);
    }

    expect(reentrySignal?.aborted).toBe(true);
    expect(model.requests).toHaveLength(2);
    expect(channel.sent).toHaveLength(1);
    expect(onBackgroundError).not.toHaveBeenCalled();
  });
});

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function waitForReleaseOrAbort(
  release: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal === undefined) {
    return release;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void release.then(() => {
      cleanup();
      resolve();
    });
  });
}
