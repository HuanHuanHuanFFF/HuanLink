import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import type { ChannelInboundAccessPolicy } from "./channel-access-policy.js";

const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a stable ID");

const environmentVariableNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const positiveSafeIntegerStringSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d*$/, "must be a positive integer string")
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    "must be a safe positive integer string"
  );

const channelAccessRuleSchema = z
  .object({
    mode: z.enum(["allowlist", "denylist"]),
    ids: z
      .array(positiveSafeIntegerStringSchema)
      .refine((ids) => new Set(ids).size === ids.length, "must not contain duplicate IDs")
  })
  .strict();

const channelInboundAccessPolicySchema: z.ZodType<ChannelInboundAccessPolicy> = z
  .object({
    groups: channelAccessRuleSchema,
    directs: channelAccessRuleSchema
  })
  .strict();

const mainAgentFileSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("deepseek"),
    modelId: z.string().trim().min(1),
    baseURL: httpsUrlSchema(),
    apiKeyEnv: environmentVariableNameSchema
  })
  .strict();

const channelFileSchema = z
  .object({
    version: z.literal(1),
    channelId: stableIdSchema,
    type: z.literal("onebot11-forward-websocket"),
    url: websocketUrlSchema(),
    inboundPolicy: channelInboundAccessPolicySchema,
    enableUnsafePrivilegedOperations: z.boolean(),
    accessTokenEnv: environmentVariableNameSchema.optional()
  })
  .strict();

const agentFileSchema = z
  .object({
    version: z.literal(1),
    agentId: stableIdSchema,
    displayName: z.string().trim().min(1),
    transport: z.literal("a2a"),
    origin: loopbackHttpUrlSchema(),
    skillId: z.string().trim().min(1),
    enabled: z.boolean()
  })
  .strict();

const configEntrySchema = z
  .object({
    version: z.literal(1),
    server: z.unknown().optional(),
    adapters: z.unknown().optional()
  })
  .strict();

const serverConfigReferenceSchema = z
  .object({
    mainAgent: z.string().optional(),
    channels: z.array(z.string()).min(1),
    agents: z.array(z.string()).default([])
  })
  .strict();

type ServerMainAgentStaticConfig = {
  provider: "deepseek";
  modelId: string;
  baseURL: string;
  apiKeyEnv: string;
};

type ServerChannelConfig = {
  channelId: string;
  type: "onebot11-forward-websocket";
  url: string;
  inboundPolicy: ChannelInboundAccessPolicy;
  enableUnsafePrivilegedOperations: boolean;
  accessToken?: string;
};

type ServerAgentConfig = {
  agentId: string;
  displayName: string;
  transport: "a2a";
  origin: string;
  skillId: string;
  enabled: boolean;
};

/**
 * Channel 正式入口实际需要的配置快照。
 *
 * MainAgent 与外部 Agent 只做静态校验和热重载比较；在 Agent Runtime 接线前，
 * 本类型不会解析或持有 MainAgent API Key。
 */
export type ServerChannelRuntimeConfig = {
  mainAgent?: ServerMainAgentStaticConfig;
  channels: Array<
    ServerChannelConfig & {
      accessTokenEnv?: string;
    }
  >;
  agents: ServerAgentConfig[];
  /** 入口文件中的显式引用身份；引用变化必须重启，不能伪装成名单热更新。 */
  sources: {
    mainAgent?: string;
    channels: string[];
    agents: string[];
  };
};

export type ServerLocalUserConfig = {
  mainAgent: {
    provider: "deepseek";
    modelId: string;
    baseURL: string;
    apiKey: string;
  };
  channels: ServerChannelConfig[];
  agents: ServerAgentConfig[];
};

