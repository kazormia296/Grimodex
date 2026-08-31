import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PRODUCT_JOURNEY_CATALOG_DIGEST } from "../electron/scripts/product-journey-catalog.mjs";
import {
  C2ZC_RUST_ACCEPTANCE_GATES,
  C2ZC_RUST_ACCEPTANCE_RECEIPT_VERSION,
  C2ZC_RUST_VERIFY_CONTRACT_VERSION,
  C2ZC_RUST_VERIFY_COVERAGE,
  C2ZC_RUST_VERIFY_COMPILED_CHECKS,
  C2ZC_RUST_VERIFY_CHECKS,
  createC2ZcRustAcceptanceReceipt,
  resolveC2ZcRustAcceptanceCandidate,
  verifyC2ZcRustAcceptanceReceipt,
} from "./c2zc-rust-acceptance-receipt.mjs";

const VERIFY_OUTCOME = {
  verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
  checkCoverage: C2ZC_RUST_VERIFY_COVERAGE,
};
const VERIFY_OUTCOME_JSON = JSON.stringify(VERIFY_OUTCOME);

function candidate(overrides = {}) {
  return {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
    ...overrides,
  };
}

const OUTPUT_BY_GATE_ID = {
  "c2-zc-canonical-no-legacy-fallback": `test canonical_read_has_no_legacy_fallback_after_generic_cutover ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-dml-native-owned-table-denial": `test execute::tests::c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-readiness-corruption-fail-closed": `test narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-liveness-restore-lock-binding": `test same_project_receipt_cannot_cross_database_authority ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-native-restore-lock-release": `test narrative_freshness_restore_lock_tests::completed_freshness_cycle_releases_authority_before_restore_quiescence ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-project-create-event-bound-e0": `test domain_writes::tests::project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-import-apply-event-bound-e0": `test post_marker_import_binds_one_initial_epoch_to_the_import_apply_event ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-scan-staging-publish-atomic-replay": `test domain_writes::tests::scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-hidden-staging-cutover-scope": `test hidden_scan_staging_project_is_outside_cutover_scope_until_publish ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-hidden-staging-discovery-exclusion": `test narrative_extraction::maintenance_runtime::tests::hidden_scan_staging_project_is_not_discovered_until_marker_is_removed ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-pre-marker-before-cutover-liveness": `test narrative_extraction::maintenance_runtime::tests::pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-native-discovery-hidden-staging-exclusion": `test narrative_maintenance::tests::native_discovery_excludes_hidden_scan_staging_projects ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-web-cutover-marker-rejection": `test rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-web-nonempty-semantic-epoch-rejection": `test rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-web-poisoned-schema-data-migrations-rejection": `test rejects_empty_poisoned_schema_data_migrations_before_publishing ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-web-poisoned-semantic-epoch-schema-rejection": `test rejects_empty_poisoned_semantic_epoch_schema_before_publishing ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
  "c2-zc-production-verify-coverage": `C2ZC_RUST_VERIFY_OUTCOME=${VERIFY_OUTCOME_JSON}

test narrative_extraction::restore_rebuild::tests::a_verify_run_records_its_report_under_a_completed_run ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`,
};

const ADDITIONAL_GATE_EXPECTATIONS = [
  {
    id: "c2-zc-project-create-event-bound-e0",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "domain_writes::tests::project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/src/domain_writes.rs",
      test: "project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker",
      fullTestName:
        "domain_writes::tests::project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker",
      proof: "post-marker project_create mints one event-bound initial epoch",
    },
    source: "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    test: "project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker",
    fullTestName:
      "domain_writes::tests::project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-import-apply-event-bound-e0",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "import_session_commit",
        "post_marker_import_binds_one_initial_epoch_to_the_import_apply_event",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/tests/import_session_commit.rs",
      test: "post_marker_import_binds_one_initial_epoch_to_the_import_apply_event",
      fullTestName:
        "post_marker_import_binds_one_initial_epoch_to_the_import_apply_event",
      proof: "post-marker import apply binds one initial epoch to its event",
    },
    source: "src-tauri/crates/grimodex-db/tests/import_session_commit.rs",
    test: "post_marker_import_binds_one_initial_epoch_to_the_import_apply_event",
    fullTestName:
      "post_marker_import_binds_one_initial_epoch_to_the_import_apply_event",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-scan-staging-publish-atomic-replay",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "domain_writes::tests::scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/src/domain_writes.rs",
      test: "scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch",
      fullTestName:
        "domain_writes::tests::scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch",
      proof:
        "Scan staging publish is atomic and replays the same receipt and epoch",
    },
    source: "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    test: "scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch",
    fullTestName:
      "domain_writes::tests::scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-hidden-staging-cutover-scope",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_c2zc_canonical_cutover",
        "hidden_scan_staging_project_is_outside_cutover_scope_until_publish",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/tests/narrative_c2zc_canonical_cutover.rs",
      test: "hidden_scan_staging_project_is_outside_cutover_scope_until_publish",
      fullTestName:
        "hidden_scan_staging_project_is_outside_cutover_scope_until_publish",
      proof:
        "hidden Scan staging stays outside cutover scope until publish and re-enters after publish",
    },
    source:
      "src-tauri/crates/grimodex-db/tests/narrative_c2zc_canonical_cutover.rs",
    test: "hidden_scan_staging_project_is_outside_cutover_scope_until_publish",
    fullTestName:
      "hidden_scan_staging_project_is_outside_cutover_scope_until_publish",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-hidden-staging-discovery-exclusion",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::maintenance_runtime::tests::hidden_scan_staging_project_is_not_discovered_until_marker_is_removed",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
      test: "hidden_scan_staging_project_is_not_discovered_until_marker_is_removed",
      fullTestName:
        "narrative_extraction::maintenance_runtime::tests::hidden_scan_staging_project_is_not_discovered_until_marker_is_removed",
      proof: "hidden Scan staging projects stay out of discovery until publish",
    },
    source:
      "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
    test: "hidden_scan_staging_project_is_not_discovered_until_marker_is_removed",
    fullTestName:
      "narrative_extraction::maintenance_runtime::tests::hidden_scan_staging_project_is_not_discovered_until_marker_is_removed",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-pre-marker-before-cutover-liveness",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::maintenance_runtime::tests::pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source:
        "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
      test: "pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen",
      fullTestName:
        "narrative_extraction::maintenance_runtime::tests::pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen",
      proof:
        "pre-marker BeforeCutover discovery enters Backfill without reopen",
    },
    source:
      "src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs",
    test: "pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen",
    fullTestName:
      "narrative_extraction::maintenance_runtime::tests::pre_marker_visible_project_enters_backfill_on_before_cutover_without_reopen",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-native-discovery-hidden-staging-exclusion",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "electron/native/grimodex-node/Cargo.toml",
        "--lib",
        "narrative_maintenance::tests::native_discovery_excludes_hidden_scan_staging_projects",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "electron/native/grimodex-node/src/narrative_maintenance.rs",
      test: "native_discovery_excludes_hidden_scan_staging_projects",
      fullTestName:
        "narrative_maintenance::tests::native_discovery_excludes_hidden_scan_staging_projects",
      proof:
        "native maintenance discovery excludes hidden Scan staging projects",
    },
    source: "electron/native/grimodex-node/src/narrative_maintenance.rs",
    test: "native_discovery_excludes_hidden_scan_staging_projects",
    fullTestName:
      "narrative_maintenance::tests::native_discovery_excludes_hidden_scan_staging_projects",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-web-cutover-marker-rejection",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "web_editor_handoff",
        "rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
      test: "rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing",
      fullTestName:
        "rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing",
      proof: "Web handoff rejects current, future, and foreign C2-ZC markers",
    },
    source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
    test: "rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing",
    fullTestName:
      "rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-web-nonempty-semantic-epoch-rejection",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "web_editor_handoff",
        "rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
      test: "rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate",
      fullTestName:
        "rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate",
      proof:
        "Web handoff rejects a non-empty semantic epoch and cleans the candidate",
    },
    source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
    test: "rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate",
    fullTestName:
      "rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-web-poisoned-schema-data-migrations-rejection",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "web_editor_handoff",
        "rejects_empty_poisoned_schema_data_migrations_before_publishing",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
      test: "rejects_empty_poisoned_schema_data_migrations_before_publishing",
      fullTestName:
        "rejects_empty_poisoned_schema_data_migrations_before_publishing",
      proof:
        "Web handoff rejects an empty poisoned schema_data_migrations schema",
    },
    source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
    test: "rejects_empty_poisoned_schema_data_migrations_before_publishing",
    fullTestName:
      "rejects_empty_poisoned_schema_data_migrations_before_publishing",
    requiresReceipt: true,
  },
  {
    id: "c2-zc-web-poisoned-semantic-epoch-schema-rejection",
    argv: {
      command: "cargo",
      args: [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "web_editor_handoff",
        "rejects_empty_poisoned_semantic_epoch_schema_before_publishing",
        "--",
        "--exact",
      ],
      cwd: ".",
    },
    contract: {
      source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
      test: "rejects_empty_poisoned_semantic_epoch_schema_before_publishing",
      fullTestName:
        "rejects_empty_poisoned_semantic_epoch_schema_before_publishing",
      proof: "Web handoff rejects an empty poisoned semantic epoch schema",
    },
    source: "src-tauri/crates/grimodex-db/tests/web_editor_handoff.rs",
    test: "rejects_empty_poisoned_semantic_epoch_schema_before_publishing",
    fullTestName:
      "rejects_empty_poisoned_semantic_epoch_schema_before_publishing",
    requiresReceipt: true,
  },
];

test("C2-ZC Rust receipt keeps readiness, liveness, and native restore-lock gates ordered", () => {
  assert.deepEqual(
    C2ZC_RUST_VERIFY_COMPILED_CHECKS,
    C2ZC_RUST_VERIFY_CHECKS,
    "the Rust production catalogue must stay bound to policy order",
  );
  assert.deepEqual(
    C2ZC_RUST_ACCEPTANCE_GATES.map(({ id }) => id),
    [
      "c2-zc-canonical-no-legacy-fallback",
      "c2-zc-dml-native-owned-table-denial",
      "c2-zc-readiness-corruption-fail-closed",
      "c2-zc-liveness-restore-lock-binding",
      "c2-zc-native-restore-lock-release",
      "c2-zc-production-verify-coverage",
      ...ADDITIONAL_GATE_EXPECTATIONS.map(({ id }) => id),
    ],
  );
  assert.deepEqual(
    C2ZC_RUST_ACCEPTANCE_GATES.slice(6),
    ADDITIONAL_GATE_EXPECTATIONS,
  );
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[3].contract.source,
    "src-tauri/crates/grimodex-db/tests/narrative_c2zc_liveness_binding.rs",
  );
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[4].contract.source,
    "electron/native/grimodex-node/src/lib.rs",
  );
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES[4].contract.heavy, true);
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES[4].contract.fullCiPreflight, true);
  assert.match(
    C2ZC_RUST_ACCEPTANCE_GATES[4].contract.designImpact,
    /skipped.*never passed/i,
  );
  assert.deepEqual(C2ZC_RUST_ACCEPTANCE_GATES[5].argv.args.slice(-2), [
    "--exact",
    "--nocapture",
  ]);
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[5].contract.fullTestName,
    "narrative_extraction::restore_rebuild::tests::a_verify_run_records_its_report_under_a_completed_run",
  );
});

function gateExecution(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: OUTPUT_BY_GATE_ID[overrides.id] ?? "",
    stderr: "",
    ...overrides,
  };
}

async function createReceipt({
  root,
  currentCandidate = candidate(),
  execute = async (_argv, { gate }) => gateExecution({ id: gate.id }),
  resolveCandidate = async () => currentCandidate,
  outputPath = ".artifacts/local-ci/c2-zc-rust-acceptance.json",
} = {}) {
  return createC2ZcRustAcceptanceReceipt({
    root,
    candidate: currentCandidate,
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    outputPath,
    execute,
    resolveCandidate,
  });
}

test("C2-ZC Rust receipt binds all exact gate commands and candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const observed = [];
  const result = await createReceipt({
    root,
    currentCandidate,
    execute: async (argv, { gate }) => {
      observed.push({ id: gate.id, argv });
      return gateExecution({ id: gate.id });
    },
  });

  assert.deepEqual(
    observed,
    C2ZC_RUST_ACCEPTANCE_GATES.map((gate) => ({
      id: gate.id,
      argv: gate.argv,
    })),
  );
  assert.equal(
    result.receiptPath,
    ".artifacts/local-ci/c2-zc-rust-acceptance.json",
  );
  assert.match(result.receiptSha256, /^sha256:[0-9a-f]{64}$/);
  const receipt = JSON.parse(
    await readFile(path.join(root, result.receiptPath), "utf8"),
  );
  assert.equal(receipt.schema, "grimodex.c2zc.rust-acceptance-receipt");
  assert.equal(receipt.version, C2ZC_RUST_ACCEPTANCE_RECEIPT_VERSION);
  assert.deepEqual(receipt.verifyOutcome, VERIFY_OUTCOME);
  assert.deepEqual(receipt.candidate, currentCandidate);
  assert.equal(receipt.catalogDigest, PRODUCT_JOURNEY_CATALOG_DIGEST);
  assert.deepEqual(
    receipt.gates.map(
      ({
        id,
        argv,
        contract,
        source,
        test,
        fullTestName,
        requiresReceipt,
      }) => ({
        id,
        argv,
        contract,
        source,
        test,
        fullTestName,
        requiresReceipt,
      }),
    ),
    C2ZC_RUST_ACCEPTANCE_GATES,
  );
  for (const [index, gate] of receipt.gates.entries()) {
    assert.equal(gate.exitStatus, 0);
    assert.equal(gate.signal, null);
    assert.equal(gate.testCount, 1);
    assert.equal(gate.passedCount, 1);
    assert.equal(gate.failedCount, 0);
    assert.equal(gate.stdout, OUTPUT_BY_GATE_ID[gate.id]);
    assert.equal(gate.stderr, "");
    assert.equal(
      gate.stdoutSha256,
      `sha256:${createHash("sha256").update(gate.stdout).digest("hex")}`,
    );
    assert.equal(
      gate.stderrSha256,
      `sha256:${createHash("sha256").update(gate.stderr).digest("hex")}`,
    );
    assert.equal(gate.id, C2ZC_RUST_ACCEPTANCE_GATES[index].id);
  }
  assert.equal(receipt.command, undefined);
  assert.equal(receipt.contract, undefined);
  assert.equal(receipt.exitStatus, undefined);
  assert.equal(receipt.receiptSha256, undefined);
  const sidecar = await readFile(
    `${path.join(root, result.receiptPath)}.sha256`,
    "utf8",
  );
  assert.equal(sidecar.trim(), result.receiptSha256);
  await assert.doesNotReject(() =>
    verifyC2ZcRustAcceptanceReceipt({
      root,
      candidate: currentCandidate,
      catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
      receiptPath: result.receiptPath,
      receiptSha256: result.receiptSha256,
    }),
  );
});

test("C2-ZC Rust receipt parses only one valid production Verify outcome sentinel", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const valid = OUTPUT_BY_GATE_ID["c2-zc-production-verify-coverage"];
  const runWithVerifyStdout = (stdout, stderr = "") =>
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gate.id === "c2-zc-production-verify-coverage"
          ? gateExecution({ id: gate.id, stdout, stderr })
          : gateExecution({ id: gate.id }),
    });

  await assert.doesNotReject(() => createReceipt({ root, currentCandidate }));
  for (const [label, stdout, stderr] of [
    ["missing", valid.replace(/C2ZC_RUST_VERIFY_OUTCOME=.*\n/u, ""), ""],
    [
      "bogus version",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({ ...VERIFY_OUTCOME, verifyContractVersion: "bogus" }),
      ),
      "",
    ],
    [
      "fake 13 IDs",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            required: Array.from({ length: 13 }, (_, index) => `fake-${index}`),
            covered: Array.from({ length: 13 }, (_, index) => `fake-${index}`),
          },
        }),
      ),
      "",
    ],
    [
      "one policy check replaced",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            required: [
              "fake-check",
              ...VERIFY_OUTCOME.checkCoverage.required.slice(1),
            ],
            covered: [
              "fake-check",
              ...VERIFY_OUTCOME.checkCoverage.covered.slice(1),
            ],
          },
        }),
      ),
      "",
    ],
    [
      "duplicate",
      `${valid}C2ZC_RUST_VERIFY_OUTCOME=${VERIFY_OUTCOME_JSON}\n`,
      "",
    ],
    [
      "stderr-only",
      valid.replace(/C2ZC_RUST_VERIFY_OUTCOME=.*\n/u, ""),
      `C2ZC_RUST_VERIFY_OUTCOME=${VERIFY_OUTCOME_JSON}\n`,
    ],
    ["malformed", valid.replace(VERIFY_OUTCOME_JSON, "{"), ""],
    [
      "incomplete",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: { ...VERIFY_OUTCOME.checkCoverage, complete: false },
        }),
      ),
      "",
    ],
    [
      "wrong count",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            required: VERIFY_OUTCOME.checkCoverage.required.slice(0, 12),
          },
        }),
      ),
      "",
    ],
    [
      "duplicate check",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            covered: [
              ...VERIFY_OUTCOME.checkCoverage.covered.slice(0, 12),
              VERIFY_OUTCOME.checkCoverage.covered[0],
            ],
          },
        }),
      ),
      "",
    ],
    [
      "nonempty missing",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            missing: ["unexpected-check"],
          },
        }),
      ),
      "",
    ],
    [
      "required covered mismatch",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            covered: [
              "different-check",
              ...VERIFY_OUTCOME.checkCoverage.covered.slice(1),
            ],
          },
        }),
      ),
      "",
    ],
    [
      "required covered order mismatch",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        JSON.stringify({
          ...VERIFY_OUTCOME,
          checkCoverage: {
            ...VERIFY_OUTCOME.checkCoverage,
            covered: [...VERIFY_OUTCOME.checkCoverage.covered].reverse(),
          },
        }),
      ),
      "",
    ],
    ["diagnostic prefix", `diagnostic-prefix ${valid}`, ""],
    ["leading space", ` ${valid}`, ""],
    [
      "diagnostic suffix",
      valid.replace(
        VERIFY_OUTCOME_JSON,
        `${VERIFY_OUTCOME_JSON} diagnostic-suffix`,
      ),
      "",
    ],
  ]) {
    await assert.rejects(
      runWithVerifyStdout(stdout, stderr),
      /sentinel|Verify outcome|coverage|13|duplicate|missing|malformed|stderr/i,
      label,
    );
  }
});

test("C2-ZC Rust receipt rejects gate omission, duplication, order, command, output, and hash mutations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const created = await createReceipt({ root, currentCandidate });
  const receiptFile = path.join(root, created.receiptPath);
  const originalBytes = await readFile(receiptFile, "utf8");
  const original = JSON.parse(originalBytes);

  async function assertMutation(mutator, pattern = /gate|receipt|exact|hash/i) {
    const mutated = structuredClone(original);
    mutator(mutated);
    await writeFile(receiptFile, `${JSON.stringify(mutated)}\n`);
    const bytes = await readFile(receiptFile);
    const mutatedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await writeFile(`${receiptFile}.sha256`, `${mutatedHash}\n`);
    await assert.rejects(
      verifyC2ZcRustAcceptanceReceipt({
        root,
        candidate: currentCandidate,
        catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
        receiptPath: created.receiptPath,
        receiptSha256: mutatedHash,
      }),
      pattern,
    );
  }

  await assertMutation((receipt) => receipt.gates.pop());
  await assertMutation((receipt) =>
    receipt.gates.push(structuredClone(receipt.gates[0])),
  );
  await assertMutation((receipt) => receipt.gates.reverse());
  await assertMutation((receipt) => {
    receipt.gates[1].argv.args[0] = "run";
  }, /command|argv|gate/i);
  await assertMutation((receipt) => {
    receipt.gates[1].stdout = OUTPUT_BY_GATE_ID[receipt.gates[0].id];
  }, /output|test|passed|gate/i);
  await assertMutation((receipt) => {
    receipt.gates[1].stdoutSha256 = `sha256:${"0".repeat(64)}`;
  }, /digest|hash|output/i);

  await writeFile(receiptFile, originalBytes);
  await writeFile(`${receiptFile}.sha256`, `${created.receiptSha256}\n`);
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({ id: gate.id, stdout: "running 0 tests\n" }),
    }),
    /exactly one passed/i,
  );
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({
          id: gate.id,
          stdout: "",
          stderr: OUTPUT_BY_GATE_ID[gate.id],
        }),
    }),
    /exactly one passed|stderr/i,
    "a passing test transcript in stderr must not forge a gate result",
  );
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({
          id: gate.id,
          stdout: `${OUTPUT_BY_GATE_ID[gate.id]}test unrelated ... ignored\n`,
        }),
    }),
    /exactly one passed/i,
  );
});

test("C2-ZC Rust receipt re-resolves candidate after every gate and rejects execution-time HEAD/tree/dirty drift", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  let gatesFinished = 0;
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) => {
        gatesFinished += 1;
        return gateExecution({ id: gate.id });
      },
      resolveCandidate: async () =>
        gatesFinished === C2ZC_RUST_ACCEPTANCE_GATES.length
          ? { ...currentCandidate, currentHeadSha: "f".repeat(40) }
          : currentCandidate,
    }),
    /candidate|HEAD|changed/i,
  );
  assert.equal(gatesFinished, C2ZC_RUST_ACCEPTANCE_GATES.length);

  gatesFinished = 0;
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) => {
        gatesFinished += 1;
        return gateExecution({ id: gate.id });
      },
      resolveCandidate: async () =>
        gatesFinished === C2ZC_RUST_ACCEPTANCE_GATES.length
          ? { ...currentCandidate, resolvedHeadTreeSha: "f".repeat(40) }
          : currentCandidate,
    }),
    /candidate|tree|changed/i,
  );

  gatesFinished = 0;
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) => {
        gatesFinished += 1;
        return gateExecution({ id: gate.id });
      },
      resolveCandidate: async () =>
        gatesFinished === C2ZC_RUST_ACCEPTANCE_GATES.length
          ? { ...currentCandidate, worktreeClean: false }
          : currentCandidate,
    }),
    /candidate|clean|changed/i,
  );
});

test("C2-ZC Rust receipt rejects candidate drift immediately after the first gate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  let gatesFinished = 0;
  let resolveCount = 0;
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) => {
        gatesFinished += 1;
        return gateExecution({ id: gate.id });
      },
      resolveCandidate: async () => {
        resolveCount += 1;
        return resolveCount === 1
          ? { ...currentCandidate, currentHeadSha: "f".repeat(40) }
          : currentCandidate;
      },
    }),
    /candidate|HEAD|changed/i,
  );
  assert.equal(
    gatesFinished,
    1,
    "the second Rust gate must not run after drift",
  );
  assert.equal(resolveCount, 1, "candidate must be re-resolved after gate one");
});

test("C2-ZC Rust receipt removes stale exact artifacts and preserves failed command evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const created = await createReceipt({ root, currentCandidate });
  const receiptFile = path.join(root, created.receiptPath);
  const sidecarFile = `${receiptFile}.sha256`;
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({ id: gate.id, exitCode: 17 }),
    }),
    /pass|exactly one|gate/i,
  );
  await assert.rejects(readFile(receiptFile), { code: "ENOENT" });
  await assert.rejects(readFile(sidecarFile), { code: "ENOENT" });
  const failureFiles = (await readdir(path.dirname(receiptFile))).filter(
    (file) => file.includes(".failure.") && file.endsWith(".json"),
  );
  assert.equal(failureFiles.length, 1);
  const failureLog = await readFile(
    path.join(path.dirname(receiptFile), failureFiles[0]),
    "utf8",
  );
  assert.match(failureLog, /c2-zc-canonical-no-legacy-fallback/);
  assert.match(failureLog, /exitCode|17/);
});

test("C2-ZC Rust failure evidence is bounded, candidate/catalog/attempt bound, and immutable per attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const largeStderr = "S".repeat(10_000);
  const fail = () =>
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({ id: gate.id, exitCode: 17, stderr: largeStderr }),
    });
  await assert.rejects(fail(), /failure log|pass|gate/i);
  const receiptFile = path.join(
    root,
    ".artifacts/local-ci/c2-zc-rust-acceptance.json",
  );
  const firstFiles = (await readdir(path.dirname(receiptFile))).filter(
    (file) => file.includes(".failure.") && file.endsWith(".json"),
  );
  assert.equal(firstFiles.length, 1);
  const firstPath = path.join(path.dirname(receiptFile), firstFiles[0]);
  const firstBytes = await readFile(firstPath);
  const firstEvidence = JSON.parse(firstBytes);
  assert.equal(firstEvidence.schema, "grimodex.c2zc.rust-acceptance-failure");
  assert.equal(firstEvidence.version, 1);
  assert.deepEqual(firstEvidence.candidate, currentCandidate);
  assert.equal(firstEvidence.catalogDigest, PRODUCT_JOURNEY_CATALOG_DIGEST);
  assert.match(
    firstEvidence.attemptId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.match(
    firstFiles[0],
    new RegExp(
      `\\.failure\\.${firstEvidence.candidateSha256.slice("sha256:".length)}\\.${firstEvidence.attemptId}\\.json$`,
    ),
  );
  assert.equal(path.relative(root, firstPath).startsWith(".."), false);
  assert.equal(typeof firstEvidence.startedAt, "string");
  assert.equal(typeof firstEvidence.finishedAt, "string");
  assert.equal(
    firstEvidence.failedGate.id,
    "c2-zc-canonical-no-legacy-fallback",
  );
  const firstGate = firstEvidence.gates.find(
    (gate) => gate.id === firstEvidence.failedGate.id,
  );
  assert.equal(firstGate.status, "failed");
  assert.equal(firstGate.exitStatus, 17);
  assert.equal(firstGate.signal, null);
  assert.equal(firstGate.output.stderr.byteCount, largeStderr.length);
  assert.equal(
    firstGate.output.stderr.sha256,
    `sha256:${createHash("sha256").update(largeStderr).digest("hex")}`,
  );
  assert.equal(firstGate.output.stderr.head, largeStderr.slice(0, 4096));
  assert.equal(firstGate.output.stderr.tail, largeStderr.slice(-4096));
  assert.ok(firstGate.output.stderr.head.length <= 4096);
  assert.ok(firstGate.output.stderr.tail.length <= 4096);
  assert.equal(firstGate.stdout, undefined);
  assert.equal(firstGate.stderr, undefined);
  assert.equal(firstBytes.toString("utf8").includes(largeStderr), false);

  await assert.rejects(fail(), /failure log|pass|gate/i);
  const secondFiles = (await readdir(path.dirname(receiptFile))).filter(
    (file) => file.includes(".failure.") && file.endsWith(".json"),
  );
  assert.equal(secondFiles.length, 2);
  assert.notEqual(
    firstFiles[0],
    secondFiles.find((file) => file !== firstFiles[0]),
  );
  const secondEvidence = JSON.parse(
    await readFile(
      path.join(
        path.dirname(receiptFile),
        secondFiles.find((file) => file !== firstFiles[0]),
      ),
      "utf8",
    ),
  );
  assert.notEqual(firstEvidence.attemptId, secondEvidence.attemptId);
});

test("C2-ZC failure output bounding uses one encoded buffer and linear UTF-8 slices", async () => {
  const source = await readFile(
    new URL("./c2zc-rust-acceptance-receipt.mjs", import.meta.url),
    "utf8",
  );
  const boundedOutputSource = source.slice(
    source.indexOf("function boundedOutput"),
    source.indexOf("function failureGateIdentity"),
  );
  assert.equal((boundedOutputSource.match(/Buffer\.from/gu) ?? []).length, 1);
  assert.match(boundedOutputSource, /bytes\.subarray/gu);
  assert.doesNotMatch(boundedOutputSource, /while\s*\(/u);
  assert.doesNotMatch(boundedOutputSource, /Buffer\.byteLength/u);
  assert.doesNotMatch(boundedOutputSource, /\.slice\(/u);
});

test("C2-ZC failure output bounding remains linear and UTF-8-safe for 1MiB output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const largeStderr = "界🙂".repeat(200_000);
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      execute: async (_argv, { gate }) =>
        gateExecution({ id: gate.id, exitCode: 17, stderr: largeStderr }),
    }),
    /failure log|pass|gate/i,
  );
  const receiptDirectory = path.join(root, ".artifacts/local-ci");
  const failureFile = (await readdir(receiptDirectory)).find(
    (file) => file.includes(".failure.") && file.endsWith(".json"),
  );
  assert.ok(failureFile);
  const evidence = JSON.parse(
    await readFile(path.join(receiptDirectory, failureFile), "utf8"),
  );
  const stderr = evidence.gates[0].output.stderr;
  assert.equal(stderr.byteCount, Buffer.byteLength(largeStderr, "utf8"));
  assert.equal(
    stderr.sha256,
    `sha256:${createHash("sha256").update(largeStderr).digest("hex")}`,
  );
  assert.ok(Buffer.byteLength(stderr.head, "utf8") <= 4096);
  assert.ok(Buffer.byteLength(stderr.tail, "utf8") <= 4096);
  assert.equal(stderr.head.includes("\uFFFD"), false);
  assert.equal(stderr.tail.includes("\uFFFD"), false);
});

test("C2-ZC Rust receipt remains fail-closed for candidate mismatch and path escape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentCandidate = candidate();
  const created = await createReceipt({ root, currentCandidate });
  await assert.rejects(
    verifyC2ZcRustAcceptanceReceipt({
      root,
      candidate: { ...currentCandidate, currentHeadSha: "f".repeat(40) },
      catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
      receiptPath: created.receiptPath,
      receiptSha256: created.receiptSha256,
    }),
    /candidate/i,
  );
  await assert.rejects(
    createReceipt({
      root,
      currentCandidate,
      outputPath: "../outside.json",
    }),
    /inside|contain|path/i,
  );
  await assert.rejects(
    verifyC2ZcRustAcceptanceReceipt({
      root,
      candidate: currentCandidate,
      catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
      receiptPath: created.receiptPath,
      receiptSha256: `sha256:${"0".repeat(64)}`,
    }),
    /expected hash|sidecar/i,
  );

  const outside = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-c2zc-outside-"),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(path.join(root, ".artifacts"), { recursive: true, force: true });
  await symlink(outside, path.join(root, ".artifacts"));
  await assert.rejects(
    createReceipt({ root, currentCandidate }),
    /inside|contain|path/i,
  );
});

test("C2-ZC Rust receipt rejects an escaping sidecar symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-rust-"));
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-c2zc-rust-sidecar-"),
  );
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  const currentCandidate = candidate();
  const created = await createReceipt({ root, currentCandidate });
  const sidecarFile = `${path.join(root, created.receiptPath)}.sha256`;
  const outsideSidecar = path.join(outside, "receipt.sha256");
  await writeFile(outsideSidecar, `${created.receiptSha256}\n`);
  await rm(sidecarFile);
  await symlink(outsideSidecar, sidecarFile);
  await assert.rejects(
    verifyC2ZcRustAcceptanceReceipt({
      root,
      candidate: currentCandidate,
      catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
      receiptPath: created.receiptPath,
      receiptSha256: created.receiptSha256,
    }),
    /inside|contain|path/i,
  );
});

test("C2-ZC Rust candidate resolver binds requested and current HEAD trees", async () => {
  const values = new Map([
    ["rev-parse --verify origin/master^{commit}", `${"a".repeat(40)}\n`],
    ["rev-parse --verify refs/heads/topic^{commit}", `${"b".repeat(40)}\n`],
    ["rev-parse --verify HEAD", `${"b".repeat(40)}\n`],
    ["rev-parse --verify refs/heads/topic^{tree}", `${"c".repeat(40)}\n`],
    ["rev-parse --verify HEAD^{tree}", `${"d".repeat(40)}\n`],
    ["status --porcelain=v1 -z --untracked-files=all", ""],
    ["diff --binary --no-ext-diff HEAD --", ""],
    ["ls-files --others --exclude-standard -z", ""],
  ]);
  await assert.rejects(
    resolveC2ZcRustAcceptanceCandidate({
      requestedHead: "refs/heads/topic",
      git: async (args) => {
        const key = args.join(" ");
        assert.ok(values.has(key), `unexpected git invocation: ${key}`);
        return values.get(key);
      },
    }),
    /HEAD and tree|tree/i,
  );
});

test("C2-ZC Rust candidate validation accepts only 40- or 64-character Git object IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-object-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const withObjectId = (objectId) =>
    candidate({
      resolvedBaseSha: objectId,
      resolvedHeadSha: objectId,
      resolvedHeadTreeSha: objectId,
      currentHeadSha: objectId,
    });

  for (const length of [40, 64]) {
    const objectId = "a".repeat(length);
    const result = await createReceipt({
      root,
      currentCandidate: withObjectId(objectId),
      outputPath: `.artifacts/local-ci/object-id-${length}.json`,
    });
    assert.equal(result.receiptSha256.startsWith("sha256:"), true);
  }

  for (const length of [39, 41, 63, 65]) {
    await assert.rejects(
      createReceipt({
        root,
        currentCandidate: withObjectId("a".repeat(length)),
        outputPath: `.artifacts/local-ci/object-id-${length}.json`,
      }),
      /Git object ID/u,
    );
  }
});

test("C2-ZC Rust candidate resolver accepts only 40- or 64-character Git object IDs", async () => {
  const resolverGit = (objectId) => {
    const values = new Map([
      ["rev-parse --verify origin/master^{commit}", `${objectId}\n`],
      ["rev-parse --verify HEAD^{commit}", `${objectId}\n`],
      ["rev-parse --verify HEAD", `${objectId}\n`],
      ["rev-parse --verify HEAD^{tree}", `${objectId}\n`],
      ["status --porcelain=v1 -z --untracked-files=all", ""],
      ["diff --binary --no-ext-diff HEAD --", ""],
      ["ls-files --others --exclude-standard -z", ""],
    ]);
    return async (args) => {
      const key = args.join(" ");
      assert.ok(values.has(key), `unexpected git invocation: ${key}`);
      return values.get(key);
    };
  };

  for (const length of [40, 64]) {
    const objectId = "b".repeat(length);
    const resolved = await resolveC2ZcRustAcceptanceCandidate({
      git: resolverGit(objectId),
    });
    assert.equal(resolved.resolvedHeadSha, objectId);
    assert.equal(resolved.resolvedHeadTreeSha, objectId);
  }

  for (const length of [39, 41, 63, 65]) {
    await assert.rejects(
      resolveC2ZcRustAcceptanceCandidate({
        git: resolverGit("b".repeat(length)),
      }),
      /Git object ID/u,
    );
  }
});
