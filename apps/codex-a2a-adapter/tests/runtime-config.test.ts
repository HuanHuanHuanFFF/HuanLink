import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  loadCodexAdapterLocalConfig,
  parseHost,
  parseLogLevel,
  parsePort
} from "../src/runtime-config.js";

const loadLocalConfig = loadCodexAdapterLocalConfig;

const validRuntime = {
  version: 1,
  host: "127.0.0.1",
  port: 4000,
  codexExecutable: "codex.cmd",
  expectedCodexVersion: "0.144.1",
  heartbeatIntervalMs: 30_000
};

const validProject = {
  version: 1,
  projectId: "huanlink",
  workspace: "D:\\CodingProject\\HuanLink",
  branch: "dev/v1.0",
  defaultModelId: "gpt-5.4-mini"
};

async function withConfigRoot(
  arrange: (configRoot: string) => Promise<void>,
  run: (configRoot: string) => Promise<void>
) {
  const sandbox = await mkdtemp(join(tmpdir(), "huanlink-codex-config-"));
  const configRoot = join(sandbox, "config");
  await mkdir(join(configRoot, "codex-adapter", "projects"), { recursive: true });
  await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), validRuntime);
  await writeConfigFile(
    join(configRoot, "codex-adapter", "projects", "huanlink.json"),
    validProject
  );

  try {
    await arrange(configRoot);
    await run(configRoot);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function writeConfigFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

function expectInvalidConfig(promise: Promise<unknown>) {
  return expect(promise).rejects.toThrow("Invalid local Codex Adapter configuration");
}

async function tryCreateLink(target: string, path: string, type: "file" | "junction") {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  }
}

describe("adapter runtime config", () => {
  it.each(["127.0.0.1", "localhost", "::1"])(
    "parses loopback host %s",
    (value) => {
      expect(parseHost(value)).toBe(value);
    }
  );

  it.each(["", " ", "\t", "0.0.0.0", "127.0.0.2", "example.com", " localhost "])(
    "rejects invalid host %s",
    (value) => {
      expect(() => parseHost(value)).toThrow(
        `Invalid HUANLINK_CODEX_A2A_HOST: ${value}`
      );
    }
  );

  it.each([
    ["0", 0],
    ["4000", 4000],
    ["65535", 65_535]
  ])("parses port %s", (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });

  it.each(["", "-1", "1.5", "4000abc", "65536"])(
    "rejects invalid port %s",
    (value) => {
      expect(() => parsePort(value)).toThrow(
        `Invalid HUANLINK_CODEX_A2A_PORT: ${value}`
      );
    }
  );

  it.each(["debug", "info", "warn", "error"] as const)(
    "parses log level %s",
    (value) => {
      expect(parseLogLevel(value)).toBe(value);
    }
  );

  it.each(["", "trace", "INFO"])("rejects invalid log level %s", (value) => {
    expect(() => parseLogLevel(value)).toThrow(
      `Invalid HUANLINK_LOG_LEVEL: ${value}`
    );
  });
});

