import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_BOUNDARY = "4cf8e01fffdf05271b23790d69e438122b45af4e";

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function repositoryTextFiles() {
  const textExtensions = new Set([
    ".bzl",
    ".c",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".nsh",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  const exactTextNames = new Set(["LICENSE", "NOTICE", "PKGBUILD"]);
  const excludedDirectories = new Set([
    ".artifacts",
    ".git",
    ".venv",
    ".worktrees",
    "coverage",
    "dist",
    "dist-electron",
    "local",
    "node_modules",
    "release",
    "target",
    "worktrees",
  ]);
  const files = [];

  async function walk(absoluteDirectory, relativeDirectory = "") {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          await walk(path.join(absoluteDirectory, entry.name), relativePath);
        }
        continue;
      }
      if (
        exactTextNames.has(entry.name) ||
        textExtensions.has(path.extname(entry.name))
      ) {
        files.push(relativePath);
      }
    }
  }

  await walk(ROOT);
  return files.sort();
}

test("records one prospective proprietary cutover without relicensing legacy versions", async () => {
  const [license, licensing, notice, readme] = await Promise.all([
    read("LICENSE"),
    read("LICENSING.md"),
    read("NOTICE"),
    read("README.md"),
  ]);

  assert.match(license, /^Grimodex Proprietary License Notice$/m);
  assert.match(license, /All rights reserved\./);
  assert.match(license, /Third-party components remain subject/);
  assert.match(license, new RegExp(LEGACY_BOUNDARY));
  assert.match(license, /tag: elv2-final/);

  assert.match(licensing, /source-visible proprietary software/);
  assert.match(licensing, new RegExp(LEGACY_BOUNDARY));
  assert.match(licensing, /`elv2-final` tag identifies that commit/);
  assert.match(licensing, /does not revoke rights already\s+granted/);
  assert.match(licensing, /not accepting external code contributions/);

  assert.match(notice, /first-party software is proprietary/);
  assert.match(notice, /ISC License/);
  assert.match(readme, /Proprietary — All Rights Reserved/);
});

test("uses non-open-source metadata for first-party JavaScript and Rust packages", async () => {
  for (const relativePath of [
    "package.json",
    "packages/scan-contract/package.json",
    "packages/scan-core/package.json",
    "electron/native/grimodex-node/package.json",
  ]) {
    const manifest = await readJson(relativePath);
    assert.equal(manifest.private, true, `${relativePath} must stay private`);
    assert.equal(
      manifest.license,
      "UNLICENSED",
      `${relativePath} must not advertise an open-source license`,
    );
  }

  const workspaceManifest = await read("src-tauri/Cargo.toml");
  assert.match(workspaceManifest, /\[workspace\.package\]/);
  assert.match(workspaceManifest, /license-file = "\.\.\/LICENSE"/);
  assert.match(workspaceManifest, /license-file\.workspace = true/);
  assert.match(workspaceManifest, /publish\.workspace = true/);

  const cratesRoot = path.join(ROOT, "src-tauri", "crates");
  const crateDirectories = (await readdir(cratesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const directory of crateDirectories) {
    const relativePath = `src-tauri/crates/${directory}/Cargo.toml`;
    const manifest = await read(relativePath);
    assert.match(
      manifest,
      /license-file\.workspace = true/,
      `${relativePath} must inherit the proprietary notice`,
    );
    assert.match(
      manifest,
      /publish\.workspace = true/,
      `${relativePath} must disable registry publication`,
    );
  }

  const nativeManifest = await read("electron/native/grimodex-node/Cargo.toml");
  assert.match(nativeManifest, /license-file = "\.\.\/\.\.\/\.\.\/LICENSE"/);
  assert.match(nativeManifest, /publish = false/);

  const archPackage = await read("packaging/arch/PKGBUILD");
  assert.match(archPackage, /license=\('LicenseRef-Grimodex-Proprietary'\)/);
  assert.match(archPackage, /\/usr\/share\/licenses\/\$\{pkgname\}\/LICENSE/);
});

test("bundles the proprietary notice and forces Terms v2.0 re-consent", async () => {
  const [builder, constants, termsJa, termsEn, about] = await Promise.all([
    read("electron-builder.yml"),
    read("src/features/legal/constants.ts"),
    read("public/TERMS_ja.md"),
    read("public/TERMS_en.md"),
    read("src/features/settings/categories/about/AppInfoHeader.tsx"),
  ]);

  for (const bundledFile of ["LICENSE", "LICENSING.md", "NOTICE"]) {
    assert.match(
      builder,
      new RegExp(`^  - ${bundledFile.replace(".", "\\.")}$`, "m"),
    );
  }
  assert.match(constants, /EULA_VERSION = "2\.0"/);
  assert.match(termsJa, /バージョン: v2\.0/);
  assert.match(termsJa, /第一者ソースコードはプロプライエタリ/);
  assert.match(termsJa, /公式 Grimodex バイナリ/);
  assert.match(termsEn, /Version: v2\.0/);
  assert.match(
    termsEn,
    /first-party source code of the Software is proprietary/,
  );
  assert.match(termsEn, /official Grimodex binaries/);
  assert.match(about, />\s*Proprietary\s*</);
});

test("allows legacy license wording only in the two cutover records", async () => {
  const allowedHistoricalRecords = new Set(["LICENSE", "LICENSING.md"]);
  const legacyPhrases = [
    ["Elastic", "License", "2.0"].join(" "),
    ["Elastic", "2.0"].join("-"),
    ["EL", "v2"].join(""),
    `https://www.${["elastic.co", "licensing", "elastic-license"].join("/")}`,
  ];
  const excludedGeneratedNotices = new Set([
    "THIRD_PARTY_LICENSES.md",
    "public/THIRD_PARTY_LICENSES.md",
  ]);
  const stale = [];

  for (const relativePath of await repositoryTextFiles()) {
    if (
      allowedHistoricalRecords.has(relativePath) ||
      excludedGeneratedNotices.has(relativePath)
    ) {
      continue;
    }
    const content = await read(relativePath);
    for (const phrase of legacyPhrases) {
      if (content.includes(phrase)) stale.push(`${relativePath}: ${phrase}`);
    }
  }

  assert.deepEqual(
    stale,
    [],
    `legacy license claims must be removed from active files:\n${stale.join("\n")}`,
  );
});
