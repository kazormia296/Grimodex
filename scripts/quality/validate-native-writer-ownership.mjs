#!/usr/bin/env node
/**
 * Fail CI when active protected Narrative tables are mutated via SQL string
 * literals outside their canonical Rust writer module (plus migration / seed /
 * test allowlist).
 *
 * Gate B2 cutover PRs expand WRITER_TO_MODULES as Aggregate Writers land.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

const SCAN_ROOTS = [
  "src-tauri/crates/grimodex-db/src",
  "src-tauri/crates/grimodex-core/src",
  "electron/native/grimodex-node/src",
];

const ALLOWED_PATH_FRAGMENTS = [
  "/migrate.rs",
  "/migration_",
  "/seed",
  "/tests/",
  "tests.rs",
  "/bin/",
  "schema_contract",
  "narrative_runtime_policy.rs",
  "protected_writers.rs",
  // Authorizer / registry self-tests embed fixture DML strings.
  "/execute.rs",
  // Checkpoint unit tests seed the policy singleton in-process.
  "workspace_schema.rs",
  // Runtime performance fixtures seed multiple protected aggregates directly.
  "runtime_performance_seed.rs",
];

/**
 * Canonical Rust modules allowed to emit SQL against an active writer id.
 * Cutover PRs must register domain_writers/* here when flipping enforcement.
 */
