import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          userAgent: "codex-cli/0.142.5",
          codexHome: "C:/Users/demo/.codex",
          platformFamily: "windows",
          platformOs: "windows"
        }
      })}\n`
    );
  }
}
