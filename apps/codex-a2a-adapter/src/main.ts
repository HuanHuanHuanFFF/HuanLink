import { parsePort } from "./runtime-config.js";
import { startAdapterServer } from "./server.js";

const host = process.env.HUANLINK_CODEX_A2A_HOST ?? "127.0.0.1";
const port = parsePort(process.env.HUANLINK_CODEX_A2A_PORT ?? "4000");
const server = await startAdapterServer({ host, port });
let shutdownPromise: Promise<void> | undefined;

console.log(`Codex A2A adapter listening at ${server.origin}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown();
  });
}

function shutdown(): void {
  if (shutdownPromise) {
    return;
  }

  shutdownPromise = server.close();
  void shutdownPromise.then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("Failed to stop Codex A2A adapter", error);
      process.exit(1);
    }
  );
}
