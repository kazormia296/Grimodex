import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/grimodex-user-data",
    isPackaged: false,
  },
  dialog: { showErrorBox: vi.fn() },
}));

const { resolveSemanticResourceRoot } = await import("./backend.js");

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
