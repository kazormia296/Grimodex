#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_OPTIONS = [
  "assets-dir",
  "output",
  "source-repository",
  "source-tag",
  "source-commit",
  "source-run-id",
  "source-run-attempt",
  "publication-repository",
  "publication-tag",
];

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (options.has(name)) {
      throw new Error(`Duplicate option: --${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  for (const name of REQUIRED_OPTIONS) {
    if (!options.has(name)) {
      throw new Error(`Missing required option: --${name}`);
    }
  }
  return options;
}

async function digestAsset(assetsDir, name) {
  const assetPath = path.join(assetsDir, name);
  const metadata = await stat(assetPath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Release asset must be a non-empty file: ${name}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(assetPath)) hash.update(chunk);
  return {
    name,
    size: metadata.size,
    sha256: hash.digest("hex"),
  };
}

export async function writeReleaseProvenance(options) {
  const assetsDir = path.resolve(options.get("assets-dir"));
  const outputPath = path.resolve(options.get("output"));
  const outputName = path.basename(outputPath);
  const names = (await readdir(assetsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== outputName)
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error("Release provenance requires at least one asset");
  }

  const assets = [];
  for (const name of names) {
    assets.push(await digestAsset(assetsDir, name));
  }

  const provenance = {
    schemaVersion: 1,
    source: {
      repository: options.get("source-repository"),
      tag: options.get("source-tag"),
      commit: options.get("source-commit"),
      runId: options.get("source-run-id"),
      runAttempt: Number(options.get("source-run-attempt")),
    },
    publication: {
      repository: options.get("publication-repository"),
      tag: options.get("publication-tag"),
    },
    assets,
  };

  if (!Number.isSafeInteger(provenance.source.runAttempt)) {
    throw new Error("source-run-attempt must be a safe integer");
  }
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await writeReleaseProvenance(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
