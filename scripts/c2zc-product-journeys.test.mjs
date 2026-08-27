import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { resolveProductJourneyImpactCatalog } from "../electron/scripts/product-journey-impact.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";
import { C2ZC_PRODUCT_JOURNEY_PHASES } from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import { PRODUCT_JOURNEY_ELECTRON_PHASES } from "../electron/scripts/product-journey-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("C2-ZC is registered as a distinct product journey and contract boundary", () => {
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].contracts,
    ["c2-zc:canonical-authority-cutover", "c2-zc:post-marker-lifecycle"],
  );
  assert.ok(
    PRODUCT_JOURNEY_CATALOG.some(
      (journey) => journey.id === "c2-zc-canonical-authority-cutover",
    ),
  );
  assert.deepEqual(
    resolveProductJourneySet("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    resolveProductJourneyImpactCatalog("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEYS.length, 1);
});

test("C2-ZC journey launch phases are registered for clean Electron diagnostics", () => {
  for (const phase of C2ZC_PRODUCT_JOURNEY_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
});

test("C2-ZC runner reaches the marker only through main scheduler and N-API", async () => {
  const [runner, main, napi] = await Promise.all([
    read("electron/scripts/c2zc-canonical-product-journey.mjs"),
    read("electron/main/index.ts"),
    read("electron/native/grimodex-node/src/lib.rs"),
  ]);

  assert.match(runner, /harness\.launch\(`\$\{C2ZC_PRODUCT_JOURNEY_ID\}\/open`\)/);
  assert.match(runner, /harness\.launch\(`\$\{C2ZC_PRODUCT_JOURNEY_ID\}\/restart`\)/);
  assert.match(runner, /harness\.invokeOk\(page, "project_create"/);
  assert.match(runner, /schema_data_migrations/);
  assert.match(runner, /activationOwner: "electron-main:narrativeFreshness->napi"/);
  assert.doesNotMatch(runner, /cut_over_workspace_freshness|record_c2zc_cutover_marker/);
  assert.match(main, /createNarrativeFreshnessScheduler\(backend\)/);
  assert.match(main, /narrativeFreshness\.start\(\)/);
  assert.match(napi, /run_incremental_freshness_cycle_with_liveness_capability/);
  assert.match(napi, /record_live_scheduler_heartbeat/);
  assert.match(napi, /cut_over_workspace_freshness/);
  assert.match(napi, /NEX_C2ZC_CUTOVER_NOT_READY:/);
});

test("C2-ZC acceptance packet maps failure, swap/stale, restore/import, and birth tests", async () => {
  const [cutover, liveness, importCommit, backupRestore, domainWrites] =
    await Promise.all([
      read("src-tauri/crates/grimodex-db/tests/narrative_c2zc_canonical_cutover.rs"),
      read("src-tauri/crates/grimodex-db/tests/narrative_c2zc_liveness_binding.rs"),
      read("src-tauri/crates/grimodex-db/tests/import_session_commit.rs"),
      read("src-tauri/crates/grimodex-db/src/backup_restore.rs"),
      read("src-tauri/crates/grimodex-db/src/domain_writes.rs"),
    ]);

  for (const testName of [
    "cutover_refuses_incomplete_workspace_before_any_authority_marker",
    "cutover_rejects_evaluated_freshness_without_a_publisher_run",
    "canonical_read_rejects_non_incremental_or_stale_evaluation_run_reference",
    "canonical_read_has_no_legacy_fallback_after_generic_cutover",
  ]) {
    assert.match(cutover, new RegExp(`fn ${testName}`), testName);
  }
  for (const testName of [
    "completed_cycle_capability_cannot_cross_database_authority",
    "completed_cycle_capability_expires_before_a_late_heartbeat",
    "authority_generation_replacement_rejects_the_previous_receipt",
  ]) {
    assert.match(liveness, new RegExp(`fn ${testName}`), testName);
  }
  assert.match(importCommit, /post_marker_import_binds_one_initial_epoch/);
  assert.match(backupRestore, /ensure_restore_c2zc_authority_not_downgraded/);
  assert.match(domainWrites, /project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker/);
});

test("C2-ZC journey is named in the quality impact manifest", async () => {
  const manifest = await read("evals/impact-map.yaml");
  assert.match(manifest, /accepted C2-ZC canonical-authority journey/);
  assert.match(manifest, /electron\/scripts\/c2zc-canonical-product-journey\.mjs/);
  assert.match(manifest, /scripts\/c2zc-product-journeys\.test\.mjs/);
});
