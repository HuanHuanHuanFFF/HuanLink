import {
  resolveRuntimeConfig,
  type RuntimeConfig,
  type RuntimeLogLevel
} from "@huanlink/core";
import { z } from "zod";

const RUNTIME_LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error"
] as const satisfies readonly RuntimeLogLevel[];

const runtimeConfigEnvSchema = z.object({
  HUANLINK_EVENT_LOG_BASE_DIR: z.string().trim().min(1).optional(),
  HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  HUANLINK_AGENT_DEFAULT_MAX_STEPS: z.coerce.number().int().positive().optional(),
  HUANLINK_LOG_LEVEL: z.enum(RUNTIME_LOG_LEVELS).optional()
});

const codexA2aRuntimeConfigEnvSchema = z.object({
  HUANLINK_CODEX_A2A_ORIGIN: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    }, "must use http or https")
    .default("http://127.0.0.1:4000"),
  HUANLINK_CODEX_A2A_SKILL_ID: z
    .string()
    .trim()
    .min(1)
    .default("codex-code-task")
});

const mainAgentModelRuntimeConfigEnvSchema = z.object({
  HUANLINK_MAIN_AGENT_PROVIDER: z.literal("deepseek").default("deepseek"),
  HUANLINK_MAIN_AGENT_MODEL: z
    .string()
    .trim()
    .min(1)
    .default("deepseek-v4-flash"),
  HUANLINK_DEEPSEEK_BASE_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "must use https")
    .default("https://api.deepseek.com/beta"),
  DEEPSEEK_API_KEY: z.string().trim().min(1)
});

const phase4QqRuntimeConfigEnvSchema = z.object({
  HUANLINK_ONEBOT_WS_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "ws:" || protocol === "wss:";
      } catch {
        return false;
      }
    }, "must use ws or wss")
    .default("ws://127.0.0.1:3001/"),
  HUANLINK_ONEBOT_ACCESS_TOKEN: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().trim().min(1).optional()
  ),
  HUANLINK_ONEBOT_GROUP_ID: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, "must be a positive integer string")
    .refine(
      (value) => Number.isSafeInteger(Number(value)),
      "must be a safe positive integer string"
    ),
  HUANLINK_ONEBOT_COMMAND_PREFIX: z
    .string()
    .trim()
    .min(1)
    .default("/huanlink")
});

export type CodexA2aRuntimeConfig = {
  origin: string;
  skillId: string;
};

export type OneBot11QqRuntimeConfig = {
  url: string;
  accessToken?: string;
  groupId: string;
  commandPrefix: string;
};

export type MainAgentModelConfig = {
  provider: "deepseek";
  modelId: string;
  baseURL: string;
  apiKey: string;
};

export type Phase4QqRuntimeConfig = {
  oneBot11: OneBot11QqRuntimeConfig;
  codexA2a: CodexA2aRuntimeConfig;
  mainAgentModel: MainAgentModelConfig;
};

// 启动时一次性读取环境变量，并映射成 core 可消费的 RuntimeConfig。
export function loadRuntimeConfigFromEnv(input: {
  envFilePath?: string;
} = {}): RuntimeConfig {
  loadEnvFile(input.envFilePath);

  const parsed = runtimeConfigEnvSchema.safeParse({
    HUANLINK_EVENT_LOG_BASE_DIR: process.env.HUANLINK_EVENT_LOG_BASE_DIR,
    HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE:
      process.env.HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE,
    HUANLINK_AGENT_DEFAULT_MAX_STEPS:
      process.env.HUANLINK_AGENT_DEFAULT_MAX_STEPS,
    HUANLINK_LOG_LEVEL: process.env.HUANLINK_LOG_LEVEL
  });

  if (!parsed.success) {
    throw new Error(formatEnvValidationError(parsed.error));
  }

  return resolveRuntimeConfig({
    eventLog: {
      baseDir: parsed.data.HUANLINK_EVENT_LOG_BASE_DIR,
      nextSeqCacheSize: parsed.data.HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE
    },
    agent: {
      defaultMaxSteps: parsed.data.HUANLINK_AGENT_DEFAULT_MAX_STEPS
    },
    logging: {
      level: parsed.data.HUANLINK_LOG_LEVEL
    }
  });
}

