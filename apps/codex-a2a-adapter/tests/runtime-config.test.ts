import { describe, expect, it } from "vitest";

import { parseHost, parsePort } from "../src/runtime-config.js";

describe("adapter runtime config", () => {
  it.each(["127.0.0.1", "localhost", "::1"])(
    "parses loopback host %s",
    (value) => {
      expect(parseHost(value)).toBe(value);
    }
  );

  it.each(["", " ", "\t", "0.0.0.0", "127.0.0.2", "example.com", " localhost "])(
    "rejects invalid host %s",
    (value) => {
      expect(() => parseHost(value)).toThrow(
        `Invalid HUANLINK_CODEX_A2A_HOST: ${value}`
      );
    }
  );

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