const WRITER_TO_MODULES = {
  "project.lifecycle": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/import/commit.rs",
    "src-tauri/crates/grimodex-db/src/sample_seed.rs",
  ],
  "narrative.runtime_policy": [
    "src-tauri/crates/grimodex-db/src/narrative_runtime_policy.rs",
  ],
  "narrative.fixture": [
    "src-tauri/crates/grimodex-db/src/protected_writers.rs",
    "src-tauri/crates/grimodex-db/src/execute.rs",
  ],
  "narrative.authority": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/commit.rs",
    // C2A's dormant Native Human writer appends immutable proposal revisions
    // and their source-basis rows under the same authority boundary.
    "src-tauri/crates/grimodex-db/src/narrative_extraction/human_derivation.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
    // Gate C2 item 4: narrative_application_contributions carries
    // maintenance_ownership, which records that a human took a field. Generic
    // renderer/MCP SQL must not be able to hand it back, so the table is
    // protected and only these two modules write it -- the ledger writer and
    // the Change Feed projection that moves target_state.
    "src-tauri/crates/grimodex-db/src/narrative_extraction/application_contributions.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/contribution_target_state.rs",
  ],
  "narrative.revision-envelope": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
  ],
  "narrative.freshness": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/commit.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/field_authority.rs",
  ],
  "narrative.field-authority": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/field_authority.rs",
  ],
  "narrative.maintenance-feed": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/change_feed.rs",
    // Gate C2 Lane I: SCHEMA_VERSION 23 reservation columns on the same
    // narrative_change_cursors table, split into its own module for
    // clarity — still the narrative.maintenance-feed writer authority.
    "src-tauri/crates/grimodex-db/src/narrative_extraction/cursor_reservation.rs",
  ],
  // Gate C2 Lane D: narrative_maintenance_attention is durable,
  // non-epoch-bound, backflowPolicy "forbid" user state -- a distinct
  // writer authority from the Change Feed tables above, never appending
  // to narrative_change_transactions/narrative_change_events.
  "narrative.maintenance-attention": [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/attention.rs",
  ],
  // D1 sealed dependency declarations are persisted only by their typed
  // storage boundary. Keep this mapping exact so future runtime modules do
  // not inherit write authority over the declaration shadow tables.
  "narrative.dependency-declaration": [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/declaration_storage.rs",
  ],
  // C2A execution-state task rows have a deliberately wider writer set: the
  // scheduler, lease/runtime paths, freshness recovery, and maintenance
  // lifecycle all transition task state. Keep this list exact so a generic
  // Rust SQL caller cannot inherit task authority.
  "narrative.extraction-task": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/execution_state.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_lifecycle.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/task_leases.rs",
  ],
  // Attempt transitions are not lease-owned task mutations, so task_leases.rs
  // is intentionally absent from this writer's allowlist.
  "narrative.extraction-attempt": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/execution_state.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_lifecycle.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
  ],
  // Artifacts are emitted by the task repository and removed with the domain
  // cleanup writer; no scheduler/maintenance module owns their rows.
  "narrative.extraction-artifact": [
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
  ],
  // SCHEMA 34 stage model bindings and terminal receipts are durable
  // non-authoritative C2A rows. The typed stage-provenance module is their
  // sole production writer; the ephemeral closure is never a table.
  "narrative.stage-provenance": [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/stage_provenance.rs",
  ],
  // schema_data_migrations records which data migrations have completed, and
  // the schema checkpoint reads it to decide whether a migration re-runs.
  // That makes it migration authority rather than diagnostics: a forged
  // contract_version would skip a migration that never ran, and a deleted
  // row would force every open to discard C2 derived state. Only the
  // migration engine writes it.
  "schema.migration": ["src-tauri/crates/grimodex-db/src/migrate.rs"],
  "chronicle.event": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/chronicle.rs",
    "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/chronicle_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
  ],
  "foreshadow.aggregate": [
    "src-tauri/crates/grimodex-db/src/foreshadow.rs",
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/foreshadow_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/foreshadow_undo.rs",
    "src-tauri/crates/grimodex-db/src/scene_body.rs",
    "src-tauri/crates/grimodex-db/src/trash_bin.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/sample_seed.rs",
    "src-tauri/crates/grimodex-db/src/fts.rs",
    "src-tauri/crates/grimodex-db/src/tests.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
    "src-tauri/crates/grimodex-core/src/undo_journal.rs",
  ],
  "tree.node": [
    "src-tauri/crates/grimodex-db/src/change_events.rs",
    "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/foreshadow.rs",
    "src-tauri/crates/grimodex-db/src/lint_ignores.rs",
    "src-tauri/crates/grimodex-db/src/map_writes.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
    "src-tauri/crates/grimodex-db/src/plot_threads.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/revision_restore.rs",
    "src-tauri/crates/grimodex-db/src/sample_seed.rs",
    "src-tauri/crates/grimodex-db/src/scene_body.rs",
    "src-tauri/crates/grimodex-db/src/trash_bin.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-core/src/change_events.rs",
    "src-tauri/crates/grimodex-core/src/undo_journal.rs",
  ],
  "temporal.calendar": [
    "src-tauri/crates/grimodex-db/src/chronicle.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
  ],
  "codex.catalog": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/chronicle.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/foreshadow.rs",
    "src-tauri/crates/grimodex-db/src/map_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-core/src/writes/codex.rs",
  ],
  "plot_threads.aggregate": [
    "src-tauri/crates/grimodex-db/src/plot_threads.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/plot_thread_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/plot_thread_undo.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
  ],
  "plot_threads.branch": [
    "src-tauri/crates/grimodex-db/src/plot_threads.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/plot_thread_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/plot_thread_undo.rs",
  ],
  "codex.entry": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/scene_body.rs",
    "src-tauri/crates/grimodex-db/src/chronicle.rs",
    "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
    "src-tauri/crates/grimodex-db/src/foreshadow.rs",
    "src-tauri/crates/grimodex-db/src/map_writes.rs",
    "src-tauri/crates/grimodex-db/src/backup_restore.rs",
    "src-tauri/crates/grimodex-db/src/sample_seed.rs",
    "src-tauri/crates/grimodex-db/src/fts.rs",
    "src-tauri/crates/grimodex-db/src/tests.rs",
    "src-tauri/crates/grimodex-db/src/trash_bin.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
    "src-tauri/crates/grimodex-core/src/undo_journal.rs",
    "src-tauri/crates/grimodex-core/src/writes/codex.rs",
  ],
  "snippet.entry": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/fts.rs",
    "src-tauri/crates/grimodex-db/src/integrity.rs",
    "src-tauri/crates/grimodex-db/src/map_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/sample_seed.rs",
    "src-tauri/crates/grimodex-db/src/snippet_writes.rs",
    "src-tauri/crates/grimodex-db/src/trash_bin.rs",
    "src-tauri/crates/grimodex-core/src/undo_journal.rs",
  ],
  "codex.relation": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/map_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/tests.rs",
  ],
  "codex.phase": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/phase_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/phase_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
    "src-tauri/crates/grimodex-db/src/tests.rs",
  ],
  "codex.detail": [
    "src-tauri/crates/grimodex-db/src/agent_writes.rs",
    "src-tauri/crates/grimodex-db/src/codex_writes.rs",
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/detail_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/phase_operations.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/phase_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/semantic_bindings.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
    "src-tauri/crates/grimodex-db/src/tests.rs",
  ],
};

