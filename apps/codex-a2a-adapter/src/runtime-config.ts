import { lstat, readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import type { RuntimeLogLevel } from "@huanlink/core";
import { z } from "zod";

const LOOPBACK_HOST_VALUES = ["127.0.0.1", "localhost", "::1"] as const;
const LOOPBACK_HOSTS = new Set<string>(LOOPBACK_HOST_VALUES);
const LOG_LEVELS = new Set<RuntimeLogLevel>([
  "debug",
  "info",
  "warn",
  "error"
]);

const NON_EMPTY_STRING = z.string().trim().min(1);
const STABLE_ID = NON_EMPTY_STRING.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const RELATIVE_WORKSPACE = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && isRelativeWorkspace(value));
const RUNTIME_FIELD_NAMES = new Set([
  "version",
  "host",
  "port",
  "codexExecutable",
  "expectedCodexVersion",
  "heartbeatIntervalMs"
]);
const ENTRY_FIELD_NAMES = new Set(["version", "server", "adapters"]);
const ADAPTERS_FIELD_NAMES = new Set(["codex"]);
const CODEX_ENTRY_FIELD_NAMES = new Set(["runtime", "projects"]);
const PROJECT_FIELD_NAMES = new Set([
  "version",
  "projectId",
  "workspace",
  "branch",
  "defaultModelId"
]);

const adapterRuntimeSchema = z
  .object({
    version: z.literal(1),
    host: NON_EMPTY_STRING.pipe(z.enum(LOOPBACK_HOST_VALUES)),
    port: z.number().int().min(0).max(65_535),
    codexExecutable: NON_EMPTY_STRING,
    expectedCodexVersion: NON_EMPTY_STRING,
    heartbeatIntervalMs: z.number().int().safe().positive()
  })
  .strict();

const configEntrySchema = z
  .object({
    version: z.literal(1),
    server: z.unknown().optional(),
    adapters: z.unknown().optional()
  })
  .strict();

const codexAdapterEntrySchema = z
  .object({
    runtime: explicitConfigReferenceSchema("adapters/codex"),
    projects: z.array(explicitConfigReferenceSchema("adapters/codex/projects")).min(1)
  })
  .strict();

const projectSchema = z
  .object({
    version: z.literal(1),
    projectId: STABLE_ID,
    workspace: RELATIVE_WORKSPACE,
    branch: NON_EMPTY_STRING,
    defaultModelId: NON_EMPTY_STRING
  })
  .strict();

export type CodexAdapterLocalConfig = {
  runtime: Omit<z.output<typeof adapterRuntimeSchema>, "version">;
  projects: Array<Omit<z.output<typeof projectSchema>, "version">>;
};

export async function loadCodexAdapterLocalConfig(
  { configRoot: configuredRoot }: { configRoot?: string } = {}
): Promise<CodexAdapterLocalConfig> {
  try {
    let configRoot = configuredRoot;
    if (configRoot === undefined) {
      const defaultHuanlinkRoot = join(process.cwd(), ".huanlink");
      await assertRegularDirectory(defaultHuanlinkRoot, ".huanlink");
      configRoot = join(defaultHuanlinkRoot, "config");
    }

    await assertRegularDirectory(configRoot, "configuration root");
    const entry = parseConfigFile(
      configEntrySchema,
      await readJsonObject(configRoot, "config.json"),
      "config.json",
      ENTRY_FIELD_NAMES
    );
    const adapters = parseConfigFile(
      z.object({ codex: z.unknown() }).strict(),
      entry.adapters,
      "config.json",
      ADAPTERS_FIELD_NAMES,
      "adapters"
    );
    const codexEntry = parseConfigFile(
      codexAdapterEntrySchema,
      adapters.codex,
      "config.json",
      CODEX_ENTRY_FIELD_NAMES,
      "adapters.codex"
    );
    ensureUniqueReferences(codexEntry.projects, "config.json", "adapters.codex.projects");

    const runtimeLocation = removeReferencePrefix(codexEntry.runtime);
    const parsedRuntime = parseConfigFile(
      adapterRuntimeSchema,
      await readJsonObject(configRoot, runtimeLocation),
      runtimeLocation,
      RUNTIME_FIELD_NAMES
    );
    const parsedProjects = await Promise.all(
      codexEntry.projects.map(async (reference) => {
        const location = removeReferencePrefix(reference);
        return {
          project: parseConfigFile(
            projectSchema,
            await readJsonObject(configRoot, location),
            location,
            PROJECT_FIELD_NAMES
          ),
          location
        };
      })
    );
    const projectIds = new Set<string>();
    for (const { project, location } of parsedProjects) {
      if (projectIds.has(project.projectId)) {
        throw invalidLocalConfig(location, "projectId");
      }
      projectIds.add(project.projectId);
    }

    const { version: _runtimeVersion, ...runtimeConfig } = parsedRuntime;
    return {
      runtime: runtimeConfig,
      projects: parsedProjects.map(({ project }) => {
        const { version: _projectVersion, ...projectConfig } = project;
        return projectConfig;
      })
    };
  } catch (error: unknown) {
    if (error instanceof LocalConfigError) {
      throw error;
    }
    throw invalidLocalConfig();
  }
}

