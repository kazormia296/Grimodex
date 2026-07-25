#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WEBGPU_ONLY_FILE_PATTERNS = [/^webllm\.worker-/i];
const WEBGPU_ONLY_CONTENT_PATTERNS = [
  /\bCreateWebWorkerMLCEngine\b/,
  /\bCreateMLCEngine\b/,
];

async function walkFiles(root) {
  const files = [];
  for (const entry of await readdir(root)) {
    const target = path.join(root, entry);
    const metadata = await stat(target);
    if (metadata.isDirectory()) files.push(...(await walkFiles(target)));
    else files.push(target);
  }
  return files;
}

export async function validateDesktopArtifact(root) {
  const files = await walkFiles(root);
  if (!files.some((file) => path.basename(file) === "index.html")) {
    throw new Error("Desktop renderer artifact is missing index.html");
  }

  for (const file of files) {
    const basename = path.basename(file);
    if (WEBGPU_ONLY_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
      throw new Error(
        `Web Editor-only WebLLM worker entered desktop artifact: ${basename}`,
      );
    }
    if (!/\.(?:js|mjs)$/.test(basename)) continue;
    const contents = await readFile(file, "utf8");
    if (
      WEBGPU_ONLY_CONTENT_PATTERNS.some((pattern) => pattern.test(contents))
    ) {
      throw new Error(
        `Web Editor-only WebLLM runtime entered desktop artifact: ${basename}`,
      );
    }
  }
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  validateDesktopArtifact(
    path.resolve(repositoryRoot, process.argv[2] ?? "dist"),
  )
    .then(() => console.log("Desktop renderer artifact boundary is clean."))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
