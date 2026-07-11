import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { dump } from "js-yaml";

import { verifyElectronUpdaterMetadata } from "./verify-electron-updater-metadata.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(
  metadataName = "latest.yml",
  artifactName = "setup.exe",
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grimodex-updater-"));
  temporaryDirectories.push(directory);
  const content = Buffer.from("signed updater bytes");
  const digest = createHash("sha512").update(content).digest("base64");
  const artifactPath = path.join(directory, artifactName);
  const metadataPath = path.join(directory, metadataName);
  await writeFile(artifactPath, content);
  const metadata = {
    version: "2.0.0",
    files: [{ url: artifactName, sha512: digest, size: content.length }],
    path: artifactName,
    sha512: digest,
  };
  await writeFile(metadataPath, dump(metadata));
  return { artifactPath, content, digest, metadata, metadataPath };
}

describe("verifyElectronUpdaterMetadata", () => {
  it("verifies every artifact digest, size, and legacy path mapping", async () => {
    const { metadataPath } = await fixture();

    assert.deepEqual(await verifyElectronUpdaterMetadata(metadataPath), [
      {
        name: "setup.exe",
        sha512: createHash("sha512")
          .update("signed updater bytes")
          .digest("base64"),
        size: Buffer.byteLength("signed updater bytes"),
      },
    ]);
  });

  it("rejects stale size and digest metadata", async () => {
    const sizeFixture = await fixture("latest-size.yml", "size.exe");
    sizeFixture.metadata.files[0].size += 1;
    await writeFile(sizeFixture.metadataPath, dump(sizeFixture.metadata));
    await assert.rejects(
      verifyElectronUpdaterMetadata(sizeFixture.metadataPath),
      /size mismatch/,
    );

    const digestFixture = await fixture("latest-digest.yml", "digest.exe");
    digestFixture.metadata.files[0].sha512 =
      Buffer.alloc(64).toString("base64");
    digestFixture.metadata.sha512 = digestFixture.metadata.files[0].sha512;
    await writeFile(digestFixture.metadataPath, dump(digestFixture.metadata));
    await assert.rejects(
      verifyElectronUpdaterMetadata(digestFixture.metadataPath),
      /SHA-512 mismatch/,
    );
  });

  it("rejects unsafe or missing artifact paths", async () => {
    const unsafe = await fixture("latest-unsafe.yml", "safe.exe");
    unsafe.metadata.files[0].url = "../safe.exe";
    await writeFile(unsafe.metadataPath, dump(unsafe.metadata));
    await assert.rejects(
      verifyElectronUpdaterMetadata(unsafe.metadataPath),
      /plain local artifact filename/,
    );

    const missing = await fixture("latest-missing.yml", "missing.exe");
    await rm(missing.artifactPath);
    await assert.rejects(
      verifyElectronUpdaterMetadata(missing.metadataPath),
      /artifact is missing/,
    );
  });

  it("accepts ZIP-only mac metadata and rejects a mutable DMG entry", async () => {
    const zip = await fixture("latest-mac.yml", "Grimodex-2.0.0-mac-arm64.zip");
    await assert.doesNotReject(verifyElectronUpdaterMetadata(zip.metadataPath));

    const dmg = await fixture("latest-mac.yml", "Grimodex-2.0.0-mac-arm64.dmg");
    await assert.rejects(
      verifyElectronUpdaterMetadata(dmg.metadataPath),
      /must reference a ZIP updater artifact/,
    );
  });

  it("rejects a stale legacy path mapping", async () => {
    const value = await fixture();
    value.metadata.path = "other.exe";
    await writeFile(value.metadataPath, dump(value.metadata));

    await assert.rejects(
      verifyElectronUpdaterMetadata(value.metadataPath),
      /absent from files/,
    );
  });
});
