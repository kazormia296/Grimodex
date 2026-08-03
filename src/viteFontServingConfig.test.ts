import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vite";

describe("Vite development font serving", () => {
  it("allows the real dependency directory used by /@fs/ font requests", async () => {
    const root = process.cwd();
    const dependencyRoot = realpathSync(
      path.resolve(root, "node_modules"),
    ).replaceAll("\\", "/");
    const configs = await Promise.all([
      resolveConfig(
        { configFile: path.resolve(root, "vite.config.ts") },
        "serve",
        "web-editor",
      ),
      resolveConfig(
        { configFile: path.resolve(root, "vitest.browser.config.ts") },
        "serve",
      ),
    ]);

    for (const config of configs) {
      expect(config.server.fs.allow).toContain(dependencyRoot);
    }
  });

  it("isolates optimized dependencies for Web Editor and desktop modes", async () => {
    const root = process.cwd();
    const configFile = path.resolve(root, "vite.config.ts");
    const [webEditor, desktop] = await Promise.all([
      resolveConfig({ configFile }, "serve", "web-editor"),
      resolveConfig({ configFile }, "serve", "development"),
    ]);

    expect(webEditor.cacheDir).toBe(
      path.resolve(root, "node_modules/.vite/web-editor"),
    );
    expect(desktop.cacheDir).toBe(
      path.resolve(root, "node_modules/.vite/desktop"),
    );
    expect(webEditor.cacheDir).not.toBe(desktop.cacheDir);
  });
});