export type LoadServerLocalUserConfigInput = {
  configRoot?: string;
  projectRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

type ParsedServerConfiguration = {
  mainAgent?: {
    value: z.infer<typeof mainAgentFileSchema>;
    relativePath: string;
  };
  channels: Array<{
    value: z.infer<typeof channelFileSchema>;
    relativePath: string;
  }>;
  agents: Array<z.infer<typeof agentFileSchema>>;
};

export async function loadServerLocalUserConfig(
  input: LoadServerLocalUserConfigInput = {}
): Promise<ServerLocalUserConfig> {
  const { configuration, env } = await readServerConfiguration(input);
  if (configuration.mainAgent === undefined) {
    throw configurationError("config.json", "mainAgent: is invalid");
  }

  return {
    mainAgent: {
      provider: configuration.mainAgent.value.provider,
      modelId: configuration.mainAgent.value.modelId,
      baseURL: configuration.mainAgent.value.baseURL,
      apiKey: requireEnvironmentValue(
        env,
        configuration.mainAgent.value.apiKeyEnv,
        configuration.mainAgent.relativePath,
        "apiKeyEnv"
      )
    },
    channels: configuration.channels.map((channel) =>
      resolveChannelConfig(channel.value, channel.relativePath, env, false)
    ),
    agents: configuration.agents.map(copyAgentConfig)
  };
}

/**
 * 加载正式 Channel 入口所需配置，同时完整校验已声明的 Server 静态配置。
 * MainAgent API Key 要等 Agent Runtime 真正接线时再解析。
 */
export async function loadServerChannelRuntimeConfig(
  input: LoadServerLocalUserConfigInput = {}
): Promise<ServerChannelRuntimeConfig> {
  const { configuration, env, sources } = await readServerConfiguration(input);

  return {
    ...(configuration.mainAgent === undefined
      ? {}
      : {
          mainAgent: {
            provider: configuration.mainAgent.value.provider,
            modelId: configuration.mainAgent.value.modelId,
            baseURL: configuration.mainAgent.value.baseURL,
            apiKeyEnv: configuration.mainAgent.value.apiKeyEnv
          }
        }),
    channels: configuration.channels.map((channel) =>
      resolveChannelConfig(channel.value, channel.relativePath, env, true)
    ),
    agents: configuration.agents.map(copyAgentConfig),
    sources
  };
}

async function readServerConfiguration(
  input: LoadServerLocalUserConfigInput
): Promise<{
  configuration: ParsedServerConfiguration;
  env: Readonly<Record<string, string | undefined>>;
  sources: ServerChannelRuntimeConfig["sources"];
}> {
  const configRoot = await resolveConfigRoot(input);
  const env = input.env ?? process.env;
  const entryRelativePath = "config.json";
  const entry = parseConfigFile(
    configEntrySchema,
    await readJsonObject(configRoot, entryRelativePath),
    entryRelativePath
  );
  if (entry.server === undefined) {
    throw configurationError(entryRelativePath, "server: is invalid");
  }
  const references = parseConfigFile(
    serverConfigReferenceSchema,
    entry.server,
    entryRelativePath
  );
  const mainAgentRelativePath =
    references.mainAgent === undefined
      ? undefined
      : validateServerReference(references.mainAgent, "mainAgent");
  const channelFiles = references.channels.map((reference) =>
    validateServerReference(reference, "channels")
  );
  const agentFiles = references.agents.map((reference) =>
    validateServerReference(reference, "agents")
  );
  ensureUniqueReferences(channelFiles, "channels");
  ensureUniqueReferences(agentFiles, "agents");
  const mainAgent =
    mainAgentRelativePath === undefined
      ? undefined
      : {
          value: parseConfigFile(
            mainAgentFileSchema,
            await readJsonObject(configRoot, mainAgentRelativePath),
            mainAgentRelativePath
          ),
          relativePath: mainAgentRelativePath
        };

  const channels = await Promise.all(
    channelFiles.map(async (relativePath) => {
      const parsed = parseConfigFile(
        channelFileSchema,
        await readJsonObject(configRoot, relativePath),
        relativePath
      );

      return { value: parsed, relativePath };
    })
  );
  const agents = await Promise.all(
    agentFiles.map(async (relativePath) => {
      const parsed = parseConfigFile(
        agentFileSchema,
        await readJsonObject(configRoot, relativePath),
        relativePath
      );

      return parsed;
    })
  );

  ensureUniqueIds(
    channels.map((channel) => channel.value),
    "channelId",
    channelFiles
  );
  ensureUniqueIds(agents, "agentId", agentFiles);

  return {
    configuration: {
      ...(mainAgent === undefined ? {} : { mainAgent }),
      channels,
      agents
    },
    env,
    sources: {
      ...(mainAgentRelativePath === undefined
        ? {}
        : { mainAgent: mainAgentRelativePath }),
      channels: [...channelFiles],
      agents: [...agentFiles]
    }
  };
}

async function resolveConfigRoot(
  input: LoadServerLocalUserConfigInput
): Promise<string> {
  if (input.configRoot !== undefined && input.projectRoot !== undefined) {
    throw new TypeError("Specify either configRoot or projectRoot, not both");
  }
  if (input.configRoot !== undefined) {
    return path.resolve(input.configRoot);
  }

  const projectRoot = path.resolve(input.projectRoot ?? process.cwd());
  await requireProjectRoot(projectRoot);
  await requireDefaultConfigurationPath(projectRoot);
  return path.join(projectRoot, ".huanlink", "config");
}

async function requireProjectRoot(projectRoot: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(projectRoot);
  } catch {
    throw configurationError(
      "project root",
      "root: must be an existing non-link directory"
    );
  }
  if (metadata.isSymbolicLink()) {
    throw configurationError(
      "project root",
      "root: must not be a symbolic link or directory junction"
    );
  }
  if (!metadata.isDirectory()) {
    throw configurationError("project root", "root: must be a directory");
  }
}

