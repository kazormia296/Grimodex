import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildBridgeManifest,
  validateBridgeManifestSchema,
  writeImmutableManifest,
} from "./generate-tauri-bridge-manifest.mjs";

const tempRoots = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeAssets(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-bridge-"));
  tempRoots.push(root);
  for (const [name, signature] of entries) {
    await writeFile(path.join(root, name), "artifact");
    if (signature !== null) {
      await writeFile(path.join(root, `${name}.sig`), `${signature}\n`);
    }
  }
  return root;
}

describe("Tauri v1 to Electron v2 bridge manifest", () => {
  it("maps signed Electron assets to Tauri platform keys", async () => {
    const assetsDir = await makeAssets([
      ["Grimodex-2.3.4-windows-x64.exe", "sig-win"],
      ["Grimodex-2.3.4-mac-x64.app.tar.gz", "sig-mac-x64"],
      ["Grimodex-2.3.4-linux-x86_64.AppImage", "sig-linux-appimage"],
      ["Grimodex-2.3.4-linux-amd64.deb", "sig-linux-deb"],
      ["Grimodex-2.3.4-linux-x86_64.rpm", "sig-linux-rpm"],
      ["Grimodex-2.3.4-mac-x64.zip", null],
      ["Grimodex-2.3.4-mac-x64.dmg", null],
    ]);

    const manifest = await buildBridgeManifest({
      assetsDir,
      version: "2.3.4",
      tag: "v2.3.4",
      repository: "kazormia296/Grimodex",
      notes: "Electron v2 migration bridge",
      pubDate: "2026-07-11T00:00:00.000Z",
    });

    assert.deepEqual(Object.keys(manifest.platforms), [
      "darwin-x86_64-app",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "linux-x86_64-rpm",
      "windows-x86_64-nsis",
    ]);
    assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], {
      signature: "sig-win",
      url: "https://github.com/kazormia296/Grimodex/releases/download/v2.3.4/Grimodex-2.3.4-windows-x64.exe",
    });
    assert.equal(validateBridgeManifestSchema(manifest), true);
  });

  it("refuses to claim an updater platform without a real signature", async () => {
    const assetsDir = await makeAssets([
      ["Grimodex-2.0.0-linux-x64.AppImage", null],
    ]);

    await assert.rejects(
      buildBridgeManifest({
        assetsDir,
        version: "2.0.0",
        tag: "v2.0.0",
        repository: "kazormia296/Grimodex",
        notes: "bridge",
        pubDate: "2026-07-11T00:00:00.000Z",
      }),
      /signature sidecar/,
    );
  });

  it("requires every Linux installer-specific target", async () => {
    const assetsDir = await makeAssets([
      ["Grimodex-2.0.0-windows-x64.exe", "sig-win"],
      ["Grimodex-2.0.0-mac-x64.app.tar.gz", "sig-mac"],
      ["Grimodex-2.0.0-linux-x86_64.AppImage", "sig-appimage"],
      ["Grimodex-2.0.0-linux-amd64.deb", "sig-deb"],
    ]);

    await assert.rejects(
      buildBridgeManifest({
        assetsDir,
        version: "2.0.0",
        tag: "v2.0.0",
        repository: "kazormia296/Grimodex",
        notes: "bridge",
        pubDate: "2026-07-11T00:00:00.000Z",
      }),
      /linux-x86_64-rpm/,
    );
  });

  it("keeps latest.json immutable across workflow reruns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-manifest-"));
    tempRoots.push(root);
    const output = path.join(root, "latest.json");
    const manifest = {
      version: "2.0.0",
      notes: "bridge",
      pub_date: "2026-07-11T00:00:00.000Z",
      platforms: {
        "darwin-x86_64-app": {
          signature: "real-signature",
          url: "https://example.invalid/Grimodex.app.tar.gz",
        },
        "linux-x86_64-appimage": {
          signature: "real-signature",
          url: "https://example.invalid/Grimodex.AppImage",
        },
        "linux-x86_64-deb": {
          signature: "real-signature",
          url: "https://example.invalid/Grimodex.deb",
        },
        "linux-x86_64-rpm": {
          signature: "real-signature",
          url: "https://example.invalid/Grimodex.rpm",
        },
        "windows-x86_64-nsis": {
          signature: "real-signature",
          url: "https://example.invalid/Grimodex.exe",
        },
      },
    };

    await writeImmutableManifest(output, manifest);
    await writeImmutableManifest(output, manifest);
    assert.equal(JSON.parse(await readFile(output, "utf8")).version, "2.0.0");

    await assert.rejects(
      writeImmutableManifest(output, { ...manifest, notes: "changed" }),
      /immutable bridge manifest/,
    );
  });
});
