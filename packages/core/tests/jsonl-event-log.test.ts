import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CORE_SCHEMA_VERSION,
  JsonlEventLog,
  getDefaultRuntimeConfig,
  resolveRuntimeConfig
} from "../src/index.js";
import type {
  AgentEvent,
  AgentEventDraft,
  RunId,
  SessionId
} from "../src/index.js";

let tempRoot: string;
let baseDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huanlink-jsonl-event-log-"));
  baseDir = path.join(tempRoot, ".huanlink");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("JsonlEventLog", () => {
  test("appends outer event envelopes and reads one run in append order", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";

    const first = await eventLog.append(createDraft(runA, sessionId));
    const otherRun = await eventLog.append(createDraft(runB, sessionId));
    const second = await eventLog.append({
      type: "main_agent.run.completed",
      runId: runA,
      sessionId,
      data: { output: "done" }
    });

    expect(await eventLog.readRunEvents(runA)).toEqual([first, second]);
    expect(await eventLog.readRunEvents(runB)).toEqual([otherRun]);
    expect(first).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      seq: 1,
      type: "main_agent.run.started",
      runId: runA,
      sessionId
    });
    expect(Object.keys(first).sort()).toEqual([
      "data",
      "id",
      "runId",
      "schemaVersion",
      "seq",
      "sessionId",
      "timestamp",
      "type"
    ]);
    expect(second.seq).toBe(2);
    expect(otherRun.seq).toBe(1);

    const eventFiles = await findEventsFiles(baseDir);
    expect(eventFiles).toHaveLength(2);
    const runAFile = await findFileContaining(eventFiles, '"runId":"run_a"');
    expect((await readJsonLines(runAFile)).map((line) => JSON.parse(line))).toEqual([
      first,
      second
    ]);
  });

  test("queues concurrent appends for the same run in call order", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runId = "run_concurrent";
    const sessionId = "session_concurrent";

    const completed = await Promise.all([
      eventLog.append(createDraft(runId, sessionId)),
      eventLog.append({
        type: "agent_call.created",
        runId,
        sessionId,
        data: {
          agentCallId: "agent_call_01",
          taskId: "task_01",
          skillId: "coding",
          executionMode: "async",
          state: "submitted"
        }
      }),
      eventLog.append({
        type: "main_agent.run.completed",
        runId,
        sessionId,
        data: { output: "done" }
      })
    ]);

    expect(completed.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await eventLog.readRunEvents(runId)).map((event) => event.seq)).toEqual([
      1,
      2,
      3
    ]);
  });

  test("continues seq after a new instance opens an existing run file", async () => {
    const runId = "run_restart";
    const sessionId = "session_restart";
    const firstEventLog = new JsonlEventLog({ baseDir });
    await firstEventLog.append(createDraft(runId, sessionId));
    await firstEventLog.append({
      type: "agent_call.state.changed",
      runId,
      sessionId,
      data: {
        agentCallId: "agent_call_restart",
        taskId: "task_restart",
        state: "working"
      }
    });

    const restartedEventLog = new JsonlEventLog({ baseDir });
    const completed = await restartedEventLog.append({
      type: "main_agent.run.completed",
      runId,
      sessionId,
      data: { output: "after restart" }
    });

    expect(completed.seq).toBe(3);
    expect(
      (await restartedEventLog.readRunEvents(runId)).map((event) => event.seq)
    ).toEqual([1, 2, 3]);
  });

  test("stops at the maximum safe seq without corrupting the run file", async () => {
    const runId = "run_seq_limit";
    const sessionId = "session_seq_limit";
    const seedingEventLog = new JsonlEventLog({ baseDir });
    await replaceRunFile(
      seedingEventLog,
      runId,
      sessionId,
      JSON.stringify({
        ...validRawEvent(runId, Number.MAX_SAFE_INTEGER - 1),
        sessionId
      })
    );

    const eventLog = new JsonlEventLog({ baseDir });
    const lastEvent = await eventLog.append(createDraft(runId, sessionId));

    expect(lastEvent.seq).toBe(Number.MAX_SAFE_INTEGER);
    await expect(eventLog.append(createDraft(runId, sessionId))).rejects.toThrow(
      new RegExp(
        `^Failed to append JSONL EventLog event for run "${runId}": ` +
          `Cannot allocate JSONL EventLog seq: maximum safe integer ` +
          `${Number.MAX_SAFE_INTEGER} has been reached$`
      )
    );

    const [eventFile] = await findEventsFiles(baseDir);
    const storedSeqs = (await readJsonLines(eventFile)).map(
      (line) => (JSON.parse(line) as AgentEvent).seq
    );

    expect(storedSeqs).toEqual([
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER
    ]);
    expect(storedSeqs.every((seq) => Number.isSafeInteger(seq))).toBe(true);
    expect(new Set(storedSeqs).size).toBe(storedSeqs.length);
  });

  test("returns an empty array when the run file does not exist", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    expect(await eventLog.readRunEvents("missing_run")).toEqual([]);
  });

  test("uses runtimeConfig.eventLog defaults when constructor fields are omitted", async () => {
    const defaults = getDefaultRuntimeConfig();
    const configuredBaseDir = path.join(tempRoot, "runtime-config-events");
    const runtimeConfig = resolveRuntimeConfig({
      eventLog: { baseDir: configuredBaseDir, nextSeqCacheSize: 3 }
    });
    const eventLog = new JsonlEventLog({ runtimeConfig });

    await eventLog.append(createDraft("run_runtime_config", "session_runtime_config"));

    expect(await findEventsFiles(configuredBaseDir)).toHaveLength(1);
    expect(runtimeConfig.eventLog.nextSeqCacheSize).not.toBe(
      defaults.eventLog.nextSeqCacheSize
    );
  });

  test("skips blank lines while reading", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const event = await eventLog.append(
      createDraft("run_blank_lines", "session_blank_lines")
    );
    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, "\n  \n", "utf8");

    expect(await eventLog.readRunEvents("run_blank_lines")).toEqual([event]);
  });

  test("throws a clear error when a JSONL line is invalid", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    await replaceRunFile(eventLog, "run_bad_json", "session_bad_json", "{bad json}");

    await expect(eventLog.readRunEvents("run_bad_json")).rejects.toThrow(
      /Failed to parse JSONL EventLog line 1 for run "run_bad_json"/
    );
  });

  test.each([
    ["schema 1.0", { ...validRawEvent("run_invalid"), schemaVersion: "1.0" }],
    [
      "an invalid timestamp",
      { ...validRawEvent("run_invalid"), timestamp: "not-a-timestamp" }
    ],
    [
      "an unsafe seq",
      {
        ...validRawEvent("run_invalid"),
        seq: Number.MAX_SAFE_INTEGER + 1
      }
    ],
    ["tool.requested", { ...validRawEvent("run_invalid"), type: "tool.requested" }],
    ["policy.decided", { ...validRawEvent("run_invalid"), type: "policy.decided" }],
    [
      "missing main_agent.run.completed output",
      {
        ...validRawEvent("run_invalid"),
        type: "main_agent.run.completed",
        data: {}
      }
    ],
    [
      "an invalid main_agent.run.started cause",
      {
        ...validRawEvent("run_invalid"),
        data: {
          trigger: "agent_call_terminal",
          cause: {
            agentCallId: "agent_call_invalid",
            taskId: "task_invalid",
            state: "queued"
          }
        }
      }
    ],
    [
      "missing main_agent.run.failed error",
      {
        ...validRawEvent("run_invalid"),
        type: "main_agent.run.failed",
        data: {}
      }
    ],
    [
      "missing main_agent.run.cancelled reason",
      {
        ...validRawEvent("run_invalid"),
        type: "main_agent.run.cancelled",
        data: {}
      }
    ],
    [
      "an invalid agent_call.created executionMode",
      {
        ...validRawEvent("run_invalid"),
        type: "agent_call.created",
        data: {
          agentCallId: "agent_call_invalid",
          taskId: "task_invalid",
          skillId: "coding",
          executionMode: "parallel",
          state: "submitted"
        }
      }
    ],
    [
      "an invalid agent_call.created state",
      {
        ...validRawEvent("run_invalid"),
        type: "agent_call.created",
        data: {
          agentCallId: "agent_call_invalid",
          taskId: "task_invalid",
          skillId: "coding",
          executionMode: "async",
          state: "queued"
        }
      }
    ],
    [
      "an invalid agent_call.state.changed state",
      {
        ...validRawEvent("run_invalid"),
        type: "agent_call.state.changed",
        data: {
          agentCallId: "agent_call_invalid",
          taskId: "task_invalid",
          state: "queued"
        }
      }
    ],
    [
      "an invalid channel.message.received trigger",
      {
        ...validRawEvent("run_invalid"),
        type: "channel.message.received",
        data: {
          channel: "onebot11",
          conversationId: "group_invalid",
          messageId: "message_invalid",
          senderId: "user_invalid",
          senderName: "Invalid User",
          text: "hello",
          trigger: { kind: "ambient", text: "hello" }
        }
      }
    ],
    [
      "missing channel.reply.sent text",
      {
        ...validRawEvent("run_invalid"),
        type: "channel.reply.sent",
        data: { conversationId: "group_invalid" }
      }
    ],
    [
      "missing channel.reply.failed error",
      {
        ...validRawEvent("run_invalid"),
        type: "channel.reply.failed",
        data: {
          conversationId: "group_invalid",
          text: "reply"
        }
      }
    ],
    [
      "legacy envelope fields",
      {
        ...validRawEvent("run_invalid"),
        source: "agent_loop",
        step: 0,
        toolCallId: "tool_01",
        parentEventId: "event_00"
      }
    ]
  ])("rejects %s JSONL events", async (_label, invalidEvent) => {
    const eventLog = new JsonlEventLog({ baseDir });
    await replaceRunFile(
      eventLog,
      "run_invalid",
      "session_invalid",
      JSON.stringify(invalidEvent)
    );

    await expect(eventLog.readRunEvents("run_invalid")).rejects.toThrow(
      /Invalid JSONL EventLog event envelope on line 1 for run "run_invalid"/
    );
  });

  test("filters out events in a run file that belong to another run", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runEvent = await eventLog.append(createDraft("run_current", "session_current"));
    const [eventFile] = await findEventsFiles(baseDir);
    const strayEvent = validRawEvent("run_stray", 99);
    await appendFile(eventFile, `${JSON.stringify(strayEvent)}\n`, "utf8");

    expect(await eventLog.readRunEvents("run_current")).toEqual([runEvent]);
  });

  test("keeps path-like run ids inside the configured base directory", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runId = "../escape\\..\\run";
    const event = await eventLog.append(createDraft(runId, "session_path_guard"));

    expect(await eventLog.readRunEvents(runId)).toEqual([event]);
    const [eventFile] = await findEventsFiles(baseDir);
    const relativePath = path.relative(path.resolve(baseDir), eventFile);
    expect(relativePath.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relativePath)).toBe(false);
    expect(path.basename(path.dirname(eventFile))).not.toContain("..");
    expect(await exists(path.join(tempRoot, "escape"))).toBe(false);
  });

  test("throws a clear error when appending fails", async () => {
    const fileBaseDir = path.join(tempRoot, "not-a-directory");
    await writeFile(fileBaseDir, "blocks directory creation", "utf8");
    const eventLog = new JsonlEventLog({ baseDir: fileBaseDir });

    await expect(
      eventLog.append(createDraft("run_write_failure", "session_write_failure"))
    ).rejects.toThrow(
      /Failed to append JSONL EventLog event for run "run_write_failure"/
    );
  });
});

