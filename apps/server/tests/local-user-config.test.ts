import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { loadServerLocalUserConfig } from "../src/local-user-config.js";

const API_KEY = "main-agent-secret";
const ACCESS_TOKEN = "onebot-access-token";
let tempRoot: string;
let escapeRoot: string;
let previousApiKey: string | undefined;
let previousAccessToken: string | undefined;

function restoreEnvironmentValue(
  name: "DEEPSEEK_API_KEY" | "HUANLINK_ONEBOT_ACCESS_TOKEN",
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(async () => {
  previousApiKey = process.env.DEEPSEEK_API_KEY;
  previousAccessToken = process.env.HUANLINK_ONEBOT_ACCESS_TOKEN;
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huanlink-local-config-"));
  escapeRoot = await mkdtemp(path.join(os.tmpdir(), "huanlink-local-config-escape-"));
  process.env.DEEPSEEK_API_KEY = API_KEY;
  process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = ACCESS_TOKEN;
});

afterEach(async () => {
  restoreEnvironmentValue("DEEPSEEK_API_KEY", previousApiKey);
  restoreEnvironmentValue("HUANLINK_ONEBOT_ACCESS_TOKEN", previousAccessToken);
  await rm(tempRoot, { recursive: true, force: true });
  await rm(escapeRoot, { recursive: true, force: true });
});

describe("test environment isolation", () => {
  const preexistingApiKey = "preexisting-main-agent-secret";
  const preexistingAccessToken = "preexisting-onebot-access-token";
  let originalApiKey: string | undefined;
  let originalAccessToken: string | undefined;

  beforeAll(() => {
    originalApiKey = process.env.DEEPSEEK_API_KEY;
    originalAccessToken = process.env.HUANLINK_ONEBOT_ACCESS_TOKEN;
    process.env.DEEPSEEK_API_KEY = preexistingApiKey;
    process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = preexistingAccessToken;
  });

  afterAll(() => {
    try {
      expect({
        apiKey: process.env.DEEPSEEK_API_KEY,
        accessToken: process.env.HUANLINK_ONEBOT_ACCESS_TOKEN
      }).toEqual({
        apiKey: preexistingApiKey,
        accessToken: preexistingAccessToken
      });
    } finally {
      restoreEnvironmentValue("DEEPSEEK_API_KEY", originalApiKey);
      restoreEnvironmentValue("HUANLINK_ONEBOT_ACCESS_TOKEN", originalAccessToken);
    }
  });

  test("uses isolated credentials without discarding preexisting values", () => {
    expect(process.env.DEEPSEEK_API_KEY).toBe(API_KEY);
    expect(process.env.HUANLINK_ONEBOT_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
  });
});

describe("loadServerLocalUserConfig", () => {
  test("loads only the Server-owned files in deterministic name order and resolves secret references", async () => {
    await writeValidServerConfig(tempRoot, {
      channels: [
        ["z-second.json", { ...oneBotChannel, channelId: "qq-second" }],
        ["a-first.json", { ...oneBotChannel, channelId: "qq-first" }]
      ],
      agents: [
        ["z-second.json", { ...a2aAgent, agentId: "agent-second" }],
        ["a-first.json", { ...a2aAgent, agentId: "agent-first" }]
      ]
    });

    await writeJson(
      path.join(tempRoot, "codex-adapter", "runtime.json"),
      { version: 1, workspace: "must-not-be-read" }
    );

    await mkdir(path.join(tempRoot, "server", "channels", "nested"));
    await writeJson(
      path.join(tempRoot, "server", "channels", "nested", "ignored.json"),
      { invalid: true }
    );
    await writeFile(
      path.join(tempRoot, "server", "channels", "ignored.txt"),
      "not JSON",
      "utf8"
    );

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot })
    ).resolves.toEqual({
      mainAgent: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/beta",
        apiKey: API_KEY
      },
      channels: [
        {
          channelId: "qq-first",
          type: "onebot11-forward-websocket",
          url: "ws://127.0.0.1:3001/",
          groupId: "20002000",
          commandPrefix: "/huanlink",
          accessToken: ACCESS_TOKEN
        },
        {
          channelId: "qq-second",
          type: "onebot11-forward-websocket",
          url: "ws://127.0.0.1:3001/",
          groupId: "20002000",
          commandPrefix: "/huanlink",
          accessToken: ACCESS_TOKEN
        }
      ],
      agents: [
        {
          agentId: "agent-first",
          displayName: "Codex Local",
          transport: "a2a",
          origin: "http://127.0.0.1:4000",
          skillId: "codex-code-task",
          enabled: true
        },
        {
          agentId: "agent-second",
          displayName: "Codex Local",
          transport: "a2a",
          origin: "http://127.0.0.1:4000",
          skillId: "codex-code-task",
          enabled: true
        }
      ]
    });
  });

  test("uses cwd/.huanlink/config by default", async () => {
    const originalCwd = process.cwd();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "huanlink-local-config-cwd-"));
    await writeValidServerConfig(path.join(cwd, ".huanlink", "config"));
    process.chdir(cwd);

    try {
      await expect(loadServerLocalUserConfig()).resolves.toMatchObject({
        mainAgent: { apiKey: API_KEY },
        channels: [{ channelId: "qq-main" }],
        agents: [{ agentId: "codex-local" }]
      });
    } finally {
      process.chdir(originalCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects a .huanlink directory junction on the default path", async (context) => {
    await writeValidServerConfig(path.join(escapeRoot, "config"));
    const huanlinkPath = path.join(tempRoot, ".huanlink");

    if (!(await createLinkOrSkip(context, escapeRoot, huanlinkPath, "junction"))) {
      return;
    }

    const originalCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      await expect(loadServerLocalUserConfig()).rejects.toThrow(/\.huanlink/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test.each([
    ["server/main-agent.json", { ...mainAgent, version: 2 }, "version"],
    ["server/main-agent.json", { ...mainAgent, unexpected: true }, "unexpected"],
    ["server/channels/onebot11.json", { ...oneBotChannel, channelId: "bad id" }, "channelId"],
    ["server/channels/onebot11.json", { ...oneBotChannel, url: "http://127.0.0.1:3001" }, "url"],
    ["server/agents/codex-local.json", { ...a2aAgent, origin: "https://example.test" }, "origin"]
  ])("rejects invalid %s without leaking configuration contents", async (file, value, field) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, file), value);

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(`${escapeRegExp(file)}.*${field}`)
    );
  });

  test.each([
    ["channels", "channelId", "qq-main"],
    ["agents", "agentId", "codex-local"]
  ])("rejects duplicate stable %s", async (directory, field, id) => {
    await writeValidServerConfig(tempRoot);
    const fixture = directory === "channels" ? oneBotChannel : a2aAgent;
    await writeJson(
      path.join(tempRoot, "server", directory, "z-duplicate.json"),
      fixture
    );

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(`${directory}/z-duplicate\\.json.*${field}.*${id}`)
    );
  });

  test.each([
    ["server/main-agent.json"],
    ["server/channels"],
    ["server/agents"]
  ])("requires %s", async (relativePath) => {
    await writeValidServerConfig(tempRoot);
    await rm(path.join(tempRoot, relativePath), { recursive: true, force: true });

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(escapeRegExp(relativePath))
    );
  });

  test("requires referenced environment values and never includes the secret in errors", async () => {
    await writeValidServerConfig(tempRoot);
    const secret = "secret-that-must-not-leak";
    process.env.DEEPSEEK_API_KEY = "   ";
    process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = secret;

    let thrown: unknown;
    try {
      await loadServerLocalUserConfig({ configRoot: tempRoot });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("server/main-agent.json");
    expect((thrown as Error).message).toContain("apiKeyEnv");
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).not.toContain(API_KEY);
  });

  test.each([
    ["server/main-agent.json", "{ invalid JSON"],
    ["server/main-agent.json", "[]"]
  ])("rejects damaged or non-object JSON in %s", async (relativePath, content) => {
    await writeValidServerConfig(tempRoot);
    await writeFile(path.join(tempRoot, relativePath), content, "utf8");

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(escapeRegExp(relativePath))
    );
  });

  test("rejects invalid UTF-8 even when replacement decoding would leave valid JSON", async () => {
    await writeValidServerConfig(tempRoot);
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"version":1,"provider":"deepseek","modelId":"'),
      Buffer.from([0x80]),
      Buffer.from('","baseURL":"https://api.deepseek.com/beta","apiKeyEnv":"DEEPSEEK_API_KEY"}')
    ]);
    await writeFile(
      path.join(tempRoot, "server", "main-agent.json"),
      invalidUtf8
    );

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      /server\/main-agent\.json.*UTF-8/
    );
  });

  test.each(["channels", "agents"])("rejects an empty %s directory", async (directory) => {
    await writeValidServerConfig(tempRoot);
    const directoryPath = path.join(tempRoot, "server", directory);
    await rm(directoryPath, { recursive: true, force: true });
    await mkdir(directoryPath, { recursive: true });

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(`server/${directory}`)
    );
  });

  test.each([
    ["server/main-agent.json", { ...mainAgent, apiKeyEnv: "BAD-NAME" }, "apiKeyEnv"],
    [
      "server/channels/onebot11.json",
      { ...oneBotChannel, accessTokenEnv: "BAD-NAME" },
      "accessTokenEnv"
    ]
  ])("rejects invalid environment variable names in %s", async (relativePath, value, field) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, relativePath), value);

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      new RegExp(`${escapeRegExp(relativePath)}.*${field}`)
    );
  });

  test("rejects a declared OneBot token that is missing or blank without leaking another secret", async () => {
    await writeValidServerConfig(tempRoot);
    const unrelatedSecret = "unrelated-secret-that-must-not-leak";
    process.env.HUANLINK_ONEBOT_ACCESS_TOKEN = "   ";
    process.env.DEEPSEEK_API_KEY = unrelatedSecret;

    let thrown: unknown;
    try {
      await loadServerLocalUserConfig({ configRoot: tempRoot });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("server/channels/onebot11.json");
    expect((thrown as Error).message).toContain("accessTokenEnv");
    expect((thrown as Error).message).not.toContain(unrelatedSecret);
  });

  test("uses an injected environment instead of process environment", async () => {
    await writeValidServerConfig(tempRoot);

    await expect(
      loadServerLocalUserConfig({
        configRoot: tempRoot,
        env: {
          DEEPSEEK_API_KEY: "injected-main-agent-key",
          HUANLINK_ONEBOT_ACCESS_TOKEN: "injected-onebot-token"
        }
      })
    ).resolves.toMatchObject({
      mainAgent: { apiKey: "injected-main-agent-key" },
      channels: [{ accessToken: "injected-onebot-token" }]
    });
  });

  test.each([
    "http://127.0.0.1:4100",
    "https://localhost:4100",
    "http://[::1]:4100"
  ])("accepts loopback A2A origin %s", async (origin) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, "server", "agents", "codex-local.json"), {
      ...a2aAgent,
      origin
    });

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).resolves.toMatchObject({
      agents: [{ origin }]
    });
  });

  test("does not echo an unknown raw secret field or its JSON content", async () => {
    await writeValidServerConfig(tempRoot);
    const rawSecret = "raw-secret-that-must-not-leak";
    await writeJson(path.join(tempRoot, "server", "main-agent.json"), {
      ...mainAgent,
      rawSecret
    });

    let thrown: unknown;
    try {
      await loadServerLocalUserConfig({ configRoot: tempRoot });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("server/main-agent.json");
    expect((thrown as Error).message).toContain("rawSecret");
    expect((thrown as Error).message).not.toContain(rawSecret);
    expect((thrown as Error).message).not.toContain('"rawSecret"');
  });

  test("preserves leading and trailing whitespace in a resolved secret", async () => {
    await writeValidServerConfig(tempRoot);
    const secretWithWhitespace = "  main-agent-secret\t";
    process.env.DEEPSEEK_API_KEY = secretWithWhitespace;

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).resolves.toMatchObject({
      mainAgent: { apiKey: secretWithWhitespace }
    });
  });

  test("rejects a symbolic-link fixed main-agent file", async (context) => {
    await writeValidServerConfig(tempRoot);
    const mainAgentPath = path.join(tempRoot, "server", "main-agent.json");
    const externalMainAgentPath = path.join(escapeRoot, "main-agent.json");
    await writeJson(externalMainAgentPath, mainAgent);
    await rm(mainAgentPath);

    if (!(await createLinkOrSkip(context, externalMainAgentPath, mainAgentPath, "file"))) {
      return;
    }

    await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
      /server\/main-agent\.json/
    );
  });

  test("rejects a directory junction used as configRoot", async (context) => {
    await writeValidServerConfig(escapeRoot);
    const linkedConfigRoot = path.join(tempRoot, "linked-config-root");

    if (!(await createLinkOrSkip(context, escapeRoot, linkedConfigRoot, "junction"))) {
      return;
    }

    await expect(
      loadServerLocalUserConfig({ configRoot: linkedConfigRoot })
    ).rejects.toThrow(/configuration root/);
  });

  test("rejects a directory junction at server", async (context) => {
    await expectDirectoryJunctionRejection(context, "server", "server");
  });

  test("rejects a directory junction at server/channels", async (context) => {
    await expectDirectoryJunctionRejection(context, "server/channels", "channels");
  });

  test("rejects a directory junction at server/agents", async (context) => {
    await expectDirectoryJunctionRejection(context, "server/agents", "agents");
  });
});