export function loadCodexA2aRuntimeConfigFromEnv(input: {
  envFilePath?: string;
} = {}): CodexA2aRuntimeConfig {
  loadEnvFile(input.envFilePath);
  return parseCodexA2aRuntimeConfigFromProcessEnv();
}

export function loadPhase4QqRuntimeConfigFromEnv(input: {
  envFilePath?: string;
} = {}): Phase4QqRuntimeConfig {
  loadEnvFile(input.envFilePath);
  const parsed = phase4QqRuntimeConfigEnvSchema.safeParse({
    HUANLINK_ONEBOT_WS_URL: process.env.HUANLINK_ONEBOT_WS_URL,
    HUANLINK_ONEBOT_ACCESS_TOKEN:
      process.env.HUANLINK_ONEBOT_ACCESS_TOKEN,
    HUANLINK_ONEBOT_GROUP_ID: process.env.HUANLINK_ONEBOT_GROUP_ID,
    HUANLINK_ONEBOT_COMMAND_PREFIX:
      process.env.HUANLINK_ONEBOT_COMMAND_PREFIX
  });

  if (!parsed.success) {
    throw new Error(formatEnvValidationError(parsed.error));
  }

  return {
    oneBot11: {
      url: parsed.data.HUANLINK_ONEBOT_WS_URL,
      ...(parsed.data.HUANLINK_ONEBOT_ACCESS_TOKEN === undefined
        ? {}
        : { accessToken: parsed.data.HUANLINK_ONEBOT_ACCESS_TOKEN }),
      groupId: parsed.data.HUANLINK_ONEBOT_GROUP_ID,
      commandPrefix: parsed.data.HUANLINK_ONEBOT_COMMAND_PREFIX
    },
    codexA2a: parseCodexA2aRuntimeConfigFromProcessEnv(),
    mainAgentModel: parseMainAgentModelConfigFromProcessEnv()
  };
}

function parseCodexA2aRuntimeConfigFromProcessEnv(): CodexA2aRuntimeConfig {
  const parsed = codexA2aRuntimeConfigEnvSchema.safeParse({
    HUANLINK_CODEX_A2A_ORIGIN: process.env.HUANLINK_CODEX_A2A_ORIGIN,
    HUANLINK_CODEX_A2A_SKILL_ID: process.env.HUANLINK_CODEX_A2A_SKILL_ID
  });

  if (!parsed.success) {
    throw new Error(formatEnvValidationError(parsed.error));
  }

  return {
    origin: parsed.data.HUANLINK_CODEX_A2A_ORIGIN,
    skillId: parsed.data.HUANLINK_CODEX_A2A_SKILL_ID
  };
}

function parseMainAgentModelConfigFromProcessEnv(): MainAgentModelConfig {
  const parsed = mainAgentModelRuntimeConfigEnvSchema.safeParse({
    HUANLINK_MAIN_AGENT_PROVIDER:
      process.env.HUANLINK_MAIN_AGENT_PROVIDER,
    HUANLINK_MAIN_AGENT_MODEL: process.env.HUANLINK_MAIN_AGENT_MODEL,
    HUANLINK_DEEPSEEK_BASE_URL:
      process.env.HUANLINK_DEEPSEEK_BASE_URL,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY
  });

  if (!parsed.success) {
    throw new Error(formatEnvValidationError(parsed.error));
  }

  return {
    provider: parsed.data.HUANLINK_MAIN_AGENT_PROVIDER,
    modelId: parsed.data.HUANLINK_MAIN_AGENT_MODEL,
    baseURL: parsed.data.HUANLINK_DEEPSEEK_BASE_URL,
    apiKey: parsed.data.DEEPSEEK_API_KEY
  };
}

// 默认读取 cwd 下的 .env；文件缺失时沿用进程环境和 core 默认值。
function loadEnvFile(envFilePath?: string): void {
  try {
    if (envFilePath === undefined) {
      process.loadEnvFile();
      return;
    }

    process.loadEnvFile(envFilePath);
  } catch (error) {
    if (envFilePath === undefined && isMissingEnvFileError(error)) {
      return;
    }

    throw error;
  }
}

function isMissingEnvFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// 把 Zod 的字段级错误整理成启动期更易读的一行报错。
function formatEnvValidationError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  return `Invalid runtime environment configuration: ${details}`;
}