function createDraft(runId: RunId, sessionId: SessionId): AgentEventDraft {
  return {
    type: "main_agent.run.started",
    runId,
    sessionId,
    data: { trigger: "user" }
  };
}

function validRawEvent(runId: RunId, seq = 1): AgentEvent {
  return {
    schemaVersion: "2.0",
    id: `event_${seq}`,
    seq,
    timestamp: "2026-07-15T00:00:00.000Z",
    type: "main_agent.run.started",
    runId,
    sessionId: "session_invalid",
    data: { trigger: "user" }
  };
}

async function replaceRunFile(
  eventLog: JsonlEventLog,
  runId: RunId,
  sessionId: SessionId,
  content: string
): Promise<void> {
  await eventLog.append(createDraft(runId, sessionId));
  const [eventFile] = await findEventsFiles(baseDir);
  await writeFile(eventFile, `${content}\n`, "utf8");
}

async function readJsonLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter((line) => line.length > 0);
}

async function findFileContaining(
  filePaths: string[],
  expectedContent: string
): Promise<string> {
  for (const filePath of filePaths) {
    if ((await readFile(filePath, "utf8")).includes(expectedContent)) {
      return filePath;
    }
  }
  throw new Error(`No events file contained ${expectedContent}`);
}

async function findEventsFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findEventsFiles(entryPath)));
    } else if (entry.isFile() && entry.name === "events.jsonl") {
      files.push(entryPath);
    }
  }
  return files;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
