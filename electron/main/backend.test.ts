import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  initBackend,
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
});