function resolveChannelConfig(
  channel: z.infer<typeof channelFileSchema>,
  relativePath: string,
  env: Readonly<Record<string, string | undefined>>,
  includeEnvironmentReference: false
): ServerChannelConfig;
function resolveChannelConfig(
  channel: z.infer<typeof channelFileSchema>,
  relativePath: string,
  env: Readonly<Record<string, string | undefined>>,
  includeEnvironmentReference: true
): ServerChannelRuntimeConfig["channels"][number];
function resolveChannelConfig(
  channel: z.infer<typeof channelFileSchema>,
  relativePath: string,
  env: Readonly<Record<string, string | undefined>>,
  includeEnvironmentReference: boolean
): ServerChannelRuntimeConfig["channels"][number] {
  return {
    channelId: channel.channelId,
    type: channel.type,
    url: channel.url,
    inboundPolicy: channel.inboundPolicy,
    enableUnsafePrivilegedOperations: channel.enableUnsafePrivilegedOperations,
    ...(includeEnvironmentReference && channel.accessTokenEnv !== undefined
      ? { accessTokenEnv: channel.accessTokenEnv }
      : {}),
    ...(channel.accessTokenEnv === undefined
      ? {}
      : {
          accessToken: requireEnvironmentValue(
            env,
            channel.accessTokenEnv,
            relativePath,
            "accessTokenEnv"
          )
        })
  };
}

function copyAgentConfig(
  agent: z.infer<typeof agentFileSchema>
): ServerAgentConfig {
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    transport: agent.transport,
    origin: agent.origin,
    skillId: agent.skillId,
    enabled: agent.enabled
  };
}

async function readJsonObject(
  configRoot: string,
  relativePath: string
): Promise<unknown> {
  await requireRegularPath(configRoot, relativePath, "file");
  const absolutePath = path.join(configRoot, ...relativePath.split("/"));
  let bytes: Buffer;

  try {
    bytes = await readFile(absolutePath);
  } catch {
    throw configurationError(relativePath, "root: must be a readable regular JSON file");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError(relativePath, "root: must contain valid UTF-8");
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw configurationError(relativePath, "root: must contain a valid JSON object");
  }
}

function ensureUniqueIds<T extends Record<Key, string>, Key extends string>(
  items: readonly T[],
  field: Key,
  relativePaths: readonly string[]
): void {
  const seen = new Set<string>();

  for (const [index, item] of items.entries()) {
    if (seen.has(item[field])) {
      throw configurationError(
        relativePaths[index]!,
        `${field}: duplicates another configured entry`
      );
    }
    seen.add(item[field]);
  }
}

