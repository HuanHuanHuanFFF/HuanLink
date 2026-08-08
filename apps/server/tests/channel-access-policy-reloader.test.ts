import { Buffer } from "node:buffer";

import { describe, expect, test, vi } from "vitest";

import {
  createChannelAccessPolicyReloader,
  type ChannelAccessPolicyWatchFactory
} from "../src/channel-access-policy-reloader.js";
import type { ServerChannelRuntimeConfig } from "../src/local-user-config.js";
import { RecordingRuntimeLogger } from "./support/recording-runtime-logger.js";

describe("Channel access policy reloader", () => {
  test("recursively watches configRoot and atomically applies only the refreshed policies", async () => {
    const initialConfig = config();
    const nextConfig = config({
      groups: { mode: "allowlist", ids: ["30003000"] },
      directs: { mode: "allowlist", ids: ["40004000"] }
    });
    const watch = new FakeWatchFactory();
    const applyPolicies = vi.fn();
    const loadConfig = vi.fn(async () => nextConfig);
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig,
      loadConfig,
      applyPolicies,
      watchFactory: watch.create,
      debounceMs: 200
    });

    initialConfig.mainAgent!.modelId = "mutated-by-caller";
    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(250);

    expect(watch.paths).toEqual(["C:/config-root"]);
    expect(watch.options).toEqual([{ recursive: true }]);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(applyPolicies).toHaveBeenCalledTimes(1);
    expect(applyPolicies).toHaveBeenCalledWith(
      new Map([
        [
          "qq-main",
          {
            groups: { mode: "allowlist", ids: ["30003000"] },
            directs: { mode: "allowlist", ids: ["40004000"] }
          }
        ]
      ])
    );

    await reloader.close();
  });

  test("rejects restart-required changes and configuration failures without disclosing values", async () => {
    const logger = new RecordingRuntimeLogger();
    const watch = new FakeWatchFactory();
    const applyPolicies = vi.fn();
    const changedUrl = config({ url: "ws://user:token@127.0.0.1:3001/?secret=url-secret" });
    const invalidError = new Error("invalid config includes 30003000 and token=error-secret");
    const loadConfig = vi
      .fn<() => Promise<ServerChannelRuntimeConfig>>()
      .mockResolvedValueOnce(changedUrl)
      .mockRejectedValueOnce(invalidError);
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig: config(),
      loadConfig,
      applyPolicies,
      watchFactory: watch.create,
      logger,
      debounceMs: 5
    });

    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(30);
    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(30);

    expect(applyPolicies).not.toHaveBeenCalled();
    expect(logger.find("channel.access_policy.reload_rejected")).toMatchObject({
      level: "warn",
      fields: { reason: "restart_required" }
    });
    expect(logger.find("channel.access_policy.reload_failed")).toMatchObject({
      level: "warn",
      fields: { reason: "invalid_configuration" }
    });
    const logs = JSON.stringify(logger.entries);
    for (const secret of ["30003000", "url-secret", "error-secret", "token"]) {
      expect(logs).not.toContain(secret);
    }

    await reloader.close();
  });

  test("rejects Agent configuration changes instead of mixing them with a new policy", async () => {
    const logger = new RecordingRuntimeLogger();
    const watch = new FakeWatchFactory();
    const candidate = config({ groups: { mode: "denylist", ids: [] } });
    candidate.agents[0]!.displayName = "Changed Agent";
    const applyPolicies = vi.fn();
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig: config(),
      loadConfig: async () => candidate,
      applyPolicies,
      watchFactory: watch.create,
      logger,
      debounceMs: 5
    });

    watch.watcher.emitChange("server/agents/codex-local.json");
    await wait(30);

    expect(applyPolicies).not.toHaveBeenCalled();
    expect(logger.find("channel.access_policy.reload_rejected")).toMatchObject({
      fields: { reason: "restart_required" }
    });
    await reloader.close();
  });

  test("rejects a changed Channel source reference even when only the policy value differs", async () => {
    const logger = new RecordingRuntimeLogger();
    const watch = new FakeWatchFactory();
    const candidate = config({ groups: { mode: "denylist", ids: [] } });
    candidate.sources.channels[0] = "server/channels/alternate.json";
    const applyPolicies = vi.fn();
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig: config(),
      loadConfig: async () => candidate,
      applyPolicies,
      watchFactory: watch.create,
      logger,
      debounceMs: 5
    });

    watch.watcher.emitChange("config.json");
    await wait(30);

    expect(applyPolicies).not.toHaveBeenCalled();
    expect(logger.find("channel.access_policy.reload_rejected")).toMatchObject({
      fields: { reason: "restart_required" }
    });
    await reloader.close();
  });

  test("debounces bursts, serializes reloads, and schedules an event received while loading", async () => {
    const watch = new FakeWatchFactory();
    const first = deferred<ServerChannelRuntimeConfig>();
    const second = deferred<ServerChannelRuntimeConfig>();
    const loadConfig = vi.fn<() => Promise<ServerChannelRuntimeConfig>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const applyPolicies = vi.fn();
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig: config(),
      loadConfig,
      applyPolicies,
      watchFactory: watch.create,
      debounceMs: 5
    });

    watch.watcher.emitChange("server/channels/onebot11.json");
    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(20);
    expect(loadConfig).toHaveBeenCalledTimes(1);

    watch.watcher.emitChange("server/channels/onebot11.json");
    first.resolve(config({ groups: { mode: "allowlist", ids: ["30003000"] } }));
    await wait(20);
    expect(applyPolicies).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledTimes(2);

    second.resolve(config({ groups: { mode: "allowlist", ids: ["50005000"] } }));
    await wait(20);
    expect(applyPolicies).toHaveBeenCalledTimes(1);
    expect(applyPolicies).toHaveBeenLastCalledWith(
      new Map([
        [
          "qq-main",
          {
            groups: { mode: "allowlist", ids: ["50005000"] },
            directs: { mode: "denylist", ids: [] }
          }
        ]
      ])
    );

    await reloader.close();
  });

  test.each(["restart-required", "invalid"] as const)(
    "never applies a stale policy when the newer save is %s",
    async (newerSave) => {
      const logger = new RecordingRuntimeLogger();
      const watch = new FakeWatchFactory();
      const staleLoad = deferred<ServerChannelRuntimeConfig>();
      const loadConfig = vi
        .fn<() => Promise<ServerChannelRuntimeConfig>>()
        .mockImplementationOnce(() => staleLoad.promise)
        .mockImplementationOnce(() =>
          newerSave === "restart-required"
            ? Promise.resolve(config({ url: "ws://127.0.0.1:4001/" }))
            : Promise.reject(new Error("newer file is invalid"))
        );
      const applyPolicies = vi.fn();
      const reloader = createChannelAccessPolicyReloader({
        configRoot: "C:/config-root",
        initialConfig: config(),
        loadConfig,
        applyPolicies,
        watchFactory: watch.create,
        logger,
        debounceMs: 5
      });

      watch.watcher.emitChange("server/channels/onebot11.json");
      await wait(20);
      watch.watcher.emitChange("server/channels/onebot11.json");
      staleLoad.resolve(
        config({ groups: { mode: "denylist", ids: [] } })
      );

      await wait(30);
      expect(loadConfig).toHaveBeenCalledTimes(2);
      expect(applyPolicies).not.toHaveBeenCalled();
      expect(
        logger.find(
          newerSave === "restart-required"
            ? "channel.access_policy.reload_rejected"
            : "channel.access_policy.reload_failed"
        )
      ).toBeDefined();

      await reloader.close();
    }
  );

  test("keeps watching after watcher errors and close prevents queued or in-flight applications", async () => {
    const logger = new RecordingRuntimeLogger();
    const watch = new FakeWatchFactory();
    const inFlight = deferred<ServerChannelRuntimeConfig>();
    const loadConfig = vi.fn<() => Promise<ServerChannelRuntimeConfig>>()
      .mockImplementationOnce(() => inFlight.promise)
      .mockResolvedValueOnce(config({ groups: { mode: "allowlist", ids: ["30003000"] } }));
    const applyPolicies = vi.fn();
    const reloader = createChannelAccessPolicyReloader({
      configRoot: "C:/config-root",
      initialConfig: config(),
      loadConfig,
      applyPolicies,
      watchFactory: watch.create,
      logger,
      debounceMs: 5
    });

    watch.watcher.emitError(new Error("watch error contains token=watch-secret"));
    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(20);
    expect(loadConfig).toHaveBeenCalledTimes(1);

    const close = reloader.close();
    await expect(
      Promise.race([
        close.then(() => "closed"),
        wait(50).then(() => "timeout")
      ])
    ).resolves.toBe("closed");
    inFlight.resolve(config({ groups: { mode: "allowlist", ids: ["30003000"] } }));
    await close;
    watch.watcher.emitChange("server/channels/onebot11.json");
    await wait(20);

    expect(watch.watcher.close).toHaveBeenCalledTimes(1);
    expect(applyPolicies).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(logger.find("channel.access_policy.watcher_failed")).toMatchObject({
      level: "warn",
      fields: { reason: "watcher_error" }
    });
    expect(JSON.stringify(logger.entries)).not.toContain("watch-secret");
  });
});

