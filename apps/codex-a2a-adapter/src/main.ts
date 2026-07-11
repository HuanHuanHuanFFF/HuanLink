import { fileURLToPath } from "node:url";

import { parseHost, parsePort } from "./runtime-config.js";
import { startCodexAdapterRuntime } from "./runtime.js";

const host = parseHost(process.env.HUANLINK_CODEX_A2A_HOST ?? "127.0.0.1");
const port = parsePort(process.env.HUANLINK_CODEX_A2A_PORT ?? "4000");
const workspace =
  process.env.HUANLINK_CODEX_WORKSPACE ??
  fileURLToPath(new URL("../../..", import.meta.url));
const runtime = await startCodexAdapterRuntime({
  codexExecutable:
    process.env.HUANLINK_CODEX_EXECUTABLE ??
    (process.platform === "win32" ? "codex.cmd" : "codex"),
  codexModel: process.env.HUANLINK_CODEX_MODEL ?? "gpt-5.4-mini",
  expectedBranch: "spike/demo-v0",
  expectedCodexVersion:
    process.env.HUANLINK_CODEX_EXPECTED_VERSION ?? "0.144.1",
  host,
  port,
  workspace
});
let shutdownPromise: Promise<void> | undefined;

console.log(`Codex A2A adapter listening at ${runtime.origin}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown();
  });
}

function shutdown(): void {
  if (shutdownPromise) {
    return;
  }

  shutdownPromise = runtime.close();
  void shutdownPromise.then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("Failed to stop Codex A2A adapter", error);
      process.exit(1);
    }
  );
}
