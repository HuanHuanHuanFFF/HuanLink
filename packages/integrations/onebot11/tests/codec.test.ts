import { describe, expect, test } from "vitest";

import {
  createOneBot11SendGroupTextAction,
  parseOneBot11JsonFrame,
} from "../src/codec.js";

describe("OneBot11Codec", () => {
  test("parses a JSON object frame without Channel or WebSocket dependencies", () => {
    expect(parseOneBot11JsonFrame('{"post_type":"message"}')).toEqual({
      post_type: "message",
    });
  });

  test.each(["not-json", "[]", "null"])(
    "rejects an invalid object frame %s",
    (raw) => {
      expect(() => parseOneBot11JsonFrame(raw)).toThrow(/JSON|object/i);
    },
  );

  test("creates the standard numeric send_group_msg action", () => {
    expect(
      createOneBot11SendGroupTextAction("20002", "hello", "send-group:1"),
    ).toEqual({
      action: "send_group_msg",
      params: {
        group_id: 20002,
        message: [{ type: "text", data: { text: "hello" } }],
      },
      echo: "send-group:1",
    });
  });

  test.each(["0", "01", "1.5", "9007199254740992", "not-a-group"])(
    "rejects an unsafe outgoing group ID %s",
    (groupId) => {
      expect(() =>
        createOneBot11SendGroupTextAction(groupId, "hello", "send-group:1"),
      ).toThrow(/safe positive integer/i);
    },
  );
});
