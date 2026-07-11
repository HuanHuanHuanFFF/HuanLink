import { describe, expect, it } from "vitest";

import { parsePort } from "../src/runtime-config.js";

describe("adapter runtime config", () => {
  it.each([
    ["0", 0],
    ["4000", 4000],
    ["65535", 65_535]
  ])("parses port %s", (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });

  it.each(["", "-1", "1.5", "4000abc", "65536"])(
    "rejects invalid port %s",
    (value) => {
      expect(() => parsePort(value)).toThrow(
        `Invalid HUANLINK_CODEX_A2A_PORT: ${value}`
      );
    }
  );
});
