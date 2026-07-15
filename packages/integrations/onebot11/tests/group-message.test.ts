import { describe, expect, it } from "vitest";

import { parseOneBot11GroupMessage } from "../src/index.js";

const options = { commandPrefix: "/huanlink" };

function groupMessage(overrides: Record<string, unknown> = {}) {
  return {
    time: 1_704_067_200,
    self_id: 10_001,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 12_345,
    group_id: 20_002,
    user_id: 30_003,
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
    sender: {
      user_id: 30_003,
      nickname: "Alice",
      card: "Alice Card",
    },
    ...overrides,
  };
}

describe("parseOneBot11GroupMessage", () => {
  it("normalizes a standard numeric-id group message", () => {
    expect(parseOneBot11GroupMessage(groupMessage(), options)).toEqual({
      channel: "onebot11",
      conversationId: "20002",
      messageId: "12345",
      senderId: "30003",
      senderName: "Alice Card",
      text: "hello",
      receivedAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("normalizes string ids and concatenates text segments in order", () => {
    const frame = groupMessage({
      self_id: "10001",
      message_id: "12345",
      group_id: "20002",
      user_id: "30003",
      message: [
        { type: "text", data: { text: "hello " } },
        { type: "image", data: { file: "ignored.jpg" } },
        { type: "text", data: { text: "world" } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)).toMatchObject({
      conversationId: "20002",
      messageId: "12345",
      senderId: "30003",
      text: "hello world",
    });
  });

  it("uses a matching at segment as a mention trigger", () => {
    const frame = groupMessage({
      self_id: "10001",
      message: [
        { type: "at", data: { qq: 10_001 } },
        { type: "text", data: { text: " fix the server " } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)).toMatchObject({
      text: "@<10001> fix the server ",
      trigger: { kind: "mention", text: "fix the server" },
    });
  });

  it("does not trigger for an at segment targeting someone else", () => {
    const frame = groupMessage({
      message: [
        { type: "at", data: { qq: "99999" } },
        { type: "text", data: { text: " hello" } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)).toMatchObject({
      text: "@<99999> hello",
    });
    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toBeUndefined();
  });

  it("recognizes a command after leading whitespace and removes its prefix", () => {
    const frame = groupMessage({
      message: [
        { type: "text", data: { text: "  /huanlink" } },
        { type: "text", data: { text: " inspect logs " } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toEqual({
      kind: "command",
      text: "inspect logs",
    });
  });

  it("recognizes a command consisting only of the complete prefix", () => {
    const frame = groupMessage({
      message: [{ type: "text", data: { text: "/huanlink" } }],
    });

    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toEqual({
      kind: "command",
      text: "",
    });
  });

  it("does not mistake a longer token for the command prefix", () => {
    const frame = groupMessage({
      message: [{ type: "text", data: { text: "/huanlinkevil no" } }],
    });

    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toBeUndefined();
  });

  it("does not assemble a command token across a non-text segment", () => {
    const frame = groupMessage({
      message: [
        { type: "text", data: { text: "/huan" } },
        { type: "image", data: { file: "separator.jpg" } },
        { type: "text", data: { text: "link run" } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)).toMatchObject({
      text: "/huanlink run",
    });
    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toBeUndefined();
  });

  it("prefers mention when mention and command are both present", () => {
    const frame = groupMessage({
      message: [
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: " /huanlink fix this" } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toEqual({
      kind: "mention",
      text: "fix this",
    });
  });

  it("does not strip a command assembled across a non-text segment from a mention", () => {
    const frame = groupMessage({
      message: [
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: "/huan" } },
        { type: "image", data: { file: "separator.jpg" } },
        { type: "text", data: { text: "link run" } },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)?.trigger).toEqual({
      kind: "mention",
      text: "/huanlink run",
    });
  });

  it("returns an ordinary group message without a trigger", () => {
    const parsed = parseOneBot11GroupMessage(groupMessage(), options);

    expect(parsed).toBeDefined();
    expect(parsed?.trigger).toBeUndefined();
  });

  it.each([
    ["messages sent by this bot", { user_id: 10_001 }],
    ["message_sent events", { post_type: "message_sent" }],
    ["private messages", { message_type: "private" }],
    ["meta events", { post_type: "meta_event", meta_event_type: "heartbeat" }],
  ])("ignores %s", (_name, overrides) => {
    expect(
      parseOneBot11GroupMessage(groupMessage(overrides), options),
    ).toBeUndefined();
  });

  it.each([
    ["missing time", { time: undefined }],
    ["invalid time", { time: Number.NaN }],
    ["negative time", { time: -1 }],
    ["missing self id", { self_id: undefined }],
    ["invalid group id", { group_id: {} }],
    ["missing message id", { message_id: undefined }],
    ["invalid message payload", { message: "hello" }],
    ["malformed message segment", { message: [{ type: "text", data: {} }] }],
  ])("ignores a malformed frame with %s", (_name, overrides) => {
    expect(
      parseOneBot11GroupMessage(groupMessage(overrides), options),
    ).toBeUndefined();
  });

  it.each(["self_id", "group_id", "user_id", "message_id"])(
    "ignores an unsafe numeric %s",
    (field) => {
      expect(
        parseOneBot11GroupMessage(
          groupMessage({ [field]: Number.MAX_SAFE_INTEGER + 1 }),
          options,
        ),
      ).toBeUndefined();
    },
  );

  it("ignores an unsafe numeric at target id", () => {
    const frame = groupMessage({
      message: [
        {
          type: "at",
          data: { qq: Number.MAX_SAFE_INTEGER + 1 },
        },
      ],
    });

    expect(parseOneBot11GroupMessage(frame, options)).toBeUndefined();
  });

  it("prefers a non-empty card, then nickname, then user id for sender name", () => {
    expect(
      parseOneBot11GroupMessage(
        groupMessage({ sender: { card: "Team Card", nickname: "Nick" } }),
        options,
      )?.senderName,
    ).toBe("Team Card");

    expect(
      parseOneBot11GroupMessage(
        groupMessage({ sender: { card: "  ", nickname: "Nick" } }),
        options,
      )?.senderName,
    ).toBe("Nick");

    expect(
      parseOneBot11GroupMessage(
        groupMessage({ sender: { card: "", nickname: "" } }),
        options,
      )?.senderName,
    ).toBe("30003");
  });

  it("rejects an empty command prefix", () => {
    expect(() =>
      parseOneBot11GroupMessage(groupMessage(), { commandPrefix: "   " }),
    ).toThrow(/commandPrefix.*non-empty/);
  });
});
