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
  workspace: ".",
  branch: "dev/v1.0",
  defaultModelId: "gpt-5.4-mini"
};

const expectedRuntime = {
  host: validRuntime.host,
  port: validRuntime.port,
  codexExecutable: validRuntime.codexExecutable,
  expectedCodexVersion: validRuntime.expectedCodexVersion,
  heartbeatIntervalMs: validRuntime.heartbeatIntervalMs
};

const expectedProject = {
  projectId: validProject.projectId,
  workspace: validProject.workspace,
  branch: validProject.branch,
  defaultModelId: validProject.defaultModelId
};

const validEntry = {
  version: 1,
  adapters: {
    codex: {
      runtime: "./adapters/codex/runtime.json",
      projects: ["./adapters/codex/projects/huanlink.json"]
    }
  }
};

const codexConfigDirectory = ["adapters", "codex"];

async function withConfigRoot(
  arrange: (configRoot: string) => Promise<void>,
  run: (configRoot: string) => Promise<void>
) {
  const sandbox = await mkdtemp(join(tmpdir(), "huanlink-codex-config-"));
  const configRoot = join(sandbox, "config");
  await mkdir(join(configRoot, ...codexConfigDirectory, "projects"), { recursive: true });
  await writeConfigFile(join(configRoot, "config.json"), validEntry);
  await writeConfigFile(join(configRoot, ...codexConfigDirectory, "runtime.json"), validRuntime);
  await writeConfigFile(
    join(configRoot, ...codexConfigDirectory, "projects", "huanlink.json"),
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

async function writeEntry(configRoot: string, entry: unknown): Promise<void> {
  await writeConfigFile(join(configRoot, "config.json"), entry);
}

function codexPath(configRoot: string, ...segments: string[]): string {
  return join(configRoot, ...codexConfigDirectory, ...segments);
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
  it("loads the repository's single tracked configuration tree", async () => {
    const config = await loadLocalConfig({
      configRoot: fileURLToPath(new URL("../../../.huanlink/config/", import.meta.url))
    });

    expect(config).toEqual({
      runtime: expectedRuntime,
      projects: [expectedProject]
    });
  });

  it("loads only the files explicitly declared by config.json", async () => {
    await withConfigRoot(async () => {}, async (configRoot) => {
      await writeConfigFile(codexPath(configRoot, "projects", "ignored.json"), {
        ...validProject,
        projectId: "ignored"
      });
      await writeConfigFile(codexPath(configRoot, "nested", "ignored.json"), {
        unexpected: true
      });

      await expect(loadLocalConfig({ configRoot })).resolves.toEqual({
        runtime: expectedRuntime,
        projects: [expectedProject]
      });
    });
  });

  it("defaults to the current working directory configuration root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "huanlink-codex-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(sandbox);
    const configRoot = join(sandbox, ".huanlink", "config");
    try {
      await mkdir(codexPath(configRoot, "projects"), { recursive: true });
      await writeConfigFile(join(configRoot, "config.json"), validEntry);
      await writeConfigFile(codexPath(configRoot, "runtime.json"), validRuntime);
      await writeConfigFile(
        codexPath(configRoot, "projects", "huanlink.json"),
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
    await mkdir(codexPath(configRoot, "projects"), { recursive: true });
    await writeConfigFile(join(configRoot, "config.json"), validEntry);
    await writeConfigFile(codexPath(configRoot, "runtime.json"), validRuntime);
    await writeConfigFile(
      codexPath(configRoot, "projects", "huanlink.json"),
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
    ["missing config entry", async (root: string) => rm(join(root, "config.json"))],
    [
      "missing adapter directory",
      async (root: string) => rm(codexPath(root), { recursive: true })
    ],
    ["missing runtime file", async (root: string) => rm(codexPath(root, "runtime.json"))],
    ["missing projects directory", async (root: string) => rm(codexPath(root, "projects"), { recursive: true })],
    [
      "empty projects directory",
      async (root: string) => rm(codexPath(root, "projects", "huanlink.json"))
    ]
  ])("rejects a %s", async (_name, arrange) => {
    await withConfigRoot(arrange, async (configRoot) => {
      await expectInvalidConfig(loadLocalConfig({ configRoot }));
    });
  });

  it.each([
    ["damaged entry JSON", "{ \"adapters\": "],
    ["non-object entry JSON", "[]"]
  ])("rejects %s", async (_name, contents) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(join(configRoot, "config.json"), contents);
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow("config.json");
      }
    );
  });

  it.each([
    ["an unknown top-level field", { ...validEntry, unexpected: true }],
    ["a missing adapters block", { version: 1 }],
    ["a non-object adapters block", { version: 1, adapters: [] }],
    ["a missing codex block", { version: 1, adapters: {} }],
    ["an unknown codex field", { version: 1, adapters: { codex: { ...validEntry.adapters.codex, unexpected: true } } }],
    ["a non-string runtime reference", { version: 1, adapters: { codex: { ...validEntry.adapters.codex, runtime: [] } } }],
    ["an empty projects array", { version: 1, adapters: { codex: { ...validEntry.adapters.codex, projects: [] } } }],
    ["a non-array projects field", { version: 1, adapters: { codex: { ...validEntry.adapters.codex, projects: "./adapters/codex/projects/huanlink.json" } } }]
  ])("rejects config.json with %s", async (_name, entry) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeEntry(configRoot, entry);
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow("config.json");
      }
    );
  });

  it.each([
    "adapters/codex/runtime.json",
    "./adapters\\codex\\runtime.json",
    "./adapters/codex/./runtime.json",
    "./adapters/codex/../codex/runtime.json",
    "/adapters/codex/runtime.json"
  ])("rejects invalid runtime reference %s", async (runtime) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeEntry(configRoot, {
          ...validEntry,
          adapters: { codex: { ...validEntry.adapters.codex, runtime } }
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow("config.json");
      }
    );
  });

  it("ignores malformed server configuration while loading the adapter", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeEntry(configRoot, {
          ...validEntry,
          server: { mainAgent: 42, channels: [], agents: [], unexpected: true }
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).resolves.toMatchObject({
          projects: [{ projectId: "huanlink" }]
        });
      }
    );
  });

  it.each([
    ["damaged JSON", "{ \"projectId\": "],
    ["a non-object JSON value", "[]"]
  ])("rejects %s", async (_name, contents) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(codexPath(configRoot, "runtime.json"), contents);
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
          codexPath(configRoot, "runtime.json"),
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
          ...validRuntime,
          host: " localhost ",
          codexExecutable: " codex.cmd ",
          expectedCodexVersion: " 0.144.1 "
        });
        await writeConfigFile(codexPath(configRoot, "projects", "huanlink.json"), {
          ...validProject,
          projectId: " huanlink ",
          workspace: ".",
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
              workspace: ".",
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
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
        await writeConfigFile(codexPath(configRoot, relativePath), value);
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("rejects duplicate project references in config.json", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeEntry(configRoot, {
          ...validEntry,
          adapters: {
            codex: {
              ...validEntry.adapters.codex,
              projects: [
                "./adapters/codex/projects/huanlink.json",
                "./adapters/codex/projects/huanlink.json"
              ]
            }
          }
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow("config.json");
      }
    );
  });

  it("rejects duplicate project IDs from distinct referenced files without disclosing the ID", async () => {
    const duplicateProjectId = "do-not-disclose-duplicate-project-id";
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(codexPath(configRoot, "projects", "duplicate.json"), {
          ...validProject,
          projectId: duplicateProjectId
        });
        await writeConfigFile(codexPath(configRoot, "projects", "huanlink.json"), {
          ...validProject,
          projectId: duplicateProjectId
        });
        await writeEntry(configRoot, {
          ...validEntry,
          adapters: {
            codex: {
              ...validEntry.adapters.codex,
              projects: [
                "./adapters/codex/projects/huanlink.json",
                "./adapters/codex/projects/duplicate.json"
              ]
            }
          }
        });
      },
      async (configRoot) => {
        const promise = loadLocalConfig({ configRoot });
        await expect(promise).rejects.toThrow(
          "adapters/codex/projects/duplicate.json: projectId"
        );
        await expect(promise).rejects.not.toThrow(duplicateProjectId);
        await expect(promise).rejects.not.toThrow(configRoot);
      }
    );
  });

  it("rejects an invalid project ID in a referenced file", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(codexPath(configRoot, "projects", "huanlink.json"), {
          ...validProject,
          projectId: "not valid"
        });
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it.each([
    "./adapters/codex/projects/./huanlink.json",
    "./adapters/codex/projects/nested/../huanlink.json",
    "adapters/codex/projects/huanlink.json",
    "./adapters\\codex\\projects\\huanlink.json",
    "/adapters/codex/projects/huanlink.json"
  ])("rejects invalid project reference %s", async (projectReference) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeEntry(configRoot, {
          ...validEntry,
          adapters: {
            codex: {
              ...validEntry.adapters.codex,
              projects: [projectReference]
            }
          }
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow("config.json");
      }
    );
  });

  it.each([".", "projects/demo"])(
    "accepts the project workspace %s without resolving it",
    async (workspace) => {
      await withConfigRoot(
        async (configRoot) => {
          await writeConfigFile(codexPath(configRoot, "projects", "huanlink.json"), {
            ...validProject,
            workspace
          });
        },
        async (configRoot) => {
          await expect(loadLocalConfig({ configRoot })).resolves.toMatchObject({
            projects: [{ workspace }]
          });
        }
      );
    }
  );

  it.each(["/work/huanlink", "D:/work/huanlink", "C:relative", "projects\\demo", "../escape", " . ", "", " "])(
    "rejects the invalid project workspace %s",
    async (workspace) => {
      await withConfigRoot(
        async (configRoot) => {
          await writeConfigFile(codexPath(configRoot, "projects", "huanlink.json"), {
            ...validProject,
            workspace
          });
        },
        async (configRoot) => {
          await expectInvalidConfig(loadLocalConfig({ configRoot }));
        }
      );
    }
  );

  it.each([
    ["damaged JSON", "{ \"projectId\": "],
    ["a non-object JSON value", "[]"],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])]
  ])("rejects a project file with %s", async (_name, contents) => {
    await withConfigRoot(
      async (configRoot) => {
        await writeFile(codexPath(configRoot, "projects", "huanlink.json"), contents);
      },
      async (configRoot) => {
        await expectInvalidConfig(loadLocalConfig({ configRoot }));
      }
    );
  });

  it("returns project files in config.json declaration order", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(codexPath(configRoot, "projects", "a.json"), {
          ...validProject,
          projectId: "a"
        });
        await writeConfigFile(codexPath(configRoot, "projects", "z.json"), {
          ...validProject,
          projectId: "z"
        });
        await writeEntry(configRoot, {
          ...validEntry,
          adapters: {
            codex: {
              ...validEntry.adapters.codex,
              projects: [
                "./adapters/codex/projects/z.json",
                "./adapters/codex/projects/huanlink.json",
                "./adapters/codex/projects/a.json"
              ]
            }
          }
        });
      },
      async (configRoot) => {
        const config = await loadLocalConfig({ configRoot });
        expect(config.projects.map((project) => project.projectId)).toEqual([
          "z",
          "huanlink",
          "a"
        ]);
      }
    );
  });

  it("does not disclose configuration values when validation fails", async () => {
    const secretMarker = "do-not-disclose-codex-adapter-value";
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
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
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
          ...validRuntime,
          unexpected: secretMarker
        });
      },
      async (configRoot) => {
        const promise = loadLocalConfig({ configRoot });
        await expect(promise).rejects.toThrow("adapters/codex/runtime.json");
        await expect(promise).rejects.not.toThrow(secretMarker);
        await expect(promise).rejects.not.toThrow(configRoot);
      }
    );
  });

  it("reports a safe field name for schema validation errors", async () => {
    await withConfigRoot(
      async (configRoot) => {
        await writeConfigFile(codexPath(configRoot, "runtime.json"), {
          ...validRuntime,
          heartbeatIntervalMs: 0
        });
      },
      async (configRoot) => {
        await expect(loadLocalConfig({ configRoot })).rejects.toThrow(
          "adapters/codex/runtime.json: heartbeatIntervalMs"
        );
      }
    );
  });

  it("rejects a symlinked runtime file", async (context) => {
    await withConfigRoot(
      async (configRoot) => {
        const runtimePath = codexPath(configRoot, "runtime.json");
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
        const projectsPath = codexPath(configRoot, "projects");
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
