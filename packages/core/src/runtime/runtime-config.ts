import type { RuntimeLogLevel } from "../logging/types.js";

export type RuntimeConfig = {
  readonly eventLog: {
    readonly baseDir: string;
    readonly nextSeqCacheSize: number;
  };
  readonly logging: {
    readonly level: RuntimeLogLevel;
  };
};

export type RuntimeConfigInput = {
  readonly eventLog?: Partial<RuntimeConfig["eventLog"]>;
  readonly logging?: Partial<RuntimeConfig["logging"]>;
};

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = freezeRuntimeConfig({
  eventLog: {
    baseDir: ".huanlink",
    nextSeqCacheSize: 256
  },
  logging: {
    level: "info"
  }
});

export function getDefaultRuntimeConfig(): RuntimeConfig {
  return cloneRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
}

export function resolveRuntimeConfig(
  input: RuntimeConfigInput = {}
): RuntimeConfig {
  return {
    eventLog: {
      baseDir: input.eventLog?.baseDir ?? DEFAULT_RUNTIME_CONFIG.eventLog.baseDir,
      nextSeqCacheSize:
        input.eventLog?.nextSeqCacheSize ??
        DEFAULT_RUNTIME_CONFIG.eventLog.nextSeqCacheSize
    },
    logging: {
      level: input.logging?.level ?? DEFAULT_RUNTIME_CONFIG.logging.level
    }
  };
}

function cloneRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    eventLog: {
      baseDir: config.eventLog.baseDir,
      nextSeqCacheSize: config.eventLog.nextSeqCacheSize
    },
    logging: {
      level: config.logging.level
    }
  };
}

function freezeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  Object.freeze(config.eventLog);
  Object.freeze(config.logging);
  return Object.freeze(config);
}
