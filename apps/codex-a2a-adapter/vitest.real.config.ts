import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ["tests/real/**/*.real.ts"],
    testTimeout: 900_000
  }
});
