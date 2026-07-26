import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { load } from "js-yaml";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function safeArtifactName(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contains invalid URL encoding: ${value}`);
  }
  if (
    decoded !== value ||
    decoded === "." ||
    decoded === ".." ||
    path.posix.basename(decoded) !== decoded ||
    path.win32.basename(decoded) !== decoded
  ) {
    throw new Error(
      `${label} must be a plain local artifact filename: ${value}`,
    );
  }
  return decoded;
}

function requireSha512(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw new Error(`${label} must be a base64-encoded SHA-512 digest`);
  }
  return value;
}

async function digestFile(filePath) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("base64");
}

async function verifyFileEntry(metadataDir, entry, index) {
  const record = requireObject(entry, `files[${index}]`);
  const name = safeArtifactName(record.url, `files[${index}].url`);
  const expectedDigest = requireSha512(record.sha512, `files[${index}].sha512`);
  if (!Number.isSafeInteger(record.size) || record.size < 0) {
    throw new Error(`files[${index}].size must be a non-negative safe integer`);
  }

  const artifactPath = path.join(metadataDir, name);
  const fileStat = await stat(artifactPath).catch((cause) => {
    throw new Error(`Updater artifact is missing: ${artifactPath}`, { cause });
  });
  if (!fileStat.isFile()) {
    throw new Error(`Updater artifact is not a regular file: ${artifactPath}`);
  }
  if (fileStat.size !== record.size) {
    throw new Error(
      `Updater artifact size mismatch for ${name}: expected ${record.size}, received ${fileStat.size}`,
    );
  }

  const actualDigest = await digestFile(artifactPath);
  if (actualDigest !== expectedDigest) {
    throw new Error(`Updater artifact SHA-512 mismatch for ${name}`);
  }
  return { name, sha512: actualDigest, size: fileStat.size };
}

export async function verifyElectronUpdaterMetadata(metadataPath) {
  const absoluteMetadataPath = path.resolve(metadataPath);
  const metadata = requireObject(
    load(await readFile(absoluteMetadataPath, "utf8")),
    "updater metadata",
  );
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error("updater metadata files must be a non-empty array");
  }

  const metadataDir = path.dirname(absoluteMetadataPath);
  const verified = await Promise.all(
    metadata.files.map((entry, index) =>
      verifyFileEntry(metadataDir, entry, index),
    ),
  );
  const byName = new Map();
  for (const entry of verified) {
    if (byName.has(entry.name)) {
      throw new Error(`Duplicate updater artifact entry: ${entry.name}`);
    }
    byName.set(entry.name, entry);
  }

  const hasLegacyPath = metadata.path !== undefined;
  const hasLegacyDigest = metadata.sha512 !== undefined;
  if (hasLegacyPath !== hasLegacyDigest) {
    throw new Error("Legacy updater path and sha512 must be present together");
  }
  if (hasLegacyPath) {
    const legacyName = safeArtifactName(metadata.path, "path");
    const legacyDigest = requireSha512(metadata.sha512, "sha512");
    const matchingEntry = byName.get(legacyName);
    if (!matchingEntry) {
      throw new Error(
        `Legacy updater path is absent from files: ${legacyName}`,
      );
    }
    if (matchingEntry.sha512 !== legacyDigest) {
      throw new Error(`Legacy updater SHA-512 mismatch for ${legacyName}`);
    }
  }

  if (path.basename(absoluteMetadataPath) === "latest-mac.yml") {
    if (!verified.some(({ name }) => name.endsWith(".zip"))) {
      throw new Error("latest-mac.yml must reference a ZIP updater artifact");
    }
    if (verified.some(({ name }) => name.endsWith(".dmg"))) {
      throw new Error("latest-mac.yml must not reference a stapled DMG");
    }
  }

  return verified;
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--metadata") {
    throw new Error(
      "Usage: node scripts/verify-electron-updater-metadata.mjs --metadata <latest*.yml>",
    );
  }
  return argv[1];
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const metadataPath = parseCli(process.argv.slice(2));
  const verified = await verifyElectronUpdaterMetadata(metadataPath);
  console.log(
    `Verified ${verified.length} updater artifact(s) from ${path.resolve(metadataPath)}`,
  );
}
