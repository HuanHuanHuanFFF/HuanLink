import { describe, expect, test } from "vitest";

import { resolveChannelTriggerV1 } from "../src/index.js";

describe("resolveChannelTriggerV1", () => {
  test.each([
    "/model",
    "/model gpt-5",
    "   /模型 qwen",
    "/agent-status",
    "/unknown",
  ])("recognizes a leading slash command: %s", (leadingText) => {
    expect(
      resolveChannelTriggerV1({
        mentionedSelf: false,
        leadingText,
      }),
    ).toEqual({ kind: "command" });
  });

  test("gives a valid command priority over a self mention", () => {
    expect(
      resolveChannelTriggerV1({
        mentionedSelf: true,
        leadingText: "  /model gpt-5",
      }),
    ).toEqual({ kind: "command" });
  });

  test.each(["/", "/ model", "hello /model", "/model/other"])(
    "falls back to mention when a self mention has no valid command: %s",
    (leadingText) => {
      expect(
        resolveChannelTriggerV1({
          mentionedSelf: true,
          leadingText,
        }),
      ).toEqual({ kind: "mention" });
    },
  );

  test("returns mention when the platform supplied no leading text", () => {
    expect(
      resolveChannelTriggerV1({
        mentionedSelf: true,
      }),
    ).toEqual({ kind: "mention" });
  });

  test.each([undefined, "", "   ", "/", "/ model", "hello /model"])(
    "does not trigger without a mention or valid command: %s",
    (leadingText) => {
      expect(
        resolveChannelTriggerV1({
          mentionedSelf: false,
          ...(leadingText === undefined ? {} : { leadingText }),
        }),
      ).toBeUndefined();
    },
  );
});
