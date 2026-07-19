#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FORBIDDEN_CHUNK_PREFIXES = [
  "TransferDialog-",
  "ExportDialog-",
  "SettingsDialog-",
];

const FORBIDDEN_NETWORK_PATTERNS = [
  /https:\/\/openrouter\.ai\/api\//i,
  /\/api\/openrouter\b/i,
  /\/api\/(?:uploads|scans)\b/i,
  /\/api\/v1\/(?:editor-seeds|scans|session|upload-intents)\b/i,
  /\/api\/editor\/(?:ai|sessions)\b/i,
  /VITE_SCAN_API_BASE_URL/i,
  /grimodex-scan[^/"']*\.(?:pages\.dev|workers\.dev)/i,
];

const FORBIDDEN_WEB_IMPORT_PATTERNS = [
  /import-source-scan/i,
  /grimodex-scan\/import-plan\/1/i,
];

const FORBIDDEN_WEB_IMPORT_TRANSPORT_PATTERNS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bFormData\b/,
  /\bnavigator\s*\.\s*sendBeacon\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
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

export async function validateWebEditorArtifact(root) {
  const files = await walkFiles(root);
  if (!files.some((file) => path.basename(file) === "index.html")) {
    throw new Error("Web Editor artifact is missing index.html");
  }

  for (const file of files) {
    const basename = path.basename(file);
    if (
      FORBIDDEN_CHUNK_PREFIXES.some((prefix) => basename.startsWith(prefix))
    ) {
      throw new Error(
        `Desktop-only chunk entered Web Editor artifact: ${basename}`,
      );
    }
    if (!/\.(?:html|js|mjs|json|md|txt)$/.test(basename)) continue;
    const contents = await readFile(file, "utf8");
    const forbidden = FORBIDDEN_NETWORK_PATTERNS.find((pattern) =>
      pattern.test(contents),
    );
    if (forbidden) {
      throw new Error(
        `Retired hosted AI/Scan network route entered Web Editor artifact: ${basename}`,
      );
    }
    const forbiddenImport = FORBIDDEN_WEB_IMPORT_PATTERNS.find((pattern) =>
      pattern.test(contents),
    );
    if (forbiddenImport) {
      throw new Error(
        `Retired Scan import entered Web Editor artifact: ${basename}`,
      );
    }
    if (basename.startsWith("WebEditorImportDialog-")) {
      const forbiddenTransport = FORBIDDEN_WEB_IMPORT_TRANSPORT_PATTERNS.find(
        (pattern) => pattern.test(contents),
      );
      if (forbiddenTransport) {
        throw new Error(
          `Web Editor import network transport entered artifact: ${basename}`,
        );
      }
    }
  }

  const hasWebSettings = files.some((file) =>
    path.basename(file).startsWith("WebEditorSettingsDialog-"),
  );
  if (!hasWebSettings) {
    throw new Error("Web Editor-specific settings chunk was not emitted");
  }
  const hasWebImport = files.some((file) =>
    path.basename(file).startsWith("WebEditorImportDialog-"),
  );
  if (!hasWebImport) {
    throw new Error("Web Editor browser-local import dialog was not emitted");
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
  validateWebEditorArtifact(
    path.resolve(repositoryRoot, process.argv[2] ?? "dist"),
  )
    .then(() => console.log("Web Editor artifact boundary is clean."))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
