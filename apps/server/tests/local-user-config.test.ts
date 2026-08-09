import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  loadServerChannelRuntimeConfig,
  loadServerLocalUserConfig,
  loadHuanLinkServerStaticConfig,
} from "../src/local-user-config.js";

const API_KEY = "main-agent-secret";
const ACCESS_TOKEN = "onebot-access-token";
let tempRoot: string;
let escapeRoot: string;
let previousApiKey: string | undefined;
let previousAccessToken: string | undefined;

function restoreEnvironmentValue(
  name: "DEEPSEEK_API_KEY" | "HUANLINK_ONEBOT_ACCESS_TOKEN",
  value: string | undefined,
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
  escapeRoot = await mkdtemp(
    path.join(os.tmpdir(), "huanlink-local-config-escape-"),
  );
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
        accessToken: process.env.HUANLINK_ONEBOT_ACCESS_TOKEN,
      }).toEqual({
        apiKey: preexistingApiKey,
        accessToken: preexistingAccessToken,
      });
    } finally {
      restoreEnvironmentValue("DEEPSEEK_API_KEY", originalApiKey);
      restoreEnvironmentValue(
        "HUANLINK_ONEBOT_ACCESS_TOKEN",
        originalAccessToken,
      );
    }
  });

  test("uses isolated credentials without discarding preexisting values", () => {
    expect(process.env.DEEPSEEK_API_KEY).toBe(API_KEY);
    expect(process.env.HUANLINK_ONEBOT_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
  });
});

