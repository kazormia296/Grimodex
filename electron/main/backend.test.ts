import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/grimodex-user-data",
    isPackaged: false,
  },
  dialog: { showErrorBox: vi.fn() },
}));

const { resolveRerankerResourceRoot, resolveSemanticResourceRoot } =
  await import("./backend.js");

describe("resolveSemanticResourceRoot", () => {
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
