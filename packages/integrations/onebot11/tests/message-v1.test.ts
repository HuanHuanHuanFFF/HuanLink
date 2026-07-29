import { describe, expect, test } from "vitest";

import {
  CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1
} from "@huanlink/core";

import { parseOneBot11MessageV1 } from "../src/index.js";

const options = {
  channelId: "qq-main",
  commandPrefix: "/huanlink"
};

describe("parseOneBot11MessageV1", () => {
  test("maps a group message array to the V1 route, sender, CQ content, reply, and trigger", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: 10_001,
        post_type: "message",
        message_type: "group",
        message_id: 12_345,
        group_id: 20_002,
        user_id: 30_003,
        message: [
          { type: "reply", data: { id: 99 } },
          { type: "text", data: { text: "/huanlink inspect " } },
          {
            type: "image",
            data: {
              file: "fixture.jpg",
              url: "https://example.invalid/a.jpg?x=1&y=2"
            }
          }
        ],
        sender: {
          nickname: "Alice",
          card: "Alice Card"
        }
      },
      options
    );

    expect(message).toEqual({
      messageId: "12345",
      route: {
        channelId: "qq-main",
        conversationKind: "group",
        conversationId: "20002"
      },
      sender: {
        id: "30003",
        username: "Alice",
        displayName: "Alice Card",
        isSelf: false
      },
      receivedAt: "2024-01-01T00:00:00.000Z",
      content:
        "[CQ:reply,id=99]/huanlink inspect [CQ:image,file=fixture.jpg,url=https://example.invalid/a.jpg?x=1&amp;y=2]",
      contentFormat: "onebot11.cq",
      replyToMessageId: "99",
      trigger: { kind: "command" }
    });
  });

  test("keeps a self-sent private CQ string unchanged and marks its sender", () => {
    const content =
      "sent [CQ:image,url=https://example.invalid/a.gif,key=fixture-key]";
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message_sent",
        message_type: "private",
        message_id: "12346",
        user_id: "10001",
        target_id: "40004",
        message: content,
        sender: { nickname: "HuanLink" }
      },
      options
    );

    expect(message).toMatchObject({
      messageId: "12346",
      route: {
        channelId: "qq-main",
        conversationKind: "direct",
        conversationId: "40004"
      },
      sender: {
        id: "10001",
        username: "HuanLink",
        isSelf: true
      },
      content,
      contentFormat: "onebot11.cq"
    });
  });

  test("replaces normalized CQ content above 8 KiB with session metadata only", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12347",
        group_id: "20002",
        user_id: "30003",
        message: [{ type: "text", data: { text: "x".repeat(8193) } }],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message).toMatchObject({
      content: CHANNEL_INBOUND_CONTENT_TOO_LARGE_PLACEHOLDER_V1,
      contentOmitted: {
        reason: "too_large",
        originalSizeBytes: 8193
      }
    });
  });

  test("preserves an incoming private CQ string and isolates it by peer id", () => {
    const content =
      "[CQ:reply,id=77][CQ:at,qq=10001] hello [CQ:future,key=fixture]";
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "private",
        message_id: "12348",
        user_id: "40004",
        message: content,
        sender: { nickname: "Bob" }
      },
      options
    );

    expect(message).toMatchObject({
      route: {
        channelId: "qq-main",
        conversationKind: "direct",
        conversationId: "40004"
      },
      sender: {
        id: "40004",
        username: "Bob",
        isSelf: false
      },
      content,
      replyToMessageId: "77",
      trigger: { kind: "mention" }
    });
  });

  test("does not assemble a command prefix across a non-text message segment", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12349",
        group_id: "20002",
        user_id: "30003",
        message: [
          { type: "text", data: { text: "/huan" } },
          { type: "image", data: { file: "separator.jpg" } },
          { type: "text", data: { text: "link run" } }
        ],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message?.content).toBe(
      "/huan[CQ:image,file=separator.jpg]link run"
    );
    expect(message?.trigger).toBeUndefined();
  });

  test("recognizes a command after mentioning the current bot", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12351",
        group_id: "20002",
        user_id: "30003",
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: " /huanlink inspect" } }
        ],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message?.trigger).toEqual({ kind: "command" });
  });

  test("keeps command priority when the command also mentions the current bot", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12352",
        group_id: "20002",
        user_id: "30003",
        message: [
          { type: "text", data: { text: "/huanlink inspect " } },
          { type: "at", data: { qq: "10001" } }
        ],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message?.trigger).toEqual({ kind: "command" });
  });

  test("does not recognize a command after mentioning another user", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12353",
        group_id: "20002",
        user_id: "30003",
        message: [
          { type: "at", data: { qq: "40004" } },
          { type: "text", data: { text: " /huanlink inspect" } }
        ],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message?.trigger).toBeUndefined();
  });

  test("keeps a parameterless message segment whose OneBot data is null", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12350",
        group_id: "20002",
        user_id: "30003",
        message: [
          { type: "text", data: { text: "before" } },
          { type: "shake", data: null },
          { type: "text", data: { text: "after" } }
        ],
        sender: { nickname: "Alice" }
      },
      options
    );

    expect(message?.content).toBe("before[CQ:shake]after");
  });

  test("falls back to the sender id without inventing a display name", () => {
    const message = parseOneBot11MessageV1(
      {
        time: 1_704_067_200,
        self_id: "10001",
        post_type: "message",
        message_type: "group",
        message_id: "12350",
        group_id: "20002",
        user_id: "30003",
        message: " ",
        sender: { nickname: " ", card: " " }
      },
      options
    );

    expect(message?.sender).toEqual({
      id: "30003",
      username: "30003",
      isSelf: false
    });
    expect(message?.content).toBe(" ");
  });
});