const DML_RE =
  /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi;

function shouldSkip(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.endsWith(".rs")) return true;
  return ALLOWED_PATH_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function collectRustFiles(rootDir) {
  const abs = path.join(REPO_ROOT, rootDir);
  if (!existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "target" || entry === ".git") continue;
        stack.push(full);
      } else if (st.isFile() && full.endsWith(".rs")) {
        out.push(full);
      }
    }
  }
  return out;
}

function isAllowedForWriter(relativePath, writer) {
  const allowed = WRITER_TO_MODULES[writer] ?? [];
  const normalized = relativePath.replaceAll("\\", "/");
  return allowed.some(
    (modulePath) =>
      normalized === modulePath ||
      normalized.endsWith(`/${path.basename(modulePath)}`),
  );
}

function productionRustSource(source) {
  // This validator scans string literals rather than the expanded Rust AST.
  // Unit-test modules commonly seed protected roots directly; exclude the
  // first inline `#[cfg(test)] mod ... {}` tail so fixtures are not mistaken
  // for production writer ownership. External tests are already outside the
  // scan roots, and production modules conventionally precede their test tail.
  const testModule = source.match(
    /#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\[[^\]]+\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/u,
  );
  return testModule?.index === undefined
    ? source
    : source.slice(0, testModule.index);
}

export function validateNativeWriterOwnership({
  repoRoot = REPO_ROOT,
  registryPath = REGISTRY_PATH,
} = {}) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const active = registry.filter((entry) => entry.enforcement === "active");
  const tableToWriter = new Map(
    active.map((entry) => [entry.table, entry.writer]),
  );
  const files = SCAN_ROOTS.flatMap((root) => collectRustFiles(root));
  const violations = [];

  for (const file of files) {
    const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
    if (shouldSkip(relative)) continue;
    const source = productionRustSource(readFileSync(file, "utf8"));
    DML_RE.lastIndex = 0;
    let match;
    while ((match = DML_RE.exec(source)) !== null) {
      const table = match[2];
      const writer = tableToWriter.get(table);
      if (!writer) continue;
      if (isAllowedForWriter(relative, writer)) continue;
      violations.push({
        file: relative,
        table,
        writer,
        snippet: match[0].replace(/\s+/g, " ").slice(0, 80),
      });
    }
  }

  return {
    activeCount: active.length,
    scannedFiles: files.length,
    violations,
  };
}

function main() {
  const result = validateNativeWriterOwnership();
  if (result.violations.length > 0) {
    console.error(
      "Active protected tables have SQL mutations outside canonical native writers:",
    );
    for (const violation of result.violations) {
      console.error(
        `  - ${violation.file}: ${violation.table} (${violation.writer}) via ${violation.snippet}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `validate-native-writer-ownership: ok (active=${result.activeCount}, scanned=${result.scannedFiles})`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
