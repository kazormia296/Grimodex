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
  backendLoadFailureDialogText,
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

// DR-PUBG-33-1: fail-soft の dialog に Native の文を出さない。原文は log にだけ残す。
describe("initBackend error box (DR-PUBG-33-1)", () => {
  const nativeMessages = [
    "PROFILE_EGRESS_UNAVAILABLE:state-file-unreadable: Permission denied (os error 13) at /home/secret-user/.config/Grimodex/profile-egress-state.json",
    "database is locked: /home/secret-user/.local/share/Grimodex/grimodex.db",
  ];

  it("shows a fixed text without the Native message, path or code, and keeps the original in the log", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-backend-33-"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      nativeMessages.forEach((message, index) => {
        const fake = path.join(root, `fake-backend-${index}.cjs`);
        writeFileSync(
          fake,
          `exports.Backend = class { constructor() { throw new Error(${JSON.stringify(message)}); } };`,
        );
        vi.stubEnv("GRIMODEX_NODE_PATH", fake);
        dialogMock.showErrorBox.mockReset();
        errorLog.mockClear();

        expect(initBackend()).toBeNull();

        expect(dialogMock.showErrorBox).toHaveBeenCalledOnce();
        const [title, content] = dialogMock.showErrorBox.mock.calls[0] as [
          string,
          string,
        ];
        const shown = `${title}\n${content}`;
        for (const leaked of [
          "PROFILE_EGRESS",
          "state-file-unreadable",
          "os error",
          "Permission denied",
          "database is locked",
          "/home/",
          "secret-user",
          "grimodex.db",
          fake,
        ]) {
          expect(shown, leaked).not.toContain(leaked);
        }
        expect(shown).toContain("もう一度起動");
        expect(shown).toContain("restart");
        // 診断のため、原文は既存の log に残る。
        expect(
          errorLog.mock.calls.some((call) => String(call[0]).includes(message)),
        ).toBe(true);
      });
    } finally {
      errorLog.mockRestore();
      dialogMock.showErrorBox.mockReset();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("splits the text only by the closed state-file code", () => {
    const unreadable = backendLoadFailureDialogText("state-file-unreadable");
    const other = backendLoadFailureDialogText(null);
    expect(unreadable.content).toContain("状態ファイル");
    expect(unreadable.content).toContain("state file");
    expect(other.content).not.toContain("状態ファイル");
    expect(other.title).toBe(unreadable.title);
  });

  it("does not call the error box in fail-fast mode", () => {
    vi.stubEnv("GRIMODEX_NODE_PATH", "/tmp/grimodex-missing-backend.node");
    dialogMock.showErrorBox.mockReset();
    expect(() => initBackend({ failFast: true })).toThrow();
    expect(dialogMock.showErrorBox).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

// CP-2b P1（DR-CP2B-P1-1、2）: C-query の worker の path は Main が組み立てて
// Backend constructor の 4 番目の引数で渡す。出所は Main の解決だけで、env・
// renderer・IPC からは受け取らない。検証は Native の 1 か所（`from_path`）。
describe("resolveGraphWorkerPath", () => {
  // 期待値は OS ごとの literal で書く。製品は `platform` に合わせて
  // `path.posix`／`path.win32` を選ぶので、試験は実行する host の区切り
  // （Windows の CI では `\`）に依らずに同じ結果を確かめられる。
  const packaged = {
    linux: {
      resourcesPath: "/opt/Grimodex/resources",
      mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
      expected: "/opt/Grimodex/resources/bin/nir1-c-query-worker",
    },
    darwin: {
      resourcesPath: "/Applications/Grimodex.app/Contents/Resources",
      mainDir:
        "/Applications/Grimodex.app/Contents/Resources/app.asar/dist-electron",
      expected:
        "/Applications/Grimodex.app/Contents/Resources/bin/nir1-c-query-worker",
    },
    win32: {
      resourcesPath: "C:\\Program Files\\Grimodex\\resources",
      mainDir:
        "C:\\Program Files\\Grimodex\\resources\\app.asar\\dist-electron",
      expected:
        "C:\\Program Files\\Grimodex\\resources\\bin\\nir1-c-query-worker.exe",
    },
  } as const;
  const dev = {
    linux: {
      mainDir: "/repo/Grimodex/dist-electron",
      expected: "/repo/Grimodex/src-tauri/target/release/nir1-c-query-worker",
    },
    darwin: {
      mainDir: "/Users/writer/Grimodex/dist-electron",
      expected:
        "/Users/writer/Grimodex/src-tauri/target/release/nir1-c-query-worker",
    },
    win32: {
      mainDir: "C:\\repo\\Grimodex\\dist-electron",
      expected:
        "C:\\repo\\Grimodex\\src-tauri\\target\\release\\nir1-c-query-worker.exe",
    },
  } as const;
  const platforms = ["linux", "darwin", "win32"] as const;

  it("packageでは<resources>/bin のworkerをOSごとの名前と区切りで指す", () => {
    for (const platform of platforms) {
      const { resourcesPath, mainDir, expected } = packaged[platform];
      expect(
        resolveGraphWorkerPath({
          isPackaged: true,
          resourcesPath,
          mainDir,
          platform,
        }),
        platform,
      ).toBe(expected);
    }
  });

  it("devではextraResourcesの元と同じsrc-tauri/target/releaseを指し、debugは見ない", () => {
    for (const platform of platforms) {
      const { mainDir, expected } = dev[platform];
      expect(
        resolveGraphWorkerPath({
          isPackaged: false,
          resourcesPath: packaged[platform].resourcesPath,
          mainDir,
          platform,
        }),
        platform,
      ).toBe(expected);
    }
  });

  it("returns an absolute path in the platform's own separator for every layout", () => {
    for (const platform of platforms) {
      const pathApi = platform === "win32" ? path.win32 : path.posix;
      for (const isPackaged of [true, false]) {
        const resolved = resolveGraphWorkerPath({
          isPackaged,
          resourcesPath: packaged[platform].resourcesPath,
          mainDir: isPackaged
            ? packaged[platform].mainDir
            : dev[platform].mainDir,
          platform,
        });
        expect(pathApi.isAbsolute(resolved), resolved).toBe(true);
        expect(resolved, resolved).not.toContain(
          platform === "win32" ? "/" : "\\",
        );
        expect(pathApi.basename(resolved)).toBe(
          platform === "win32"
            ? "nir1-c-query-worker.exe"
            : "nir1-c-query-worker",
        );
      }
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
      // Under vitest `__dirname` is `electron/main`, so this default resolves to
      // `electron/src-tauri/target/release/…`, which never exists; that is why
      // the absence holds here. The real dev path (`<repo>/src-tauri/…` from
      // `dist-electron`) is fixed only by the pure resolver tests above.
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
