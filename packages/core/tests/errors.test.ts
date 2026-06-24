import { describe, expect, test } from "vitest";

import { errorMessage, isNodeError } from "../src/shared/errors.js";

describe("error helpers", () => {
  test("formats Error and non-Error values as readable messages", () => {
    expect(errorMessage(new Error("disk failed"))).toBe("disk failed");
    expect(errorMessage("plain failure")).toBe("plain failure");
    expect(errorMessage(123)).toBe("123");
  });

  test("detects Node-style errors with a code", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });

    expect(isNodeError(error)).toBe(true);
    expect(isNodeError(new Error("plain"))).toBe(false);
    expect(isNodeError("plain")).toBe(false);
  });
});