export function parseHost(value: string): string {
  if (value.trim().length === 0 || !LOOPBACK_HOSTS.has(value)) {
    throw invalidHost(value);
  }

  return value;
}

export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw invalidPort(value);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) {
    throw invalidPort(value);
  }
  return parsed;
}

export function parseLogLevel(value: string): RuntimeLogLevel {
  if (!LOG_LEVELS.has(value as RuntimeLogLevel)) {
    throw new Error(`Invalid HUANLINK_LOG_LEVEL: ${value}`);
  }
  return value as RuntimeLogLevel;
}

function invalidPort(value: string): Error {
  return new Error(`Invalid HUANLINK_CODEX_A2A_PORT: ${value}`);
}

function invalidHost(value: string): Error {
  return new Error(`Invalid HUANLINK_CODEX_A2A_HOST: ${value}`);
}

async function assertRegularDirectory(path: string, location: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw invalidLocalConfig(location);
    }
  } catch (error: unknown) {
    if (error instanceof LocalConfigError) {
      throw error;
    }
    throw invalidLocalConfig(location);
  }
}

async function readJsonObject(
  configRoot: string,
  location: string
): Promise<Record<string, unknown>> {
  try {
    const segments = location.split("/");
    let currentPath = configRoot;
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment);
      const metadata = await lstat(currentPath);
      const isFinalSegment = index === segments.length - 1;
      if (
        metadata.isSymbolicLink() ||
        (isFinalSegment ? !metadata.isFile() : !metadata.isDirectory())
      ) {
        throw invalidLocalConfig(segments.slice(0, index + 1).join("/"));
      }
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(currentPath));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalidLocalConfig(location);
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof LocalConfigError) {
      throw error;
    }
    throw invalidLocalConfig(location);
  }
}

function parseConfigFile<T extends z.ZodType>(
  schema: T,
  contents: unknown,
  location: string,
  safeFieldNames: Set<string>,
  fieldPrefix?: string
): z.output<T> {
  const result = schema.safeParse(contents);
  if (result.success) {
    return result.data;
  }

  const fieldName = result.error.issues
    .map((issue) => issue.path[0])
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && safeFieldNames.has(candidate)
    );
  throw invalidLocalConfig(
    location,
    fieldName === undefined
      ? fieldPrefix
      : fieldPrefix === undefined
        ? fieldName
        : `${fieldPrefix}.${fieldName}`
  );
}

function explicitConfigReferenceSchema(prefix: string): z.ZodType<string> {
  return z.string().refine(
    (value) => isExplicitConfigReference(value, prefix),
    "must be an explicit configuration reference"
  );
}

function isExplicitConfigReference(value: string, prefix: string): boolean {
  if (!value.startsWith("./") || !value.endsWith(".json") || value.includes("\\")) {
    return false;
  }

  const relativePath = removeReferencePrefix(value);
  const segments = relativePath.split("/");
  return (
    relativePath.startsWith(`${prefix}/`) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function removeReferencePrefix(reference: string): string {
  return reference.slice(2);
}

function ensureUniqueReferences(
  references: readonly string[],
  location: string,
  fieldName: string
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference)) {
      throw invalidLocalConfig(location, fieldName);
    }
    seen.add(reference);
  }
}

function isRelativeWorkspace(value: string): boolean {
  if (value === ".") {
    return true;
  }
  if (value.includes("\\") || value.includes(":") || win32.isAbsolute(value) || posix.isAbsolute(value)) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

class LocalConfigError extends Error {}

function invalidLocalConfig(location?: string, fieldName?: string): LocalConfigError {
  const suffix =
    location === undefined ? "" : `: ${location}${fieldName === undefined ? "" : `: ${fieldName}`}`;
  return new LocalConfigError(`Invalid local Codex Adapter configuration${suffix}`);
}