function validateServerReference(reference: string, field: string): string {
  const isValid =
    reference.startsWith("./server/") &&
    reference.endsWith(".json") &&
    !reference.includes("\\") &&
    reference
      .slice(2)
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (!isValid) {
    throw configurationError("config.json", `${field}: is invalid`);
  }

  return reference.slice(2);
}

function ensureUniqueReferences(references: readonly string[], field: string): void {
  if (new Set(references).size !== references.length) {
    throw configurationError("config.json", `${field}: is invalid`);
  }
}

function requireEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  relativePath: string,
  field: string
): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw configurationError(relativePath, `${field} references a missing environment value`);
  }
  return value;
}

async function requireDefaultConfigurationPath(cwd: string): Promise<void> {
  const segments = [".huanlink", "config"] as const;
  let currentPath = cwd;

  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const label = segments.slice(0, index + 1).join("/");
    let metadata: Awaited<ReturnType<typeof lstat>>;

    try {
      metadata = await lstat(currentPath);
    } catch {
      throw configurationError(label, "root: must be an existing non-link directory");
    }
    if (metadata.isSymbolicLink()) {
      throw configurationError(
        label,
        "root: must not be a symbolic link or directory junction"
      );
    }
    if (!metadata.isDirectory()) {
      throw configurationError(label, "root: must be a directory");
    }
  }
}

async function requireRegularPath(
  configRoot: string,
  relativePath: string,
  finalKind: "file" | "directory"
): Promise<void> {
  let rootMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    rootMetadata = await lstat(configRoot);
  } catch {
    throw configurationError(
      "configuration root",
      "root: must be an existing non-link directory"
    );
  }
  if (rootMetadata.isSymbolicLink()) {
    throw configurationError(
      "configuration root",
      "root: must not be a symbolic link or directory junction"
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw configurationError("configuration root", "root: must be a directory");
  }

  const segments = relativePath.split("/");
  let currentPath = configRoot;

  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const currentRelativePath = segments.slice(0, index + 1).join("/");
    let metadata: Awaited<ReturnType<typeof lstat>>;

    try {
      metadata = await lstat(currentPath);
    } catch {
      throw configurationError(
        currentRelativePath,
        "root: must be an existing non-link path"
      );
    }

    if (metadata.isSymbolicLink()) {
      throw configurationError(
        currentRelativePath,
        "root: must not be a symbolic link or directory junction"
      );
    }

    const isFinalSegment = index === segments.length - 1;
    if (!isFinalSegment && !metadata.isDirectory()) {
      throw configurationError(currentRelativePath, "root: must be a directory");
    }
    if (isFinalSegment && finalKind === "file" && !metadata.isFile()) {
      throw configurationError(currentRelativePath, "root: must be a regular file");
    }
    if (isFinalSegment && finalKind === "directory" && !metadata.isDirectory()) {
      throw configurationError(currentRelativePath, "root: must be a directory");
    }
  }
}

function configurationError(relativePath: string, detail: string): Error {
  return new Error(`Invalid Server local configuration at ${relativePath}: ${detail}`);
}

function parseConfigFile<T>(
  schema: z.ZodType<T>,
  value: unknown,
  relativePath: string
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const field = issue?.path.join(".") || "root";
  throw configurationError(relativePath, `${field}: is invalid`);
}

function httpsUrlSchema(): z.ZodType<string> {
  return z.string().trim().url().refine(
    (value) => getUrlProtocol(value) === "https:",
    "must use https"
  );
}

function websocketUrlSchema(): z.ZodType<string> {
  return z.string().trim().url().refine(
    (value) => {
      const protocol = getUrlProtocol(value);
      return protocol === "ws:" || protocol === "wss:";
    },
    "must use ws or wss"
  );
}

function loopbackHttpUrlSchema(): z.ZodType<string> {
  return z.string().trim().url().refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost" ||
            url.hostname === "[::1]")
        );
      } catch {
        return false;
      }
    }, "must use http or https with a loopback host");
}

function getUrlProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}
