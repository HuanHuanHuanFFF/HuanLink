import { lstat, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
const RUNTIME_FIELD_NAMES = new Set([
  "version",
  "host",
  "port",
  "codexExecutable",
  "expectedCodexVersion",
  "heartbeatIntervalMs"
]);
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

const projectSchema = z
  .object({
    version: z.literal(1),
    projectId: STABLE_ID,
    workspace: NON_EMPTY_STRING.refine(
      (value) => win32.isAbsolute(value) || posix.isAbsolute(value)
    ),
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

    const adapterRoot = join(configRoot, "codex-adapter");
    await assertRegularDirectory(configRoot, "configuration root");
    await assertRegularDirectory(adapterRoot, "codex-adapter");

    const runtimeLocation = "codex-adapter/runtime.json";
    const runtime = await readJsonObject(join(adapterRoot, "runtime.json"), runtimeLocation);
    const projectsDirectory = join(adapterRoot, "projects");
    await assertRegularDirectory(projectsDirectory, "codex-adapter/projects");
    const projectPaths = await readProjectPaths(projectsDirectory);
    if (projectPaths.length === 0) {
      throw invalidLocalConfig("codex-adapter/projects");
    }

    const parsedRuntime = parseConfigFile(
      adapterRuntimeSchema,
      runtime,
      runtimeLocation,
      RUNTIME_FIELD_NAMES
    );
    const parsedProjects = projectPaths.map(({ contents, location }) => ({
      project: parseConfigFile(projectSchema, contents, location, PROJECT_FIELD_NAMES),
      location
    }));
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

async function readProjectPaths(
  projectsDirectory: string
): Promise<Array<{ contents: Record<string, unknown>; location: string }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDirectory, { withFileTypes: true });
  } catch {
    throw invalidLocalConfig("codex-adapter/projects");
  }
  const jsonNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    jsonNames.map(async (name) => ({
      contents: await readJsonObject(
        join(projectsDirectory, name),
        `codex-adapter/projects/${name}`
      ),
      location: `codex-adapter/projects/${name}`
    }))
  );
}

async function readJsonObject(
  path: string,
  location: string
): Promise<Record<string, unknown>> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw invalidLocalConfig(location);
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
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
  contents: Record<string, unknown>,
  location: string,
  safeFieldNames: Set<string>
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
  throw invalidLocalConfig(location, fieldName);
}

class LocalConfigError extends Error {}

function invalidLocalConfig(location?: string, fieldName?: string): LocalConfigError {
  const suffix =
    location === undefined ? "" : `: ${location}${fieldName === undefined ? "" : `: ${fieldName}`}`;
  return new LocalConfigError(`Invalid local Codex Adapter configuration${suffix}`);
}
