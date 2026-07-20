import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a stable ID");

const environmentVariableNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

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
    groupId: z
      .string()
      .trim()
      .regex(/^[1-9]\d*$/, "must be a positive integer string")
      .refine(
        (value) => Number.isSafeInteger(Number(value)),
        "must be a safe positive integer string"
      ),
    commandPrefix: z.string().trim().min(1),
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

export type ServerLocalUserConfig = {
  mainAgent: {
    provider: "deepseek";
    modelId: string;
    baseURL: string;
    apiKey: string;
  };
  channels: Array<{
    channelId: string;
    type: "onebot11-forward-websocket";
    url: string;
    groupId: string;
    commandPrefix: string;
    accessToken?: string;
  }>;
  agents: Array<{
    agentId: string;
    displayName: string;
    transport: "a2a";
    origin: string;
    skillId: string;
    enabled: boolean;
  }>;
};

export async function loadServerLocalUserConfig(input: {
  configRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): Promise<ServerLocalUserConfig> {
  const cwd = process.cwd();
  if (input.configRoot === undefined) {
    await requireDefaultConfigurationPath(cwd);
  }
  const configRoot = path.resolve(
    input.configRoot ?? path.join(cwd, ".huanlink", "config")
  );
  const env = input.env ?? process.env;
  const mainAgentRelativePath = "server/main-agent.json";
  const mainAgent = parseConfigFile(
    mainAgentFileSchema,
    await readJsonObject(configRoot, mainAgentRelativePath),
    mainAgentRelativePath
  );
  const channelFiles = await findRequiredJsonFiles(configRoot, "server/channels");
  const agentFiles = await findRequiredJsonFiles(configRoot, "server/agents");

  const channels = await Promise.all(
    channelFiles.map(async (relativePath) => {
      const parsed = parseConfigFile(
        channelFileSchema,
        await readJsonObject(configRoot, relativePath),
        relativePath
      );

      return {
        channelId: parsed.channelId,
        type: parsed.type,
        url: parsed.url,
        groupId: parsed.groupId,
        commandPrefix: parsed.commandPrefix,
        ...(parsed.accessTokenEnv === undefined
          ? {}
          : {
              accessToken: requireEnvironmentValue(
                env,
                parsed.accessTokenEnv,
                relativePath,
                "accessTokenEnv"
              )
            })
      };
    })
  );
  const agents = await Promise.all(
    agentFiles.map(async (relativePath) => {
      const parsed = parseConfigFile(
        agentFileSchema,
        await readJsonObject(configRoot, relativePath),
        relativePath
      );

      return {
        agentId: parsed.agentId,
        displayName: parsed.displayName,
        transport: parsed.transport,
        origin: parsed.origin,
        skillId: parsed.skillId,
        enabled: parsed.enabled
      };
    })
  );

  ensureUniqueIds(channels, "channelId", channelFiles);
  ensureUniqueIds(agents, "agentId", agentFiles);

  return {
    mainAgent: {
      provider: mainAgent.provider,
      modelId: mainAgent.modelId,
      baseURL: mainAgent.baseURL,
      apiKey: requireEnvironmentValue(
        env,
        mainAgent.apiKeyEnv,
        mainAgentRelativePath,
        "apiKeyEnv"
      )
    },
    channels,
    agents
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

async function findRequiredJsonFiles(
  configRoot: string,
  directoryRelativePath: string
): Promise<string[]> {
  await requireRegularPath(configRoot, directoryRelativePath, "directory");
  const absoluteDirectory = path.join(
    configRoot,
    ...directoryRelativePath.split("/")
  );
  let entries: Dirent<string>[];

  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    throw configurationError(directoryRelativePath, "root: must be a readable directory");
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `${directoryRelativePath}/${entry.name}`)
    .sort(compareFileNames);

  if (files.length === 0) {
    throw configurationError(
      directoryRelativePath,
      "root: must contain at least one regular JSON file"
    );
  }

  return files;
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
        `${field} duplicates '${item[field]}'`
      );
    }
    seen.add(item[field]);
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
  const field =
    issue?.path.join(".") ||
    (issue?.code === "unrecognized_keys" ? issue.keys[0] : undefined) ||
    "root";
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

function compareFileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
