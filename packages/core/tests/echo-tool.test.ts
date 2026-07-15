// 验证 echoTool 在不同参数形态下返回可断言的工具结果。
import { describe, expect, test } from "vitest";

import { echoTool } from "../src/tools/echo-tool.js";
import type { ToolCall } from "../src/tools/types.js";

describe("echoTool", () => {
  test("returns the text argument verbatim when it is a string", () => {
    const toolCall: ToolCall = {
      id: "call_echo_text_01",
      name: "echo",
      args: { text: "hello echo" }
    };

    expect(echoTool.execute(toolCall)).toEqual({
      callId: "call_echo_text_01",
      toolName: "echo",
      output: "hello echo"
    });
  });

  test("falls back to a JSON dump when text is missing", () => {
    const toolCall: ToolCall = {
      id: "call_echo_json_01",
      name: "echo",
      args: { value: 42, nested: { ok: true } }
    };

    expect(echoTool.execute(toolCall)).toEqual({
      callId: "call_echo_json_01",
      toolName: "echo",
      output: JSON.stringify({ value: 42, nested: { ok: true } })
    });
  });

  test("falls back to a JSON dump when text is a non-string value", () => {
    const toolCall: ToolCall = {
      id: "call_echo_nonstring_01",
      name: "echo",
      args: { text: 123 }
    };

    expect(echoTool.execute(toolCall)).toEqual({
      callId: "call_echo_nonstring_01",
      toolName: "echo",
      output: JSON.stringify({ text: 123 })
    });
  });

  test("exposes the tool name expected by the gateway", () => {
    expect(echoTool.name).toBe("echo");
  });
});
