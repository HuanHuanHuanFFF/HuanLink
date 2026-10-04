import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@huanlink/core": path.resolve(
        rootDir,
        "../../packages/core/src/index.ts",
      ),
      "@huanlink/integration-a2a-client": path.resolve(
        rootDir,
        "../../packages/integrations/a2a-client/src/index.ts",
      ),
    },
  },
});
