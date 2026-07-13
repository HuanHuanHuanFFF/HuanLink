import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/real/**/*.real.ts"],
    testTimeout: 180_000
  }
});
