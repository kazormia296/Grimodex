#!/usr/bin/env node
/**
 * Fail CI when production TypeScript still mutates active protected Narrative
 * writer tables via Drizzle (`db.insert|update|delete(...)`).
 *
 * Domain cutover PRs flip `enforcement` to `active` in
 * `policies/narrative/protected-writers.json`. Deferred entries are reported
 * but do not fail the gate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
  ".git",
  "target",
  "storybook-static",
]);

const EXCLUDED_PATH_FRAGMENTS = [
  ".test.ts",
  ".test.tsx",
  ".browser.test.ts",
  ".browser.test.tsx",
  ".stories.",
  "/browser-mock",
  "/__fixtures__/",
  "/fixtures/",
  "/generated/",
  "schema-seed",
  "seed_schema",
];

/**
 * Map registry SQL table names to common Drizzle schema export identifiers.
 * Domain cutovers should keep this map in sync when adding tables.
 */
const TABLE_TO_DRIZZLE_IDENTIFIERS = {
  foreshadows: ["foreshadows"],
  foreshadow_setups: ["foreshadowSetups"],
  foreshadow_payoffs: ["foreshadowPayoffs"],
  foreshadow_codex_links: ["foreshadowCodexLinks"],
  plot_threads: ["plotThreads"],
  plot_thread_scene_links: ["plotThreadSceneLinks"],
  plot_thread_branches: ["plotThreadBranches"],
  events: ["events"],
  event_participants: ["eventParticipants"],
  scene_events: ["sceneEvents"],
  event_relations: ["eventRelations"],
  tree_nodes: ["treeNodes"],
  codex_entries: ["codexEntries"],
  codex_relations: ["codexRelations"],
  codex_entry_phases: ["codexEntryPhases"],
  codex_detail_definitions: ["codexDetailDefinitions"],
  codex_detail_values: ["codexDetailValues"],
  narrative_protected_fixture: ["narrativeProtectedFixture"],
  narrative_protected_shared_fixture: ["narrativeProtectedSharedFixture"],
};

function shouldScanFile(filePath) {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  const normalized = filePath.split(path.sep).join("/");
  return !EXCLUDED_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function walkSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (shouldScanFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function findDrizzleMutations(source, identifiers) {
  const findings = [];
  for (const ident of identifiers) {
    const patterns = [
      new RegExp(`db\\.insert\\(\\s*${ident}\\b`, "g"),
      new RegExp(`db\\.update\\(\\s*${ident}\\b`, "g"),
      new RegExp(`db\\.delete\\(\\s*${ident}\\b`, "g"),
    ];
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        findings.push(ident);
      }
    }
  }
  return findings;
}

export function validateNarrativeWriters({
  repoRoot = REPO_ROOT,
  registryPath = REGISTRY_PATH,
} = {}) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const active = registry.filter((entry) => entry.enforcement === "active");
  const deferred = registry.filter((entry) => entry.enforcement === "deferred");
  const srcRoot = path.join(repoRoot, "src");
  const files = walkSourceFiles(srcRoot);
  const violations = [];

  for (const entry of active) {
    const identifiers =
      TABLE_TO_DRIZZLE_IDENTIFIERS[entry.table] ?? [entry.table];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const hits = findDrizzleMutations(source, identifiers);
      if (hits.length === 0) continue;
      violations.push({
        file: path.relative(repoRoot, file),
        table: entry.table,
        writer: entry.writer,
        identifiers: hits,
      });
    }
  }

  return {
    activeCount: active.length,
    deferredCount: deferred.length,
    scannedFiles: files.length,
    violations,
  };
}

function main() {
  const result = validateNarrativeWriters();
  if (result.violations.length > 0) {
    console.error("Active protected Narrative writers still have production Drizzle mutations:");
    for (const violation of result.violations) {
      console.error(
        `  - ${violation.file}: ${violation.table} (${violation.writer}) via ${violation.identifiers.join(", ")}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `validate-narrative-writers: ok (active=${result.activeCount}, deferred=${result.deferredCount}, scanned=${result.scannedFiles})`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