describe("loadServerLocalUserConfig", () => {
  test("loads the repository's single tracked configuration tree", async () => {
    const configRoot = fileURLToPath(
      new URL("../../../.huanlink/config/", import.meta.url),
    );

    await expect(
      loadServerLocalUserConfig({
        configRoot,
        env: {
          DEEPSEEK_API_KEY: API_KEY,
          HUANLINK_ONEBOT_ACCESS_TOKEN: ACCESS_TOKEN,
        },
      }),
    ).resolves.toMatchObject({
      mainAgent: { provider: "deepseek" },
      channels: [{ channelId: "qq-main" }],
      agents: [{ agentId: "codex-local" }],
    });
  });

  test("loads the Channel runtime without resolving an unused MainAgent API key", async () => {
    const configRoot = fileURLToPath(
      new URL("../../../.huanlink/config/", import.meta.url),
    );

    const config = await loadServerChannelRuntimeConfig({
      configRoot,
      env: { HUANLINK_ONEBOT_ACCESS_TOKEN: ACCESS_TOKEN },
    });

    expect(config).toMatchObject({
      mainAgent: {
        provider: "deepseek",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      channels: [{ channelId: "qq-main", accessToken: ACCESS_TOKEN }],
      agents: [{ agentId: "codex-local" }],
      sources: {
        mainAgent: "server/main-agent.json",
        channels: ["server/channels/onebot11.json"],
        agents: ["server/agents/codex-local.json"],
      },
    });
    expect(config.mainAgent).not.toHaveProperty("apiKey");
  });

  test("loads the Runtime static configuration through the sole orchestration reference without resolving the MainAgent API key", async () => {
    const configRoot = fileURLToPath(
      new URL("../../../.huanlink/config/", import.meta.url),
    );

    const config = await loadHuanLinkServerStaticConfig({
      configRoot,
      env: {},
    });

    expect(config).toMatchObject({
      mainAgent: {
        provider: "deepseek",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      agents: [{ agentId: "codex-local", transport: "a2a", enabled: true }],
      orchestration: {
        defaultAgentId: "codex-local",
        agentCallPolicy: { maxActiveTasksPerSession: 2 },
      },
      sources: {
        orchestration: "server/orchestration.json",
      },
    });
    expect(config.mainAgent).not.toHaveProperty("apiKey");
    expect(config.channels[0]).not.toHaveProperty("accessToken");
  });

  test.each([
    [
      "a missing MainAgent reference",
      async () => {
        await writeJson(path.join(tempRoot, "config.json"), {
          version: 1,
          server: {
            orchestration: "./server/orchestration.json",
            channels: ["./server/channels/onebot11.json"],
            agents: ["./server/agents/codex-local.json"],
          },
        });
      },
      /config\.json.*mainAgent/,
    ],
    [
      "a missing orchestration reference",
      async () => {
        await writeJson(path.join(tempRoot, "config.json"), {
          version: 1,
          server: {
            mainAgent: "./server/main-agent.json",
            channels: ["./server/channels/onebot11.json"],
            agents: ["./server/agents/codex-local.json"],
          },
        });
      },
      /config\.json.*orchestration/,
    ],
    [
      "a default Agent that does not exist",
      async () => {
        await writeJson(path.join(tempRoot, "server", "orchestration.json"), {
          ...orchestration,
          defaultAgentId: "missing-agent",
        });
      },
      /server\/orchestration\.json.*defaultAgentId/,
    ],
    [
      "a disabled default Agent",
      async () => {
        await writeJson(
          path.join(tempRoot, "server", "agents", "codex-local.json"),
          {
            ...a2aAgent,
            enabled: false,
          },
        );
      },
      /server\/orchestration\.json.*defaultAgentId/,
    ],
    [
      "a non-A2A default Agent",
      async () => {
        await writeJson(
          path.join(tempRoot, "server", "agents", "codex-local.json"),
          {
            ...a2aAgent,
            transport: "manual",
          },
        );
      },
      /server\/agents\/codex-local\.json.*transport/,
    ],
  ])(
    "rejects Runtime static configuration with %s",
    async (_name, change, expected) => {
      await writeValidServerConfig(tempRoot);
      await change();

      await expect(
        loadHuanLinkServerStaticConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(expected);
    },
  );

  test.each([
    [
      "an invalid MainAgent apiKeyEnv name",
      "server/main-agent.json",
      { ...mainAgent, apiKeyEnv: "BAD-NAME" },
      /apiKeyEnv/,
    ],
    [
      "an invalid Agent origin",
      "server/agents/codex-local.json",
      { ...a2aAgent, origin: "https://a2a.example.test" },
      /origin/,
    ],
    [
      "an empty Agent skillId",
      "server/agents/codex-local.json",
      { ...a2aAgent, skillId: "   " },
      /skillId/,
    ],
    [
      "an Agent apiKeyEnv field",
      "server/agents/codex-local.json",
      { ...a2aAgent, apiKeyEnv: "CODEX_API_KEY" },
      /root/,
    ],
  ])(
    "rejects Runtime static configuration with %s",
    async (_name, relativePath, value, expected) => {
      await writeValidServerConfig(tempRoot);
      await writeJson(path.join(tempRoot, relativePath), value);

      await expect(
        loadHuanLinkServerStaticConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(expected);
    },
  );

  test.each([undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "requires maxActiveTasksPerSession to be a safe positive integer (%s)",
    async (maxActiveTasksPerSession) => {
      await writeValidServerConfig(tempRoot);
      const agentCallPolicy =
        maxActiveTasksPerSession === undefined
          ? {}
          : { maxActiveTasksPerSession };
      await writeJson(path.join(tempRoot, "server", "orchestration.json"), {
        version: 1,
        defaultAgentId: "codex-local",
        agentCallPolicy,
      });

      await expect(
        loadHuanLinkServerStaticConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(
        /server\/orchestration\.json.*maxActiveTasksPerSession/,
      );
    },
  );

  test("loads a Channel-only Server configuration without MainAgent or external Agents", async () => {
    await writeValidServerConfig(tempRoot, {
      agents: [],
      config: {
        version: 1,
        server: {
          channels: ["./server/channels/onebot11.json"],
          agents: [],
        },
      },
    });

    await expect(
      loadServerChannelRuntimeConfig({
        configRoot: tempRoot,
        env: { HUANLINK_ONEBOT_ACCESS_TOKEN: ACCESS_TOKEN },
      }),
    ).resolves.toMatchObject({
      channels: [{ channelId: "qq-main" }],
      agents: [],
    });
  });

  test("still validates a declared MainAgent file without resolving its API key", async () => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, "server", "main-agent.json"), {
      ...mainAgent,
      version: 2,
    });

    await expect(
      loadServerChannelRuntimeConfig({
        configRoot: tempRoot,
        env: { HUANLINK_ONEBOT_ACCESS_TOKEN: ACCESS_TOKEN },
      }),
    ).rejects.toThrow(/server\/main-agent\.json.*version/);
  });

  test("loads only explicitly referenced Server files in declaration order and resolves secret references", async () => {
    await writeValidServerConfig(tempRoot, {
      channels: [
        ["z-second.json", { ...oneBotChannel, channelId: "qq-second" }],
        ["a-first.json", { ...oneBotChannel, channelId: "qq-first" }],
      ],
      agents: [
        ["z-second.json", { ...a2aAgent, agentId: "agent-second" }],
        ["a-first.json", { ...a2aAgent, agentId: "agent-first" }],
      ],
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toEqual({
      mainAgent: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/beta",
        apiKey: API_KEY,
      },
      channels: [
        {
          channelId: "qq-second",
          type: "onebot11-forward-websocket",
          url: "ws://127.0.0.1:3001/",
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["20002000"] },
            directs: { mode: "denylist", ids: [] },
          },
          enableUnsafePrivilegedOperations: false,
          accessToken: ACCESS_TOKEN,
        },
        {
          channelId: "qq-first",
          type: "onebot11-forward-websocket",
          url: "ws://127.0.0.1:3001/",
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["20002000"] },
            directs: { mode: "denylist", ids: [] },
          },
          enableUnsafePrivilegedOperations: false,
          accessToken: ACCESS_TOKEN,
        },
      ],
      agents: [
        {
          agentId: "agent-second",
          displayName: "Codex Local",
          transport: "a2a",
          origin: "http://127.0.0.1:4000",
          skillId: "codex-code-task",
          enabled: true,
        },
        {
          agentId: "agent-first",
          displayName: "Codex Local",
          transport: "a2a",
          origin: "http://127.0.0.1:4000",
          skillId: "codex-code-task",
          enabled: true,
        },
      ],
    });
  });

  test("loads explicit group and direct inbound access policies without legacy routing fields", async () => {
    await writeValidServerConfig(tempRoot, {
      channels: [
        [
          "onebot11.json",
          {
            version: 1,
            channelId: "qq-main",
            type: "onebot11-forward-websocket",
            url: "ws://127.0.0.1:3001/",
            inboundPolicy: {
              groups: { mode: "allowlist", ids: ["20002000"] },
              directs: { mode: "denylist", ids: ["30003000"] },
            },
            enableUnsafePrivilegedOperations: true,
            accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
          },
        ],
      ],
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({
      channels: [
        {
          channelId: "qq-main",
          inboundPolicy: {
            groups: { mode: "allowlist", ids: ["20002000"] },
            directs: { mode: "denylist", ids: ["30003000"] },
          },
          enableUnsafePrivilegedOperations: true,
        },
      ],
    });
  });

  test.each([
    [
      "a missing inbound policy",
      {
        version: 1,
        channelId: "qq-main",
        type: "onebot11-forward-websocket",
        url: "ws://127.0.0.1:3001/",
        enableUnsafePrivilegedOperations: false,
        accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
      },
    ],
    [
      "a missing privileged-operation switch",
      {
        version: 1,
        channelId: "qq-main",
        type: "onebot11-forward-websocket",
        url: "ws://127.0.0.1:3001/",
        inboundPolicy: {
          groups: { mode: "allowlist", ids: ["20002000"] },
          directs: { mode: "denylist", ids: [] },
        },
        accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
      },
    ],
    [
      "an unsupported access mode",
      {
        ...oneBotChannel,
        inboundPolicy: {
          groups: { mode: "observe", ids: ["20002000"] },
          directs: { mode: "allowlist", ids: [] },
        },
      },
    ],
    [
      "a non-positive group id",
      {
        ...oneBotChannel,
        inboundPolicy: {
          groups: { mode: "allowlist", ids: ["0"] },
          directs: { mode: "allowlist", ids: [] },
        },
      },
    ],
    [
      "an unsafe direct id",
      {
        ...oneBotChannel,
        inboundPolicy: {
          groups: { mode: "allowlist", ids: [] },
          directs: { mode: "allowlist", ids: ["9007199254740992"] },
        },
      },
    ],
    [
      "duplicate ids within one access policy",
      {
        ...oneBotChannel,
        inboundPolicy: {
          groups: { mode: "allowlist", ids: ["20002000", "20002000"] },
          directs: { mode: "allowlist", ids: [] },
        },
      },
    ],
    [
      "legacy groupId and commandPrefix fields",
      {
        ...oneBotChannel,
        groupId: "20002000",
        commandPrefix: "/huanlink",
      },
    ],
  ])("rejects %s in a Channel inbound policy", async (_name, channel) => {
    await writeValidServerConfig(tempRoot, {
      channels: [["onebot11.json", channel]],
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(/server\/channels\/onebot11\.json/);
  });

  test("ignores an invalid Server JSON file that config.json does not reference", async () => {
    await writeValidServerConfig(tempRoot);
    await writeJson(
      path.join(tempRoot, "server", "channels", "unreferenced.json"),
      {
        version: 1,
        channelId: "bad id",
      },
    );

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({
      channels: [{ channelId: "qq-main" }],
    });
  });

  test.each([
    ["a missing config.json", undefined, "root"],
    ["damaged config.json", "{ invalid JSON", "root"],
    [
      "an unknown config.json field",
      { version: 1, server: serverConfigEntry(), unexpected: true },
      "root",
    ],
  ])("rejects %s", async (_name, contents, field) => {
    await writeValidServerConfig(tempRoot);
    const configPath = path.join(tempRoot, "config.json");
    if (contents === undefined) {
      await rm(configPath);
    } else if (typeof contents === "string") {
      await writeFile(configPath, contents, "utf8");
    } else {
      await writeJson(configPath, contents);
    }

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(new RegExp(`config\\.json.*${field}`));
  });

  test.each([
    ["a missing Server section", { version: 1 }, "server"],
    [
      "an unknown Server field",
      { version: 1, server: { ...serverConfigEntry(), unexpected: true } },
      "root",
    ],
    [
      "a missing mainAgent reference",
      {
        version: 1,
        server: {
          channels: ["./server/channels/onebot11.json"],
          agents: ["./server/agents/codex-local.json"],
        },
      },
      "mainAgent",
    ],
    [
      "an empty channels list",
      { version: 1, server: { ...serverConfigEntry(), channels: [] } },
      "channels",
    ],
    [
      "a non-string Agent reference",
      { version: 1, server: { ...serverConfigEntry(), agents: [42] } },
      "agents",
    ],
  ])("rejects config.json with %s", async (_name, entry, field) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, "config.json"), entry);

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(new RegExp(`config\\.json.*${field}`));
  });

  test.each([
    ["a reference without ./", "mainAgent", "server/main-agent.json"],
    ["an absolute reference", "channels", "/server/channels/onebot11.json"],
    ["a backslash reference", "agents", ".\\server\\agents\\codex-local.json"],
    [
      "a parent-directory reference",
      "channels",
      "./server/channels/../channels/onebot11.json",
    ],
    [
      "a reference outside the Server namespace",
      "agents",
      "./adapters/codex/projects/huanlink.json",
    ],
  ])("rejects %s", async (_name, field, reference) => {
    await writeValidServerConfig(tempRoot);
    const server = serverConfigEntry();
    if (field === "mainAgent") {
      server.mainAgent = reference;
    } else if (field === "channels") {
      server.channels = [reference];
    } else {
      server.agents = [reference];
    }
    await writeJson(path.join(tempRoot, "config.json"), { version: 1, server });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(new RegExp(`config\\.json.*${field}`));
  });

  test.each([
    [
      "duplicate references",
      ["./server/channels/onebot11.json", "./server/channels/onebot11.json"],
    ],
    ["an alias reference", ["./server/channels/./onebot11.json"]],
  ])("rejects %s", async (_name, channels) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(path.join(tempRoot, "config.json"), {
      version: 1,
      server: { ...serverConfigEntry(), channels },
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(/config\.json.*channels/);
  });

  test("loads its own explicit references while a malformed Adapter section does not block it", async () => {
    await writeValidServerConfig(tempRoot);
    const alternateMainAgent = { ...mainAgent, modelId: "deepseek-v4-alt" };
    const alternateChannel = { ...oneBotChannel, channelId: "qq-alt" };
    const alternateAgent = { ...a2aAgent, agentId: "agent-alt" };
    await writeJson(
      path.join(tempRoot, "server", "main-agent-alt.json"),
      alternateMainAgent,
    );
    await writeJson(
      path.join(tempRoot, "server", "channels", "alt.json"),
      alternateChannel,
    );
    await writeJson(
      path.join(tempRoot, "server", "agents", "alt.json"),
      alternateAgent,
    );
    await writeJson(path.join(tempRoot, "config.json"), {
      version: 1,
      server: {
        mainAgent: "./server/main-agent-alt.json",
        channels: ["./server/channels/alt.json"],
        agents: ["./server/agents/alt.json"],
      },
      adapters: { codex: { runtime: 42 } },
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({
      mainAgent: { modelId: "deepseek-v4-alt" },
      channels: [{ channelId: "qq-alt" }],
      agents: [{ agentId: "agent-alt" }],
    });
  });

  test("uses cwd/.huanlink/config by default", async () => {
    const originalCwd = process.cwd();
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "huanlink-local-config-cwd-"),
    );
    await writeValidServerConfig(path.join(cwd, ".huanlink", "config"));
    process.chdir(cwd);

    try {
      await expect(loadServerLocalUserConfig()).resolves.toMatchObject({
        mainAgent: { apiKey: API_KEY },
        channels: [{ channelId: "qq-main" }],
        agents: [{ agentId: "codex-local" }],
      });
    } finally {
      process.chdir(originalCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses an explicit projectRoot without relying on process cwd", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "huanlink-local-config-project-"),
    );
    await writeValidServerConfig(path.join(projectRoot, ".huanlink", "config"));

    try {
      await expect(
        loadServerLocalUserConfig({ projectRoot }),
      ).resolves.toMatchObject({
        channels: [{ channelId: "qq-main" }],
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects a .huanlink directory junction on the default path", async (context) => {
    await writeValidServerConfig(path.join(escapeRoot, "config"));
    const huanlinkPath = path.join(tempRoot, ".huanlink");

    if (
      !(await createLinkOrSkip(context, escapeRoot, huanlinkPath, "junction"))
    ) {
      return;
    }

    await expect(
      loadServerLocalUserConfig({ projectRoot: tempRoot }),
    ).rejects.toThrow(/\.huanlink/);
  });

  test("rejects an explicit projectRoot directory junction", async (context) => {
    await writeValidServerConfig(path.join(escapeRoot, ".huanlink", "config"));
    const linkedProjectRoot = path.join(tempRoot, "linked-project-root");

    if (
      !(await createLinkOrSkip(
        context,
        escapeRoot,
        linkedProjectRoot,
        "junction",
      ))
    ) {
      return;
    }

    await expect(
      loadServerChannelRuntimeConfig({ projectRoot: linkedProjectRoot }),
    ).rejects.toThrow(/project root/);
  });

  test.each([
    ["server/main-agent.json", { ...mainAgent, version: 2 }, "version"],
    ["server/main-agent.json", { ...mainAgent, unexpected: true }, "root"],
    [
      "server/channels/onebot11.json",
      { ...oneBotChannel, channelId: "bad id" },
      "channelId",
    ],
    [
      "server/channels/onebot11.json",
      { ...oneBotChannel, url: "http://127.0.0.1:3001" },
      "url",
    ],
    [
      "server/agents/codex-local.json",
      { ...a2aAgent, origin: "https://example.test" },
      "origin",
    ],
  ])(
    "rejects invalid %s without leaking configuration contents",
    async (file, value, field) => {
      await writeValidServerConfig(tempRoot);
      await writeJson(path.join(tempRoot, file), value);

      await expect(
        loadServerLocalUserConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(new RegExp(`${escapeRegExp(file)}.*${field}`));
    },
  );

  test.each([
    [
      "userinfo",
      "ws://tracked-user:tracked-password@127.0.0.1:3001/",
      "tracked-password",
    ],
    [
      "an access-token query",
      "ws://127.0.0.1:3001/?access_token=tracked-token",
      "tracked-token",
    ],
    [
      "an arbitrary query",
      "ws://127.0.0.1:3001/?client=tracked-query-value",
      "tracked-query-value",
    ],
    ["a fragment", "ws://127.0.0.1:3001/#tracked-fragment", "tracked-fragment"],
    ["a bare query delimiter", "ws://127.0.0.1:3001/?", "?"],
    ["a bare fragment delimiter", "ws://127.0.0.1:3001/#", "#"],
    ["bare query and fragment delimiters", "ws://127.0.0.1:3001/?#", "?#"],
  ])(
    "rejects OneBot WebSocket URLs containing %s",
    async (_case, url, secret) => {
      await writeValidServerConfig(tempRoot);
      await writeJson(path.join(tempRoot, "server/channels/onebot11.json"), {
        ...oneBotChannel,
        url,
      });

      let thrown: unknown;
      try {
        await loadServerLocalUserConfig({ configRoot: tempRoot });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "server/channels/onebot11.json",
      );
      expect((thrown as Error).message).toContain("url");
      expect((thrown as Error).message).not.toContain(secret);
    },
  );

  test("allows credential-free wss endpoints with custom host, port, and path", async () => {
    await writeValidServerConfig(tempRoot);
    const url = "wss://onebot.example.test:8443/onebot/v11";
    await writeJson(path.join(tempRoot, "server/channels/onebot11.json"), {
      ...oneBotChannel,
      url,
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({ channels: [{ url }] });
  });

  test.each([
    ["channels", "channelId"],
    ["agents", "agentId"],
  ])(
    "rejects duplicate stable %s without disclosing its value",
    async (directory, field) => {
      await writeValidServerConfig(tempRoot);
      const secretId = `do-not-disclose-${directory}-id`;
      const fixture = {
        ...(directory === "channels" ? oneBotChannel : a2aAgent),
        [field]: secretId,
      };
      const originalFile =
        directory === "channels" ? "onebot11.json" : "codex-local.json";
      await writeJson(
        path.join(tempRoot, "server", directory, originalFile),
        fixture,
      );
      await writeJson(
        path.join(tempRoot, "server", directory, "z-duplicate.json"),
        fixture,
      );
      const server = serverConfigEntry();
      if (directory === "channels") {
        server.channels.push("./server/channels/z-duplicate.json");
      } else {
        server.agents.push("./server/agents/z-duplicate.json");
      }
      await writeJson(path.join(tempRoot, "config.json"), {
        version: 1,
        server,
      });

      const promise = loadServerLocalUserConfig({ configRoot: tempRoot });
      await expect(promise).rejects.toThrow(
        new RegExp(`${directory}/z-duplicate\\.json.*${field}`),
      );
      await expect(promise).rejects.not.toThrow(secretId);
    },
  );

  test.each([
    ["server/main-agent.json"],
    ["server/channels"],
    ["server/agents"],
  ])("requires %s", async (relativePath) => {
    await writeValidServerConfig(tempRoot);
    await rm(path.join(tempRoot, relativePath), {
      recursive: true,
      force: true,
    });

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(new RegExp(escapeRegExp(relativePath)));
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
    ["server/main-agent.json", "[]"],
  ])(
    "rejects damaged or non-object JSON in %s",
    async (relativePath, content) => {
      await writeValidServerConfig(tempRoot);
      await writeFile(path.join(tempRoot, relativePath), content, "utf8");

      await expect(
        loadServerLocalUserConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(new RegExp(escapeRegExp(relativePath)));
    },
  );

  test("rejects invalid UTF-8 even when replacement decoding would leave valid JSON", async () => {
    await writeValidServerConfig(tempRoot);
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"version":1,"provider":"deepseek","modelId":"'),
      Buffer.from([0x80]),
      Buffer.from(
        '","baseURL":"https://api.deepseek.com/beta","apiKeyEnv":"DEEPSEEK_API_KEY"}',
      ),
    ]);
    await writeFile(
      path.join(tempRoot, "server", "main-agent.json"),
      invalidUtf8,
    );

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(/server\/main-agent\.json.*UTF-8/);
  });

  test.each(["channels", "agents"])(
    "rejects an empty %s directory",
    async (directory) => {
      await writeValidServerConfig(tempRoot);
      const directoryPath = path.join(tempRoot, "server", directory);
      await rm(directoryPath, { recursive: true, force: true });
      await mkdir(directoryPath, { recursive: true });

      await expect(
        loadServerLocalUserConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(new RegExp(`server/${directory}`));
    },
  );

  test.each([
    [
      "server/main-agent.json",
      { ...mainAgent, apiKeyEnv: "BAD-NAME" },
      "apiKeyEnv",
    ],
    [
      "server/channels/onebot11.json",
      { ...oneBotChannel, accessTokenEnv: "BAD-NAME" },
      "accessTokenEnv",
    ],
  ])(
    "rejects invalid environment variable names in %s",
    async (relativePath, value, field) => {
      await writeValidServerConfig(tempRoot);
      await writeJson(path.join(tempRoot, relativePath), value);

      await expect(
        loadServerLocalUserConfig({ configRoot: tempRoot }),
      ).rejects.toThrow(new RegExp(`${escapeRegExp(relativePath)}.*${field}`));
    },
  );

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
    expect((thrown as Error).message).toContain(
      "server/channels/onebot11.json",
    );
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
          HUANLINK_ONEBOT_ACCESS_TOKEN: "injected-onebot-token",
        },
      }),
    ).resolves.toMatchObject({
      mainAgent: { apiKey: "injected-main-agent-key" },
      channels: [{ accessToken: "injected-onebot-token" }],
    });
  });

  test.each([
    "http://127.0.0.1:4100",
    "https://localhost:4100",
    "http://[::1]:4100",
  ])("accepts loopback A2A origin %s", async (origin) => {
    await writeValidServerConfig(tempRoot);
    await writeJson(
      path.join(tempRoot, "server", "agents", "codex-local.json"),
      {
        ...a2aAgent,
        origin,
      },
    );

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({
      agents: [{ origin }],
    });
  });

  test("does not echo an unknown field name or its JSON content", async () => {
    await writeValidServerConfig(tempRoot);
    const secretField = "do-not-disclose-unknown-field";
    const rawSecret = "raw-secret-that-must-not-leak";
    await writeJson(path.join(tempRoot, "server", "main-agent.json"), {
      ...mainAgent,
      [secretField]: rawSecret,
    });

    let thrown: unknown;
    try {
      await loadServerLocalUserConfig({ configRoot: tempRoot });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("server/main-agent.json");
    expect((thrown as Error).message).toContain("root");
    expect((thrown as Error).message).not.toContain(secretField);
    expect((thrown as Error).message).not.toContain(rawSecret);
  });

  test("preserves leading and trailing whitespace in a resolved secret", async () => {
    await writeValidServerConfig(tempRoot);
    const secretWithWhitespace = "  main-agent-secret\t";
    process.env.DEEPSEEK_API_KEY = secretWithWhitespace;

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).resolves.toMatchObject({
      mainAgent: { apiKey: secretWithWhitespace },
    });
  });

  test("rejects a symbolic-link fixed main-agent file", async (context) => {
    await writeValidServerConfig(tempRoot);
    const mainAgentPath = path.join(tempRoot, "server", "main-agent.json");
    const externalMainAgentPath = path.join(escapeRoot, "main-agent.json");
    await writeJson(externalMainAgentPath, mainAgent);
    await rm(mainAgentPath);

    if (
      !(await createLinkOrSkip(
        context,
        externalMainAgentPath,
        mainAgentPath,
        "file",
      ))
    ) {
      return;
    }

    await expect(
      loadServerLocalUserConfig({ configRoot: tempRoot }),
    ).rejects.toThrow(/server\/main-agent\.json/);
  });

  test("rejects a directory junction used as configRoot", async (context) => {
    await writeValidServerConfig(escapeRoot);
    const linkedConfigRoot = path.join(tempRoot, "linked-config-root");

    if (
      !(await createLinkOrSkip(
        context,
        escapeRoot,
        linkedConfigRoot,
        "junction",
      ))
    ) {
      return;
    }

    await expect(
      loadServerLocalUserConfig({ configRoot: linkedConfigRoot }),
    ).rejects.toThrow(/configuration root/);
  });

  test("rejects a directory junction at server", async (context) => {
    await expectDirectoryJunctionRejection(context, "server", "server");
  });

  test("rejects a directory junction at server/channels", async (context) => {
    await expectDirectoryJunctionRejection(
      context,
      "server/channels",
      "channels",
    );
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
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const oneBotChannel = {
  version: 1,
  channelId: "qq-main",
  type: "onebot11-forward-websocket",
  url: "ws://127.0.0.1:3001/",
  inboundPolicy: {
    groups: { mode: "allowlist", ids: ["20002000"] },
    directs: { mode: "denylist", ids: [] },
  },
  enableUnsafePrivilegedOperations: false,
  accessTokenEnv: "HUANLINK_ONEBOT_ACCESS_TOKEN",
};

const a2aAgent = {
  version: 1,
  agentId: "codex-local",
  displayName: "Codex Local",
  transport: "a2a",
  origin: "http://127.0.0.1:4000",
  skillId: "codex-code-task",
  enabled: true,
};

const orchestration = {
  version: 1,
  defaultAgentId: "codex-local",
  agentCallPolicy: {
    maxActiveTasksPerSession: 2,
  },
};

type ServerConfigEntry = {
  mainAgent: string;
  channels: string[];
  agents: string[];
};

function serverConfigEntry(): ServerConfigEntry {
  return {
    mainAgent: "./server/main-agent.json",
    channels: ["./server/channels/onebot11.json"],
    agents: ["./server/agents/codex-local.json"],
  };
}

async function writeValidServerConfig(
  root: string,
  input: {
    channels?: Array<[string, object]>;
    agents?: Array<[string, object]>;
    orchestration?: object;
    config?: object;
  } = {},
): Promise<void> {
  const channels = input.channels ?? [["onebot11.json", oneBotChannel]];
  const agents = input.agents ?? [["codex-local.json", a2aAgent]];
  const orchestrationConfig = input.orchestration ?? orchestration;
  await writeJson(path.join(root, "server", "main-agent.json"), mainAgent);
  await writeJson(
    path.join(root, "server", "orchestration.json"),
    orchestrationConfig,
  );
  for (const [name, value] of channels) {
    await writeJson(path.join(root, "server", "channels", name), value);
  }
  for (const [name, value] of agents) {
    await writeJson(path.join(root, "server", "agents", name), value);
  }
  await writeJson(
    path.join(root, "config.json"),
    input.config ?? {
      version: 1,
      server: {
        mainAgent: "./server/main-agent.json",
        orchestration: "./server/orchestration.json",
        channels: channels.map(([name]) => `./server/channels/${name}`),
        agents: agents.map(([name]) => `./server/agents/${name}`),
      },
    },
  );
}

async function writeJson(filePath: string, value: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createLinkOrSkip(
  context: { skip: () => void },
  target: string,
  linkPath: string,
  type: "file" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" ||
        error.code === "EACCES" ||
        error.code === "ENOSYS")
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
  targetDirectoryName: "server" | "channels" | "agents",
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
  if (
    !(await createLinkOrSkip(context, targetDirectory, linkPath, "junction"))
  ) {
    return;
  }

  await expect(
    loadServerLocalUserConfig({ configRoot: tempRoot }),
  ).rejects.toThrow(new RegExp(escapeRegExp(relativePath)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