class FakeWatchFactory {
  readonly watcher = new FakeWatcher();
  readonly paths: string[] = [];
  readonly options: Array<{ recursive: boolean }> = [];

  readonly create: ChannelAccessPolicyWatchFactory = (path, options, listener) => {
    this.paths.push(path);
    this.options.push(options);
    this.watcher.listener = listener;
    return this.watcher;
  };
}

class FakeWatcher {
  listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  readonly close = vi.fn();
  private readonly errorListeners = new Set<(error: Error) => void>();

  on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") {
      this.errorListeners.add(listener);
    }
    return this;
  }

  emitChange(filename: string): void {
    this.listener?.("change", filename);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function config(
  policyOrOther: Partial<ServerChannelRuntimeConfig["channels"][number]["inboundPolicy"]> & {
    url?: string;
  } = {}
): ServerChannelRuntimeConfig {
  return {
    mainAgent: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com/beta",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    },
    channels: [
      {
        channelId: "qq-main",
        type: "onebot11-forward-websocket",
        url: policyOrOther.url ?? "ws://127.0.0.1:3001/",
        inboundPolicy: {
          groups: policyOrOther.groups ?? { mode: "allowlist", ids: ["20002000"] },
          directs: policyOrOther.directs ?? { mode: "denylist", ids: [] }
        },
        enableUnsafePrivilegedOperations: false,
        accessToken: "onebot-secret"
      }
    ],
    agents: [
      {
        agentId: "codex-local",
        displayName: "Codex Local",
        transport: "a2a",
        origin: "http://127.0.0.1:4000",
        skillId: "codex-code-task",
        enabled: true
      }
    ],
    sources: {
      mainAgent: "server/main-agent.json",
      channels: ["server/channels/onebot11.json"],
      agents: ["server/agents/codex-local.json"]
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => {
      resolve = complete;
    }),
    resolve(value) {
      resolve(value);
    }
  };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