const mainAgent = {
  version: 1,
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com/beta",
  apiKeyEnv: "DEEPSEEK_API_KEY"
};

const oneBotChannel = {
  version: 1,
  channelId: "qq-main",
  type: "onebot11-forward-websocket",
  url: "ws://127.0.0.1:3001/",
  groupId: "20002000",
  commandPrefix: "/huanlink",
  accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN"
};

const a2aAgent = {
  version: 1,
  agentId: "codex-local",
  displayName: "Codex Local",
  transport: "a2a",
  origin: "http://127.0.0.1:4000",
  skillId: "codex-code-task",
  enabled: true
};

async function writeValidServerConfig(
  root: string,
  input: {
    channels?: Array<[string, object]>;
    agents?: Array<[string, object]>;
  } = {}
): Promise<void> {
  await writeJson(path.join(root, "server", "main-agent.json"), mainAgent);
  for (const [name, value] of input.channels ?? [["onebot11.json", oneBotChannel]]) {
    await writeJson(path.join(root, "server", "channels", name), value);
  }
  for (const [name, value] of input.agents ?? [["codex-local.json", a2aAgent]]) {
    await writeJson(path.join(root, "server", "agents", name), value);
  }
}

async function writeJson(filePath: string, value: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createLinkOrSkip(
  context: { skip: () => void },
  target: string,
  linkPath: string,
  type: "file" | "junction"
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS")
    ) {
      context.skip();
      return false;
    }
    throw error;
  }
}

async function expectDirectoryJunctionRejection(
  context: { skip: () => void },
  relativePath: "server" | "server/channels" | "server/agents",
  targetDirectoryName: "server" | "channels" | "agents"
): Promise<void> {
  await writeValidServerConfig(tempRoot);
  const linkPath = path.join(tempRoot, ...relativePath.split("/"));
  const targetDirectory = path.join(escapeRoot, targetDirectoryName);

  if (relativePath === "server") {
    await writeValidServerConfig(escapeRoot);
  } else if (relativePath === "server/channels") {
    await writeJson(path.join(targetDirectory, "onebot11.json"), oneBotChannel);
  } else {
    await writeJson(path.join(targetDirectory, "codex-local.json"), a2aAgent);
  }

  await rm(linkPath, { recursive: true, force: true });
  if (!(await createLinkOrSkip(context, targetDirectory, linkPath, "junction"))) {
    return;
  }

  await expect(loadServerLocalUserConfig({ configRoot: tempRoot })).rejects.toThrow(
    new RegExp(escapeRegExp(relativePath))
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