describe("local Codex Adapter configuration", () => {
  it("loads the tracked example configuration", async () => {
    const config = await loadLocalConfig({
      configRoot: fileURLToPath(new URL("../../../configs/examples/", import.meta.url))
    });

    expect(config).toEqual({
      runtime: {
        host: "127.0.0.1",
        port: 4000,
        codexExecutable: "codex.cmd",
        expectedCodexVersion: "0.144.1",
        heartbeatIntervalMs: 30_000
      },
      projects: [
        {
          projectId: "huanlink",
          workspace: "D:\\CodingProject\\HuanLink",
          branch: "dev/v1.0",
          defaultModelId: "gpt-5.4-mini"
        }
      ]
    });
  });

  it("uses the injected configuration root", async () => {
    await withConfigRoot(async () => {}, async (configRoot) => {
      await expect(loadLocalConfig({ configRoot })).resolves.toMatchObject({
        runtime: { port: 4000 },
        projects: [{ projectId: "huanlink" }]
      });
    });
  });

  it("defaults to the current working directory configuration root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "huanlink-codex-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(sandbox);
    const configRoot = join(sandbox, ".huanlink", "config");
    try {
      await mkdir(join(configRoot, "codex-adapter", "projects"), { recursive: true });
      await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), validRuntime);
      await writeConfigFile(
        join(configRoot, "codex-adapter", "projects", "huanlink.json"),
        validProject
      );
      await expect(loadLocalConfig()).resolves.toMatchObject({
        projects: [{ projectId: "huanlink" }]
      });
    } finally {
      cwdSpy.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a junctioned .huanlink directory for the default configuration root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "huanlink-codex-cwd-junction-"));
    const cwd = join(sandbox, "cwd");
    const huanlinkTarget = join(sandbox, "external-huanlink");
    const configRoot = join(huanlinkTarget, "config");
    await mkdir(cwd);
    await mkdir(join(configRoot, "codex-adapter", "projects"), { recursive: true });
    await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), validRuntime);
    await writeConfigFile(
      join(configRoot, "codex-adapter", "projects", "huanlink.json"),
      validProject
    );
    await symlink(huanlinkTarget, join(cwd, ".huanlink"), "junction");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      await expect(loadLocalConfig()).rejects.toThrow(
        "Invalid local Codex Adapter configuration: .huanlink"
      );
    } finally {
      cwdSpy.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing configuration root", async (root: string) => rm(root, { recursive: true })],
    [
      "missing codex adapter directory",
      async (root: string) => rm(join(root, "codex-adapter"), { recursive: true })
    ],
    ["missing runtime file", async (root: string) => rm(join(root, "codex-adapter", "runtime.json"))],
    ["missing projects directory", async (root: string) => rm(join(root, "codex-adapter", "projects"), { recursive: true })],
    [
      "empty projects directory",
      async (root: string) => rm(join(root, "codex-adapter", "projects", "huanlink.json"))
    ]
  ])("rejects a %s", async (_name, arrange) => {
    await withConfigRoot(arrange, async (configRoot) => {
      await expectInvalidConfig(loadLocalConfig({ configRoot }));
    });
  });

  it.each([
    ["damaged JSON", "{ \"projectId\": "],
    ["a non-object JSON value", "[]"]
  ])("rejects %s", async (_name, contents) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(join(configRoot, "codex-adapter", "runtime.json"), contents);
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("rejects invalid UTF-8", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(
          join(configRoot, "codex-adapter", "runtime.json"),
          Buffer.from([0xc3, 0x28])
        );
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("rejects unknown fields", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          unexpected: true
        });
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("accepts inclusive port and heartbeat boundaries", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          port: 0,
          heartbeatIntervalMs: 1
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).resolves.toMatchObject({
          runtime: { port: 0, heartbeatIntervalMs: 1 }
        });
      }
    );
  });

  it("trims supported string fields before returning them", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          host: " localhost ",
          codexExecutable: " codex.cmd ",
          expectedCodexVersion: " 0.144.1 "
        });
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "huanlink.json"), {
          ...validProject,
          projectId: " huanlink ",
          workspace: " D:\\CodingProject\\HuanLink ",
          branch: " dev/v1.0 ",
          defaultModelId: " gpt-5.4-mini "
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).resolves.toEqual({
          runtime: {
            host: "localhost",
            port: 4000,
            codexExecutable: "codex.cmd",
            expectedCodexVersion: "0.144.1",
            heartbeatIntervalMs: 30_000
          },
          projects: [
            {
              projectId: "huanlink",
              workspace: "D:\\CodingProject\\HuanLink",
              branch: "dev/v1.0",
              defaultModelId: "gpt-5.4-mini"
            }
          ]
        });
      }
    );
  });

  it.each([
    ["port below zero", { port: -1 }],
    ["port above 65535", { port: 65_536 }],
    ["non-integer port", { port: 1.5 }],
    ["zero heartbeat", { heartbeatIntervalMs: 0 }],
    ["non-integer heartbeat", { heartbeatIntervalMs: 1.5 }],
    ["unsafe heartbeat", { heartbeatIntervalMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["non-loopback host", { host: "0.0.0.0" }]
  ])("rejects %s", async (_name, override) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          ...override
        });
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it.each([
    ["an empty string", ""],
    ["whitespace-only string", " \t "]
  ])("rejects %s fields", async (_name, emptyValue) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          codexExecutable: emptyValue
        });
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it.each([
    ["runtime version", "runtime.json", { ...validRuntime, version: 2 }],
    ["project version", "projects/huanlink.json", { ...validProject, version: 2 }],
    [
      "project unknown field",
      "projects/huanlink.json",
      { ...validProject, unexpected: true }
    ],
    [
      "empty expected Codex version",
      "runtime.json",
      { ...validRuntime, expectedCodexVersion: " \t" }
    ],
    ["empty project branch", "projects/huanlink.json", { ...validProject, branch: " " }],
    [
      "empty project default model",
      "projects/huanlink.json",
      { ...validProject, defaultModelId: "" }
    ]
  ])("rejects %s", async (_name, relativePath, value) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", relativePath), value);
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("reports the duplicate project file without disclosing the project ID", async () => {
    const projectId = "do-not-disclose-duplicate-project-id";
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "a.json"), {
          ...validProject,
          projectId
        });
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "z-duplicate.json"), {
          ...validProject,
          projectId
        });
        await rm(join(configRoot, "codex-adapter", "projects", "huanlink.json"));
      },
      async (configRoot) => {
        const promise = loadLocalConfig({ configRoot });
        await expect(promise).rejects.toThrow(
          "codex-adapter/projects/z-duplicate.json: projectId"
        );
        await expect(promise).rejects.not.toThrow(projectId);
        await expect(promise).rejects.not.toThrow(configRoot);
      }
    );
  });

  it("rejects an invalid project ID", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "invalid.json"), {
          ...validProject,
          projectId: "not valid"
        });
        await rm(join(configRoot, "codex-adapter", "projects", "huanlink.json"));
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("requires an absolute Windows or POSIX project workspace", async () => {
    for (const workspace of ["relative/workspace", "C:relative", "", " "]) {
      await withConfigRoot(
        async (configRoot) => {
          await writeConfigFile(join(configRoot, "codex-adapter", "projects", "huanlink.json"), {
            ...validProject,
            workspace
          });
        },
        async (configRoot) => {
          await expectInvalidConfig(loadLocalConfig({ configRoot }));
        }
      );
    }
  });

  it("accepts a POSIX absolute project workspace", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "huanlink.json"), {
          ...validProject,
          workspace: "/work/huanlink"
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).resolves.toMatchObject({
          projects: [{ workspace: "/work/huanlink" }]
        });
      }
    );
  });

  it.each([
    ["damaged JSON", "{ \"projectId\": "],
    ["a non-object JSON value", "[]"],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])]
  ])("rejects a project file with %s", async (_name, contents) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(join(configRoot, "codex-adapter", "projects", "huanlink.json"), contents);
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("returns project files in lexical filename order and ignores nested files", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "a.json"), {
          ...validProject,
          projectId: "a"
        });
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "z.json"), {
          ...validProject,
          projectId: "z"
        });
        await writeConfigFile(join(configRoot, "codex-adapter", "projects", "nested", "ignored.json"), {
          ...validProject,
          projectId: "nested"
        });
        await writeFile(join(configRoot, "codex-adapter", "projects", "ignored.txt"), "ignored");
      },
      async (configRoot) => {
        const config = await loadLocalConfig({ configRoot });
        expect(config.projects.map((project) => project.projectId)).toEqual([
          "a",
          "huanlink",
          "z"
        ]);
      }
    );
  });

  it("does not disclose configuration values when validation fails", async () => {
    const secretMarker = "do-not-disclose-codex-adapter-value";
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          codexExecutable: secretMarker,
          unexpected: secretMarker
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.not.toThrow(secretMarker);
      }
    );
  });

  it("reports only the safe relative file location on a file validation error", async () => {
    const secretMarker = "do-not-disclose-file-content";
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          unexpected: secretMarker
        });
      },
      async (configRoot) => {
        const promise = loadLocalConfig({ configRoot });
        await expect(promise).rejects.toThrow("codex-adapter/runtime.json");
        await expect(promise).rejects.not.toThrow(secretMarker);
        await expect(promise).rejects.not.toThrow(configRoot);
      }
    );
  });

  it("reports a safe field name for schema validation errors", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(join(configRoot, "codex-adapter", "runtime.json"), {
          ...validRuntime,
          heartbeatIntervalMs: 0
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow(
          "codex-adapter/runtime.json: heartbeatIntervalMs"
        );
      }
    );
  });

  it("rejects a symlinked runtime file", async (context) => {
    await withConfigRoot(
      async (configRoot) => {
        const runtimePath = join(configRoot, "codex-adapter", "runtime.json");
        const targetPath = join(configRoot, "runtime-target.json");
        await writeFile(targetPath, await readFile(runtimePath));
        await rm(runtimePath);
        if (!(await tryCreateLink(targetPath, runtimePath, "file"))) {
          context.skip();
        }
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("rejects a junctioned projects directory", async (context) => {
    await withConfigRoot(
      async (configRoot) => {
        const projectsPath = join(configRoot, "codex-adapter", "projects");
        const targetPath = join(configRoot, "projects-target");
        await rename(projectsPath, targetPath);
        if (!(await tryCreateLink(targetPath, projectsPath, "junction"))) {
          context.skip();
        }
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });
});
