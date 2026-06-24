import { describe, expect, test } from "vitest";

import { SimpleLruMap } from "../src/shared/simple-lru-map.js";

describe("SimpleLruMap", () => {
  test("evicts the least recently used entry when max size is exceeded", () => {
    const cache = new SimpleLruMap<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  test("rejects invalid max sizes", () => {
    expect(() => new SimpleLruMap<string, number>(0)).toThrow(
      /maxSize must be a positive integer/
    );
    expect(() => new SimpleLruMap<string, number>(1.5)).toThrow(
      /maxSize must be a positive integer/
    );
  });
});
