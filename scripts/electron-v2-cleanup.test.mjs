import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseVersion } from "./validate-release-version.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Electron v2 cleanup contract", () => {
  it("uses package.json as the v2 version source while freezing the Tauri v1 identity", () => {
    const packageJson = JSON.parse(read("package.json"));
    const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
    const electronBuilder = read("electron-builder.yml");
    const appId = /^appId:\s*(\S+)$/m.exec(electronBuilder)?.[1];

    validateReleaseVersion({
      tag: `v${packageJson.version}`,
      packageVersion: packageJson.version,
      expectedMajor: 2,
      refType: "tag",
    });
    assert.equal(tauriConfig.version, "1.0.0");
    assert.equal(appId, "com.miyakey.grimodex");
    assert.equal(tauriConfig.identifier, appId);
    assert.match(
      read("electron/main/userData.ts"),
      /LEGACY_TAURI_DIRECTORY\s*=\s*["']com\.miyakey\.grimodex["']/,
    );
    assert.ok(
      existsSync(
        path.join(
          repoRoot,
          `public/RELEASE_NOTES/v${packageJson.version}.ja.md`,
        ),
      ),
    );
    assert.ok(
      existsSync(
        path.join(
          repoRoot,
          `public/RELEASE_NOTES/v${packageJson.version}.en.md`,
        ),
      ),
    );
  });

  it("removes WebKitGTK-only frontend and Rust workarounds", () => {
    const removedFiles = [
      "scripts/setup-webkit-host-libs.sh",
      "src/lib/verticalFormControls.ts",
      "src/features/editor/EmphasisDotsFallbackPlugin.ts",
      "src/features/editor/useEmphasisDotsFallback.ts",
      "src/features/editor/useWebKitGtkVerticalScrollResetGuard.ts",
      "src/features/editor/webkitFocusScrollGuard.ts",
      "src-tauri/src/webkit_features.rs",
    ];
    for (const relativePath of removedFiles) {
      assert.equal(
        existsSync(path.join(repoRoot, relativePath)),
        false,
        relativePath,
      );
    }

    assert.doesNotMatch(read("src/index.css"), /data-engine=["']webkitgtk/);
    assert.doesNotMatch(read("src/index.css"), /data-vfc/);
    assert.doesNotMatch(read("src/lib/platform.ts"), /isWebKit|isLinux/);
    assert.doesNotMatch(
      read("src-tauri/src/lib.rs"),
      /WEBKIT_|webkit_features/,
    );
    assert.doesNotMatch(read("src-tauri/Cargo.toml"), /^webkit2gtk\s*=/m);
    assert.doesNotMatch(read("src-tauri/Cargo.toml"), /^glib\s*=/m);
  });

  it("keeps browser and development gates Chromium-only", () => {
    const browserConfig = read("vitest.browser.config.ts");
    const ci = read(".github/workflows/ci.yml");
    const container = `${read(".devcontainer/Dockerfile")}\n${read(
      ".devcontainer/devcontainer.json",
    )}`;

    assert.match(browserConfig, /browser:\s*["']chromium["']/);
    assert.doesNotMatch(browserConfig, /browser:\s*["']webkit["']/);
    assert.doesNotMatch(ci, /playwright[^\n]*chromium[^\n]*webkit/);
    assert.doesNotMatch(ci, /libwebkit2gtk|libayatana-appindicator/);
    assert.match(ci, /--workspace --exclude grimodex/);
    assert.match(
      ci,
      /cargo test --workspace --exclude grimodex\s+--features grimodex-semantic\/semantic-embedding/,
    );
    assert.doesNotMatch(container, /webkit2gtk|WEBKIT_DISABLE|tauri-vscode/);
  });

  it("preserves Chromium vertical-caret and Tauri v1 migration contracts", () => {
    const caret = read("src/features/editor/VerticalCaretNavExtension.ts");
    const css = read("src/index.css");
    const releaseWorkflow = read(".github/workflows/release.yml");

    assert.match(caret, /ArrowLeft/);
    assert.match(caret, /ArrowRight/);
    assert.doesNotMatch(caret, /ArrowUp|ArrowDown/);
    assert.match(css, /-webkit-app-region:\s*drag/);
    assert.match(releaseWorkflow, /pnpm tauri signer sign/);
    assert.ok(
      existsSync(
        path.join(repoRoot, "electron/installer/tauri-v1-migration.nsh"),
      ),
    );
    assert.ok(
      existsSync(
        path.join(repoRoot, "packaging/tauri-v1/updater-public-key.pub"),
      ),
    );
  });
});
