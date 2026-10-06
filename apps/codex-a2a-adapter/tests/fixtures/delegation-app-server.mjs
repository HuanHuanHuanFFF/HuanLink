import { createInterface } from "node:readline";
let threadOptions,
  turnId,
  prompt,
  steers = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const askPermission = () =>
  send({
    id: "native-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId,
      itemId: "command",
      startedAtMs: Date.now(),
      environmentId: null,
      command: "npm test",
      cwd: threadOptions.cwd,
      reason: "Run the requested tests",
    },
  });
const complete = (decision) => {
  send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId,
      item: {
        type: "agentMessage",
        id: "final",
        phase: "final_answer",
        text: JSON.stringify({ threadOptions, prompt, steers, decision }),
      },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
  });
};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize")
    send({ id: request.id, result: { userAgent: "codex-cli/0.145.0" } });
  else if (request.method === "model/list")
    send({
      id: request.id,
      result: {
        data: [
          {
            model: "fixture",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
        nextCursor: null,
      },
    });
  else if (request.method === "thread/start") {
    threadOptions = request.params;
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  } else if (request.method === "turn/start") {
    turnId = "turn-1";
    prompt = request.params.input[0].text;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: turnId, status: "inProgress" },
      },
    });
    if (process.argv.includes("--ordinary-question"))
      send({
        id: "ordinary-question",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId,
          itemId: "question",
          autoResolutionMs: null,
          questions: [
            {
              id: "suite",
              header: "Suite",
              question: "Which test suite?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      });
    else askPermission();
  } else if (request.method === "turn/steer") {
    if (request.params.expectedTurnId !== turnId)
      send({ id: request.id, error: { code: -32602, message: "wrong turn" } });
    else {
      steers.push(request.params.input[0].text);
      send({ id: request.id, result: { turnId } });
    }
  } else if (request.id === "ordinary-question" && request.result) {
    askPermission();
  } else if (request.id === "native-approval" && request.result) {
    complete(request.result.decision);
  } else if (request.method === "turn/interrupt") {
    send({ id: request.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: turnId, status: "interrupted" },
      },
    });
  }
}
