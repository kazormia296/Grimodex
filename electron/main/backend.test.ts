import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";

import { describe, expect, it, vi } from "vitest";

const dialogMock = vi.hoisted(() => ({ showErrorBox: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/grimodex-user-data",
    isPackaged: false,
  },
  dialog: dialogMock,
}));

const {
  getBackendConstructionFailure,
  initBackend,
  resolveGraphWorkerPath,
  resolveNodeBinaryPath,
  resolveRerankerResourceRoot,
  resolveSemanticResourceRoot,
} = await import("./backend.js");

describe("resolveSemanticResourceRoot", () => {
  const ownerToken = "a761ab47-4c49-4f0f-9237-d65d33d6bfc3";

  it("does not discover an ambient bundled model from the runtime fixture root", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "grimodex-perf-model-root-"),
    );
    try {
      const resolution = {
        isPackaged: false,
        resourcesPath: path.join(root, "packaged-resources"),
        mainDir: path.join(root, "repo", "dist-electron"),
        userDataPath: path.join(root, "user-data"),
      };
      const bundledRoot = resolveSemanticResourceRoot(resolution, {});
      const modelPath = path.join("bge-small-en-v15", "model_int8.onnx");
      mkdirSync(path.dirname(path.join(bundledRoot, modelPath)), {
        recursive: true,
      });
      writeFileSync(path.join(bundledRoot, modelPath), "ambient model marker");

      const fixtureRoot = resolveSemanticResourceRoot(resolution, {
        GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN: ownerToken,
      });

      expect(existsSync(path.join(bundledRoot, modelPath))).toBe(true);
      expect(existsSync(path.join(fixtureRoot, modelPath))).toBe(false);
      expect(fixtureRoot).toBe(
        path.join(resolution.userDataPath, "runtime-performance", "semantic"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates bundled semantic models for each deterministic runtime fixture", () => {
    for (const userDataPath of [
      "/tmp/run-a/user-data",
      "/tmp/run-b/user-data",
    ]) {
      expect(
        resolveSemanticResourceRoot(
          {
            isPackaged: false,
            resourcesPath: "/opt/Grimodex/resources",
            mainDir: "/repo/Grimodex/dist-electron",
            userDataPath,
          },
          { GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN: ownerToken },
        ),
      ).toBe(path.join(userDataPath, "runtime-performance", "semantic"));
    }
  });

  it("does not isolate models for absent or invalid runtime owner tokens", () => {
    for (const token of [
      undefined,
      "",
      "invalid",
      ownerToken.replace("4f0f", "5f0f"),
    ]) {
      expect(
        resolveSemanticResourceRoot(
          {
            isPackaged: false,
            resourcesPath: "/opt/Grimodex/resources",
            mainDir: "/repo/Grimodex/dist-electron",
            userDataPath: "/tmp/run-a/user-data",
          },
          { GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN: token },
        ),
      ).toBe(path.join("/repo/Grimodex", "src-tauri", "resources", "semantic"));
    }
  });

  it("keeps packaged resources even with an inherited runtime owner token", () => {
    expect(
      resolveSemanticResourceRoot(
        {
          isPackaged: true,
          resourcesPath: "/opt/Grimodex/resources",
          mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
          userDataPath: "/tmp/run-a/user-data",
        },
        { GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN: ownerToken },
      ),
    ).toBe(path.join("/opt/Grimodex/resources", "resources", "semantic"));
  });

  it("devではrepositoryのsrc-tauri/resources/semanticを明示注入する", () => {
    expect(
      resolveSemanticResourceRoot({
        isPackaged: false,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
      }),
    ).toBe(path.join("/repo/Grimodex", "src-tauri", "resources", "semantic"));
  });

  it("packageではprocess.resourcesPath配下を使いasar内パスへ落とさない", () => {
    expect(
      resolveSemanticResourceRoot({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
      }),
    ).toBe(path.join("/opt/Grimodex/resources", "resources", "semantic"));
  });
});

