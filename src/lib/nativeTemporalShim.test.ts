// @vitest-environment node
import path from "node:path";
import { loadConfigFromFile } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = path.resolve(__dirname, "../..");

/** vite.config.ts を読み込み、temporal-polyfill の alias の有無を返す。 */
async function aliasesTemporal(
  command: "build" | "serve",
  mode: string,
): Promise<boolean> {
  const loaded = await loadConfigFromFile(
    { command, mode },
    path.join(root, "vite.config.ts"),
    root,
  );
  const alias = loaded?.config.resolve?.alias;
  if (!Array.isArray(alias)) throw new Error("resolve.alias is not a list");
  return alias.some(
    (entry) =>
      entry.find instanceof RegExp && entry.find.test("temporal-polyfill"),
  );
}

describe("temporal-polyfill の alias の条件（vite.config.ts）", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["Electron の desktop の build", "build", "production", "", true],
    ["Web Editor の build", "build", "web-editor", "", false],
    ["Tauri shell の build", "build", "production", "linux", false],
    ["dev server", "serve", "development", "", false],
  ] as const)(
    "%s",
    async (_label, command, mode, tauriPlatform, expected) => {
      vi.stubEnv("TAURI_ENV_PLATFORM", tauriPlatform);
      await expect(aliasesTemporal(command, mode)).resolves.toBe(expected);
    },
    30_000,
  );
});

describe("nativeTemporalShim", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("標準の Temporal をそのまま出す", async () => {
    const native = { Instant: {} };
    vi.stubGlobal("Temporal", native);
    vi.resetModules();
    const shim = await import("./nativeTemporalShim");
    expect(shim.Temporal).toBe(native);
  });

  it("標準の Temporal が無ければ読み込みで止める", async () => {
    vi.stubGlobal("Temporal", undefined);
    vi.resetModules();
    await expect(import("./nativeTemporalShim")).rejects.toThrow(
      "native Temporal",
    );
  });
});
