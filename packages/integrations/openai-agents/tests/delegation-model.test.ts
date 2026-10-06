import { expect, test } from "vitest";
import { createDelegationModel } from "../src/delegation-model.js";

test("compaction and permission review use separate tool-free calls with source facts in user input", async () => {
  const observed: Array<{ name: string; tools: number; input: string }> = [];
  const model = createDelegationModel({
    model: "test",
    runner: {
      run: async (agent, input) => {
        observed.push({ name: agent.name, tools: agent.tools.length, input });
        return {
          finalOutput: {
            summary: "task",
            progress: [],
            decisions: [],
            constraints: ["no push"],
            openQuestions: [],
            retainedMessageIds: ["u"],
            authorization: {
              allowed: [],
              denied: [{ scope: "push", evidenceMessageIds: ["u"] }],
              uncertain: [],
            },
            change: "context",
            stop: false,
          },
        };
      },
    },
  });
  const result = await model.compact({
    goal: "task",
    facts: [{ messageId: "u", content: "no push" }],
    authorizedSenderIds: ["owner"],
    evidenceMessageIds: ["u"],
    maxOutputChars: 2000,
  });
  expect(observed).toEqual([
    {
      name: "Delegation compactor",
      tools: 0,
      input: JSON.stringify({
        goal: "task",
        facts: [{ messageId: "u", content: "no push" }],
        authorizedSenderIds: ["owner"],
        evidenceMessageIds: ["u"],
        maxOutputChars: 2000,
      }),
    },
  ]);
  expect(result).toMatchObject({
    authorization: { denied: [{ scope: "push", evidenceMessageIds: ["u"] }] },
  });
});