describe("resolveRerankerResourceRoot", () => {
  it("devでは明示overrideを優先し、無ければGate 2のlocal rootを使う", () => {
    expect(
      resolveRerankerResourceRoot(
        {
          isPackaged: false,
          mainDir: "/repo/Grimodex/dist-electron",
        },
        { GRIMODEX_RERANKER_RESOURCE_ROOT: "/models/rerankers" },
      ),
    ).toBe("/models/rerankers");
    expect(
      resolveRerankerResourceRoot({
        isPackaged: false,
        mainDir: "/repo/Grimodex/dist-electron",
      }),
    ).toBe(
      path.join(
        "/repo/Grimodex",
        "experiments",
        "lfm25-encoder-phase0",
        "local",
        "phase0b",
      ),
    );
  });

  it("packageでは検証済みreranker resourcesの固定rootを使う", () => {
    expect(
      resolveRerankerResourceRoot(
        {
          isPackaged: true,
          resourcesPath: "/opt/Grimodex/resources",
          mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
        },
        { GRIMODEX_RERANKER_RESOURCE_ROOT: "/models/rerankers" },
      ),
    ).toBe(
      path.join("/opt/Grimodex/resources", "resources", "reranker", "phase0b"),
    );
  });
});

describe("initBackend startup policy", () => {
  it("fails fast for CI acceptance instead of opening a fail-soft window", () => {
    vi.stubEnv("GRIMODEX_NODE_PATH", "/tmp/grimodex-missing-backend.node");

    expect(() => initBackend({ failFast: true })).toThrow(
      /grimodex-node\.node.*見つかりません/,
    );
    expect(dialogMock.showErrorBox).not.toHaveBeenCalled();
    expect(resolveNodeBinaryPath()).toBe("/tmp/grimodex-missing-backend.node");

    vi.unstubAllEnvs();
  });

  it("retains the existing dialog fail-soft policy outside CI acceptance", () => {
    vi.stubEnv("GRIMODEX_NODE_PATH", "/tmp/grimodex-missing-backend.node");

    expect(initBackend()).toBeNull();
    expect(dialogMock.showErrorBox).toHaveBeenCalledOnce();

    dialogMock.showErrorBox.mockReset();
    vi.unstubAllEnvs();
  });

  it("keeps only the closed code of an unreadable profile state file (DA-2 R-7)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-backend-r7-"));
    let index = 0;
    /** A module that stands in for the addon; its constructor throws. */
    const failingBackend = (message: string): string => {
      const fake = path.join(root, `fake-backend-${index++}.cjs`);
      writeFileSync(
        fake,
        `exports.Backend = class { constructor() { throw new Error(${JSON.stringify(message)}); } };`,
      );
      return fake;
    };
    try {
      vi.stubEnv(
        "GRIMODEX_NODE_PATH",
        failingBackend(
          "PROFILE_EGRESS_UNAVAILABLE:state-file-unreadable: Is a directory (os error 21)",
        ),
      );
      expect(initBackend()).toBeNull();
      expect(getBackendConstructionFailure()).toBe("state-file-unreadable");

      // Another cause (or a lookalike code) is not that reason.
      for (const message of [
        "PROFILE_EGRESS_UNAVAILABLE:state-file-unreadable-x",
        "XPROFILE_EGRESS_UNAVAILABLE:state-file-unreadable",
        "database is locked",
      ]) {
        vi.stubEnv("GRIMODEX_NODE_PATH", failingBackend(message));
        expect(initBackend(), message).toBeNull();
        expect(getBackendConstructionFailure(), message).toBeNull();
      }
    } finally {
      dialogMock.showErrorBox.mockReset();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// CP-2b P1（DR-CP2B-P1-1、2）: C-query の worker の path は Main が組み立てて
// Backend constructor の 4 番目の引数で渡す。出所は Main の解決だけで、env・
// renderer・IPC からは受け取らない。検証は Native の 1 か所（`from_path`）。
describe("resolveGraphWorkerPath", () => {
  it("packageでは<resources>/bin のworkerをOSごとの名前で指す", () => {
    expect(
      resolveGraphWorkerPath({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
        platform: "linux",
      }),
    ).toBe(path.join("/opt/Grimodex/resources", "bin", "nir1-c-query-worker"));
    expect(
      resolveGraphWorkerPath({
        isPackaged: true,
        resourcesPath: "C:\\Program Files\\Grimodex\\resources",
        mainDir:
          "C:\\Program Files\\Grimodex\\resources\\app.asar\\dist-electron",
        platform: "win32",
      }),
    ).toBe(
      path.win32.join(
        "C:\\Program Files\\Grimodex\\resources",
        "bin",
        "nir1-c-query-worker.exe",
      ),
    );
    expect(
      resolveGraphWorkerPath({
        isPackaged: true,
        resourcesPath: "/Applications/Grimodex.app/Contents/Resources",
        mainDir:
          "/Applications/Grimodex.app/Contents/Resources/app.asar/dist-electron",
        platform: "darwin",
      }),
    ).toBe(
      path.join(
        "/Applications/Grimodex.app/Contents/Resources",
        "bin",
        "nir1-c-query-worker",
      ),
    );
  });

  it("devではextraResourcesの元と同じsrc-tauri/target/releaseを指し、debugは見ない", () => {
    expect(
      resolveGraphWorkerPath({
        isPackaged: false,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
      }),
    ).toBe(
      path.join(
        "/repo/Grimodex",
        "src-tauri",
        "target",
        "release",
        "nir1-c-query-worker",
      ),
    );
  });

  it("returns an absolute path for every packaged and dev layout", () => {
    for (const isPackaged of [true, false]) {
      const resolved = resolveGraphWorkerPath({
        isPackaged,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
      });
      expect(path.isAbsolute(resolved)).toBe(true);
    }
  });

  it("does not read the worker path from the environment", () => {
    const resolution = {
      isPackaged: true,
      resourcesPath: "/opt/Grimodex/resources",
      mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
      platform: "linux" as const,
    };
    const expected = resolveGraphWorkerPath(resolution);
    for (const name of [
      "GRIMODEX_GRAPH_WORKER_PATH",
      "GRIMODEX_NIR1_GRAPH_WORKER_PATH",
      "GRIMODEX_NIR1_C_QUERY_WORKER_PATH",
      "NIR1_GRAPH_WORKER_PATH",
      "NIR1_C_QUERY_WORKER",
    ]) {
      vi.stubEnv(name, "/tmp/attacker/nir1-c-query-worker");
    }
    try {
      expect(resolveGraphWorkerPath(resolution)).toBe(expected);
      expect(resolveGraphWorkerPath()).not.toContain("/tmp/attacker");
    } finally {
      vi.unstubAllEnvs();
    }
    // The resolver takes no env parameter and its body never names `env`.
    const source = readFileSync(path.join(__dirname, "backend.ts"), "utf8");
    const start = source.indexOf("export function resolveGraphWorkerPath(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/\benv\b/);
    expect(body).not.toMatch(/argv|ipcMain|getPath\(/);
  });

  it("keeps the worker path out of the renderer, preload and IPC contract", () => {
    const repoRoot = path.join(__dirname, "..", "..");
    const roots = [
      path.join(repoRoot, "electron", "shared"),
      path.join(repoRoot, "electron", "preload"),
      path.join(repoRoot, "src"),
    ];
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          visit(full);
        } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          if (
            /nir1-c-query-worker|graphWorkerPath|resolveGraphWorkerPath/.test(
              text,
            )
          ) {
            offenders.push(path.relative(repoRoot, full));
          }
        }
      }
    };
    for (const root of roots) visit(root);
    expect(offenders).toEqual([]);

    // In electron/main only backend.ts resolves it (tests aside).
    const mainDir = path.join(repoRoot, "electron", "main");
    const mainUsers = readdirSync(mainDir)
      .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
      .filter((name) =>
        /nir1-c-query-worker|resolveGraphWorkerPath/.test(
          readFileSync(path.join(mainDir, name), "utf8"),
        ),
      );
    expect(mainUsers).toEqual(["backend.ts"]);
  });
});

