import {
  resolveRuntimeConfig,
  type RuntimeConfig,
  type RuntimeLogLevel
} from "@huanlink/core";
import { z } from "zod";

const RUNTIME_LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly RuntimeLogLevel[];

const runtimeConfigEnvSchema = z.object({
  HUANLINK_EVENT_LOG_BASE_DIR: z.string().trim().min(1).optional(),
  HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE: z.coerce.number().int().positive().optional(),
  HUANLINK_AGENT_DEFAULT_MAX_STEPS: z.coerce.number().int().positive().optional(),
  HUANLINK_LOG_LEVEL: z.enum(RUNTIME_LOG_LEVELS).optional()
});

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
