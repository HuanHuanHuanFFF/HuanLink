import { createInterface } from "node:readline";

const threads = new Map();
let nextTurn = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({
      userAgent: "codex-cli/0.145.0",
      codexHome: "fixture",
      platformFamily: "fixture",
      platformOs: "fixture",
    });
  else if (request.method === "model/list")
    reply({
      data: [
        {
          model: "fixture-model",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "low" },
          ],
        },
        {
          model: "override-model",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
      nextCursor: null,
    });
  else if (request.method === "thread/start") {
    const id = `thread-${threads.size + 1}`;
    threads.set(id, request.params);
    reply({ thread: { id } });
  } else if (request.method === "turn/start") {
    const turnId = `turn-${++nextTurn}`;
    const { threadId, model, effort } = request.params;
    reply({ turn: { id: turnId } });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: `answer-${turnId}`,
          phase: "final_answer",
          text: JSON.stringify({
            cwd: threads.get(threadId).cwd,
            threadId,
            model,
            effort,
          }),
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", items: [] },
      },
    });
  }
}