describe("initBackend graph worker wiring", () => {
  it("passes Main's resolved worker path as the fourth constructor argument without checking it", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "grimodex-backend-worker-"),
    );
    const fake = path.join(root, "fake-backend-args.cjs");
    writeFileSync(
      fake,
      [
        "exports.Backend = class {",
        "  constructor(...args) { globalThis.__grimodexBackendArgs = args; }",
        "};",
      ].join("\n"),
    );
    try {
      vi.stubEnv("GRIMODEX_NODE_PATH", fake);
      // A worker override in the environment must not reach the constructor.
      vi.stubEnv("GRIMODEX_NIR1_GRAPH_WORKER_PATH", "/tmp/attacker/worker");
      const backend = initBackend({ failFast: true });
      expect(backend).not.toBeNull();
      const args = (globalThis as { __grimodexBackendArgs?: unknown[] })
        .__grimodexBackendArgs;
      expect(args).toHaveLength(4);
      const workerPath = args?.[3];
      expect(workerPath).toBe(resolveGraphWorkerPath());
      expect(typeof workerPath).toBe("string");
      expect(workerPath).not.toContain("/tmp/attacker");
      expect(path.isAbsolute(workerPath as string)).toBe(true);
      // Main does not check existence: a missing worker still loads the
      // backend (Native refuses the path and leaves the Graph unavailable).
      expect(existsSync(workerPath as string)).toBe(false);
      expect(dialogMock.showErrorBox).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { __grimodexBackendArgs?: unknown[] })
        .__grimodexBackendArgs;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
