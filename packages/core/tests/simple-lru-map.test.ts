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

  test("removes a single entry with delete", () => {
    const cache = new SimpleLruMap<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);

    cache.delete("a");

    expect(cache.has("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("b")).toBe(true);
    expect(cache.size).toBe(1);
  });

  test("delete on a missing key leaves the cache unchanged", () => {
    const cache = new SimpleLruMap<string, number>(2);

    cache.set("a", 1);
    cache.delete("missing");

    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
  });

  test("clear removes every entry", () => {
    const cache = new SimpleLruMap<string, number>(3);

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(false);
  });

  test("refreshes recency on get so a re-read entry survives eviction", () => {
    const cache = new SimpleLruMap<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);
    // Touch "a" so "b" becomes the least recently used entry.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("overwriting an existing key updates its value without growing", () => {
    const cache = new SimpleLruMap<string, number>(2);

    cache.set("a", 1);
    cache.set("a", 42);

    expect(cache.get("a")).toBe(42);
    expect(cache.size).toBe(1);
  });
});
