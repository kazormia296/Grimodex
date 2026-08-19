import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateRunKindPolicy } from "./validate-run-kind-policy.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

const RUN_KIND_CHECK_LINE =
  "CHECK(run_kind IN ('interpretation','freshness-evaluation','semantic-index-rebuild','manual-rebuild','backfill'))";

const VALID_ELECTRON_MAIN_INDEX = [
  'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
  "const narrativeFreshness = createNarrativeFreshnessScheduler(backend);",
  "narrativeFreshness.start();",
  "",
].join("\n");

const VALID_IPC_CONTRACT = [
  "export const NAPI_COMMANDS = {",
  "  db_execute: { run: async () => undefined },",
  "};",
  'export const SHELL_COMMAND_NAMES = ["export_save_text"];',
  "export interface DispatchDeps {}",
  "",
].join("\n");

const VALID_FAILURE_POLICY = {
  policies: [
    {
      failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRYABLE",
      retryDisposition: "retryable",
      maxAttempts: 3,
      policyVersion: "v1",
    },
    {
      failureCode: "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED",
      retryDisposition: "retryable",
      maxAttempts: 3,
      policyVersion: "v1",
    },
    {
      failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
      retryDisposition: "terminal",
      maxAttempts: 3,
      policyVersion: "v1",
    },
  ],
};

const VALID_NARRATIVE_EXTRACTION_MOD_RS = [
  "pub(crate) const INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID: &str =",
  '    "narrative-incremental-freshness/v1";',
  "",
].join("\n");

const VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS = [
  "use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;",
  "const CURSOR_CONSUMER_ID: &str = INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;",
  'const TASK_KIND: &str = "incremental-freshness-batch";',
  "const MAX_CANONICAL_SEQUENCES_PER_BATCH: i64 = 32;",
  'const FAILURE_POLICY_VERSION: &str = "v1";',
  "const MAX_ATTEMPTS_PER_BATCH: i64 = 3;",
  "fn create_and_claim_batch_in_tx(conn: &Connection) {",
  "    load_change_batch_envelope(",
  "        conn,",
  "        project_id,",
  "        acknowledged,",
  "        MAX_CANONICAL_SEQUENCES_PER_BATCH,",
  "    );",
  "    create_system_run_in_tx(",
  "        conn,",
  "        project_id,",
  '        "freshness-evaluation",',
  "        semantic_epoch_id,",
  "        work_key,",
  "        sealed,",
  "        digest,",
  "        SystemRunWorkKeyReuse::RunningOnly,",
  "        None,",
  "    );",
  "    reserve_cursor_range_in_tx(",
  "        conn, project_id, CURSOR_CONSUMER_ID, semantic_epoch_id, &run_id, through_sequence,",
  "    );",
  "    ensure_batch_task_in_tx(",
  "        conn, &run_id, &change_set_id, acknowledged, through_sequence,",
  "    );",
  "}",
  "fn prepare_change_events(conn: &Connection, after_sequence: i64) {",
  "    get_changes_since(",
  "        conn,",
  "        project_id,",
  "        after_sequence,",
  "        MAX_CANONICAL_SEQUENCES_PER_BATCH,",
  "    );",
  "}",
  "fn claim_reserved_batch_in_tx(conn: &Connection) {",
  "    claim_next_task(",
  "        conn,",
  "        &ClaimTaskPayload { task_kinds: Some(vec![TASK_KIND.to_string()]) },",
  "    );",
  "}",
  "fn ensure_batch_task_in_tx(conn: &Connection) {",
  '    conn.execute("INSERT INTO narrative_extraction_tasks (id, run_id, task_kind) VALUES (?1, ?2, ?3)", [task_id, run_id, TASK_KIND]);',
  "}",
  "fn resume_active_batch_in_tx(conn: &Connection) {",
  '    conn.query_row("SELECT id FROM narrative_extraction_tasks WHERE run_id = ?1 AND task_kind = ?2 AND attempt_count >= ?3", [run_id, TASK_KIND, MAX_ATTEMPTS_PER_BATCH], |_| ());',
  "}",
  "fn publish_batch_in_tx(conn: &Connection) {",
  "    acknowledge_cursor_reservation_in_tx(",
  "        conn, &batch.project_id, CURSOR_CONSUMER_ID, &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,",
  "    );",
  "}",
  "fn reserve_or_resume_batch_in_tx(conn: &Connection) {",
  "    release_cursor_reservation_in_tx(",
  "        conn, &project_id, CURSOR_CONSUMER_ID, &active.run_id, active.semantic_epoch_id, active.through_sequence,",
  "    );",
  "    release_cursor_reservation_in_tx(",
  "        conn, &project_id, CURSOR_CONSUMER_ID, &active.run_id, active.semantic_epoch_id, active.through_sequence,",
  "    );",
  "}",
  "fn requeue_after_failure(conn: &Connection, attempt_count: i64) {",
  "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
  "    let _version = FAILURE_POLICY_VERSION;",
  "    let failure_code = if terminal {",
  '        "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED"',
  "    } else {",
  '        "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"',
  "    };",
  "    conn.execute(\"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED', policy_version = ?1\", [FAILURE_POLICY_VERSION]);",
  '    conn.execute("UPDATE attempts SET failure_code = ?1, policy_version = ?2", [failure_code, FAILURE_POLICY_VERSION]);',
  "}",
  "pub fn run_incremental_freshness_cycle() {}",
  "",
].join("\n");

const WIRED_INCREMENTAL_NAPI = [
  "#[napi]",
  "impl Backend {",
  "    #[napi]",
  "    pub async fn run_narrative_freshness_cycle(&self) {",
  "        narrative_extraction::run_incremental_freshness_cycle(&database);",
  "    }",
  "}",
  "",
].join("\n");

function writeFakeMigrateRs(
  root,
  { checkLines = [RUN_KIND_CHECK_LINE, RUN_KIND_CHECK_LINE] } = {},
) {
  const target = path.join(root, "src-tauri/crates/grimodex-db/src/migrate.rs");
  mkdirSync(path.dirname(target), { recursive: true });
  const body = checkLines
    .map(
      (line, index) =>
        `const MIGRATION_${index}: &str = r#"CREATE TABLE runs (run_kind TEXT NOT NULL ${line})"#;`,
    )
    .join("\n");
  writeFileSync(target, `${body}\n`);
}

function baseRunKindPolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "narrative-run-kind-policy",
    principle:
      "Migration and recomputation are the system's responsibility; correcting a meaningful durable declaration is a human's responsibility.",
    runKinds: [
      {
        runKind: "dependency-backfill",
        existingRunKindColumnValue: "backfill",
        purpose: "test",
        trigger: "automatic-once-after-schema-upgrade",
        sameWorkKeyReuse: "reuse-running-and-completed",
        epochBound: true,
        cursorBound: false,
        periodic: false,
        manualRetry: true,
        writes: "durable-graph",
        adminCommands: [
          "retryNarrativeLegacyBackfill",
          "getNarrativeBackfillStatus",
        ],
        implementationStatus: {
          state: "unwired-blocked",
          triggerSymbol: "fixture_backfill_trigger_symbol_that_is_never_called",
          productionEntryPoints: ["retryNarrativeLegacyBackfill"],
          blockedReason: "test",
          blockedOn: ["test"],
        },
      },
      {
        runKind: "dependency-verify",
        existingRunKindColumnValue: null,
        purpose: "test",
        trigger: "automatic-on-trigger-event",
        triggerEvents: ["legacy-backfill-completed"],
        sameWorkKeyReuse: "reuse-running-only",
        epochBound: true,
        cursorBound: false,
        periodic: false,
        manualRetry: true,
        writes: "diagnostics-only",
        forbidSideEffectRepair: true,
        adminCommands: ["verifyNarrativeDependencyGraph"],
        implementationStatus: {
          state: "unwired-blocked",
          triggerSymbol: "fixture_verify_trigger_symbol_that_is_never_called",
          productionEntryPoints: ["verifyNarrativeDependencyGraph"],
          blockedReason: "test",
          blockedOn: ["test"],
        },
      },
      {
        runKind: "dependency-rebuild-derived",
        existingRunKindColumnValue: "semantic-index-rebuild",
        purpose: "test",
        trigger: "automatic-when-derived-state-absent-or-invalid",
        triggerEvents: ["semantic-epoch-rotation"],
        sameWorkKeyReuse: "reuse-running-only",
        epochBound: true,
        cursorBound: false,
        periodic: false,
        manualRetry: true,
        writes: "rebuildable-state-only",
        forbiddenWrites: ["codex"],
        adminCommands: ["rebuildNarrativeDerivedState"],
        implementationStatus: {
          state: "unwired-blocked",
          triggerSymbol: "fixture_rebuild_trigger_symbol_that_is_never_called",
          productionEntryPoints: ["rebuildNarrativeDerivedState"],
          blockedReason: "test",
          blockedOn: ["test"],
        },
      },
      {
        runKind: "incremental-freshness",
        existingRunKindColumnValue: "freshness-evaluation",
        purpose: "test",
        trigger: "automatic-on-change-feed",
        sameWorkKeyReuse: "reuse-running-only",
        resumeSemantics: [
          "reuse-sealed-change-set",
          "reclaim-expired-cursor-reservation",
          "resume-running-run-task-attempt",
        ],
        completedWithUnackedRangeInvariant:
          "never-reuse-completed-run-and-reprocess-under-new-runtime-owned-run",
        epochBound: true,
        cursorBound: true,
        cursorConsumerId: "narrative-incremental-freshness/v1",
        maxCanonicalSequencesPerBatch: 32,
        executionAuthority: "serialized-live-workspace-authority",
        missingSemanticEpochBehavior: "wait-for-canonical-epoch-authority",
        retryPolicy: {
          maxAttemptsPerTask: 3,
          exhaustedFailureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
          exhaustedRetryDisposition: "terminal",
          failurePolicyVersion: "v1",
          taskAndRunStatusAfterExhaustion: "failed",
          cursorAfterExhaustion: "reserved-lease-free",
          schedulerAfterExhaustion: "idle-until-new-semantic-epoch",
          newEpochReservationRecovery: "release-and-reprocess-under-new-run",
          exhaustedRunAfterNewEpoch: "remains-terminal-failed",
        },
        periodic: false,
        manualRetry: false,
        writes: "rebuildable-state-only",
        writesAllowed: [
          "run-task-attempt-state",
          "narrative-change-set",
          "freshness-evaluator-cursor",
          "dependency-edge-state",
          "consumer-freshness",
          "finding-observation",
        ],
        forbiddenWrites: ["domain-state", "attention"],
        adminCommands: [],
        implementationStatus: {
          state: "unwired-blocked",
          triggerSymbol: "run_incremental_freshness_cycle",
          productionEntryPoints: ["run_narrative_freshness_cycle"],
          blockedReason: "test",
          blockedOn: ["test"],
        },
      },
      {
        runKind: "dependency-repair",
        existingRunKindColumnValue: null,
        purpose: "test",
        trigger: "manual-only",
        sameWorkKeyReuse: "no-automatic-reuse-decision",
        epochBound: true,
        cursorBound: false,
        periodic: false,
        manualRetry: "crash-recovery-of-an-already-approved-sealed-plan-only",
        writes: "durable-graph",
        requiredPreconditions: ["exclusive-workspace-lease"],
        allowedRepairs: ["deactivate-duplicate-edge"],
        forbiddenRepairs: ["modify-a-domain-field"],
        unrecoverableDisposition: ["unknown"],
        adminCommands: ["repairNarrativeDependencyDeclarations"],
        implementationStatus: {
          state: "wired",
          productionEntryPoints: ["repairNarrativeDependencyDeclarations"],
        },
      },
    ],
    apiSplit: {
      replaces: "rebuildNarrativeDependencyIndex(mode: verify|repair)",
      reason: "test",
      operations: [
        "verifyNarrativeDependencyGraph",
        "rebuildNarrativeDerivedState",
        "repairNarrativeDependencyDeclarations",
        "getNarrativeBackfillStatus",
        "retryNarrativeLegacyBackfill",
      ],
    },
    cutover: {
      gate: "C2-Z",
      requiredForCanonicalCutover: ["legacy-backfill-completed"],
      beforeCutover: {
        freshnessAuthority: "legacy",
        genericGraphRole: "shadow",
      },
      afterCutover: { freshnessAuthority: "generic-consumer-freshness" },
      editingNeverBlockedByCutoverReadiness: true,
      uiDegradationWhenNotReady: ["semantic-index-is-being-prepared"],
    },
    ...overrides,
  };
}

function writeFixtureRoot({
  runKindPolicy = baseRunKindPolicy(),
  migrateRsOptions = {},
  extraRustFiles = {},
  extraSourceFiles = {},
  electronMainIndex = VALID_ELECTRON_MAIN_INDEX,
  ipcContract = VALID_IPC_CONTRACT,
  failurePolicy = VALID_FAILURE_POLICY,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "run-kind-policy-"));
  cpSync(
    path.join(REPO_ROOT, "policies/narrative/schemas"),
    path.join(root, "policies/narrative/schemas"),
    { recursive: true },
  );
  writeJson(
    root,
    "policies/narrative/narrative-run-kind-policy.json",
    runKindPolicy,
  );
  writeFakeMigrateRs(root, migrateRsOptions);
  writeJson(
    root,
    "policies/narrative/narrative-failure-policy.json",
    failurePolicy,
  );
  const electronMainIndexPath = path.join(root, "electron/main/index.ts");
  mkdirSync(path.dirname(electronMainIndexPath), { recursive: true });
  writeFileSync(electronMainIndexPath, electronMainIndex);
  const ipcContractPath = path.join(root, "electron/shared/ipcContract.ts");
  mkdirSync(path.dirname(ipcContractPath), { recursive: true });
  writeFileSync(ipcContractPath, ipcContract);
  const rustFiles = {
    "src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs":
      VALID_NARRATIVE_EXTRACTION_MOD_RS,
    "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS,
    ...extraRustFiles,
  };
  for (const [relativePath, contents] of Object.entries(rustFiles)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  for (const [relativePath, contents] of Object.entries(extraSourceFiles)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

const BACKFILL_SYMBOL = "fixture_backfill_trigger_symbol_that_is_never_called";
const INCREMENTAL_SYMBOL = "run_incremental_freshness_cycle";

function setBackfillStatus(runKindPolicy, patch) {
  const backfill = runKindPolicy.runKinds.find(
    (entry) => entry.runKind === "dependency-backfill",
  );
  Object.assign(backfill.implementationStatus, patch);
  return runKindPolicy;
}

function setBackfillWired(runKindPolicy) {
  setBackfillStatus(runKindPolicy, { state: "wired" });
  const backfill = runKindPolicy.runKinds.find(
    (entry) => entry.runKind === "dependency-backfill",
  );
  delete backfill.implementationStatus.blockedReason;
  delete backfill.implementationStatus.blockedOn;
  return runKindPolicy;
}

function incrementalFreshness(runKindPolicy) {
  return runKindPolicy.runKinds.find(
    (entry) => entry.runKind === "incremental-freshness",
  );
}

function setIncrementalFreshnessWired(runKindPolicy) {
  const incremental = incrementalFreshness(runKindPolicy);
  incremental.implementationStatus.state = "wired";
  delete incremental.implementationStatus.blockedReason;
  delete incremental.implementationStatus.blockedOn;
  return runKindPolicy;
}

describe("validate-run-kind-policy", () => {
  it("accepts the bundled Gate C2 Run Kind Policy", () => {
    const result = validateRunKindPolicy({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
  });

  it("accepts a minimal well-formed fixture", () => {
    const root = writeFixtureRoot();
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("rejects a policy missing one of the five required run kinds", () => {
    const runKindPolicy = baseRunKindPolicy();
    runKindPolicy.runKinds = runKindPolicy.runKinds.filter(
      (entry) => entry.runKind !== "dependency-repair",
    );
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("is missing runKind: dependency-repair"),
      ),
    );
  });

  it("requires incremental-freshness as the fifth exact run kind", () => {
    const runKindPolicy = baseRunKindPolicy();
    runKindPolicy.runKinds = runKindPolicy.runKinds.filter(
      (entry) => entry.runKind !== "incremental-freshness",
    );
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("is missing runKind: incremental-freshness"),
      ),
    );
  });

  it("rejects an automatic run kind claiming 'wired' with no production caller", () => {
    const runKindPolicy = setBackfillStatus(baseRunKindPolicy(), {
      state: "wired",
    });
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") &&
          error.includes("'wired'") &&
          error.includes("not actually wired"),
      ),
      `expected a wired-but-uncalled error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not accept Rust comments or normal/raw strings as production trigger calls", () => {
    const decoys = [
      `/* ${BACKFILL_SYMBOL}(&database); */`,
      `let decoy = "${BACKFILL_SYMBOL}(&database);";`,
      `let decoy = r#"${BACKFILL_SYMBOL}(&database);"#;`,
    ];

    for (const decoy of decoys) {
      const root = writeFixtureRoot({
        runKindPolicy: setBackfillWired(baseRunKindPolicy()),
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/open.rs": [
            "fn decoy_only() {",
            `    ${decoy}`,
            "}",
            "",
          ].join("\n"),
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("dependency-backfill") &&
            error.includes("not actually wired"),
        ),
        `expected Rust decoy '${decoy}' to remain unwired, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("does not count a locally shadowed bare trigger symbol", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setBackfillWired(baseRunKindPolicy()),
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "fn decoy_only() {",
          `    let ${BACKFILL_SYMBOL} = fake_trigger;`,
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("not actually wired")),
      `expected a locally shadowed trigger to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count function or closure parameter trigger shadows", () => {
    const sources = [
      [
        `fn decoy_only(${BACKFILL_SYMBOL}: fn(&Database)) {`,
        `    ${BACKFILL_SYMBOL}(&database);`,
        "}",
        "",
      ].join("\n"),
      [
        "fn decoy_only() {",
        `    let invoke = |${BACKFILL_SYMBOL}: fn(&Database)| {`,
        `        ${BACKFILL_SYMBOL}(&database);`,
        "    };",
        "    invoke(fake_trigger);",
        "}",
        "",
      ].join("\n"),
    ];
    for (const source of sources) {
      const root = writeFixtureRoot({
        runKindPolicy: setBackfillWired(baseRunKindPolicy()),
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/open.rs": source,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some((error) => error.includes("not actually wired")),
        `expected a parameter-shadowed trigger to remain unwired, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("keeps Rust lifetimes and loop labels visible instead of treating them as chars", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "fn production<'a>(_value: &'a str) {",
          "    'outer: loop {",
          `        ${BACKFILL_SYMBOL}(&database);`,
          "        break 'outer;",
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") && error.includes("open.rs:3"),
      ),
      `expected the call between lifetime labels to stay visible, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count an integration-test call as a production trigger", () => {
    const runKindPolicy = baseRunKindPolicy();
    const incremental = incrementalFreshness(runKindPolicy);
    incremental.implementationStatus.state = "wired";
    delete incremental.implementationStatus.blockedReason;
    delete incremental.implementationStatus.blockedOn;
    const root = writeFixtureRoot({
      runKindPolicy,
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/tests/incremental_freshness.rs": [
          "#[test]",
          "fn exercises_cycle() {",
          `    ${INCREMENTAL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected an integration-test-only call to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count an inline #[test] function as a production trigger", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setBackfillWired(baseRunKindPolicy()),
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "#[test]",
          "fn test_only_trigger() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("not actually wired")),
      `expected #[test] call to remain non-production, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an automatic run kind still marked 'unwired-blocked' after being wired", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "fn spawn_workspace_maintenance() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") &&
          error.includes("'unwired-blocked'") &&
          error.includes("open.rs:2"),
      ),
      `expected an unwired-but-called error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  // Regression: the first version of this check cut each file at its first
  // `#[cfg(test)]`, so a call placed after an inline test module -- which is
  // exactly how open.rs is laid out -- was invisible and the gate passed.
  it("still sees a production call placed after an inline test module", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "fn earlier_production_code() {}",
          "",
          "#[cfg(test)]",
          "mod tests {",
          "    fn helper() {}",
          "}",
          "",
          "fn spawn_workspace_maintenance() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") && error.includes("open.rs:9"),
      ),
      `expected the post-test-module call to be found, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("skips exactly one cfg(test) item and still sees following production on the same line", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          `#[cfg(test)] fn test_only() { ${BACKFILL_SYMBOL}(&database); } fn production() {`,
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") && error.includes("open.rs:2"),
      ),
      `expected the post-cfg(test) production call to be found, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("understands cfg(any(test)) without hiding an any(test, shipping-feature) item", () => {
    const testOnlyRoot = writeFixtureRoot({
      runKindPolicy: setBackfillWired(baseRunKindPolicy()),
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          "#[cfg(any(test))]",
          "fn test_only() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const testOnlyResult = validateRunKindPolicy({ repoRoot: testOnlyRoot });
    assert.ok(
      testOnlyResult.errors.some((error) =>
        error.includes("not actually wired"),
      ),
      `expected cfg(any(test)) to remain test-only, got: ${JSON.stringify(testOnlyResult.errors)}`,
    );

    const shippingRoot = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/open.rs": [
          '#[cfg(any(test, feature = "shipping"))]',
          "fn potentially_shipping() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const shippingResult = validateRunKindPolicy({ repoRoot: shippingRoot });
    assert.ok(
      shippingResult.errors.some(
        (error) =>
          error.includes("dependency-backfill") && error.includes("open.rs:3"),
      ),
      `expected cfg(any(test, feature)) to remain potentially shipping, got: ${JSON.stringify(shippingResult.errors)}`,
    );
  });

  it("does not count a call from the manual Admin IPC boundary as an automatic trigger", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "pub async fn retry_narrative_legacy_backfill() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("does not let a declared Admin N-API method satisfy automatic wiring", () => {
    const runKindPolicy = setBackfillStatus(baseRunKindPolicy(), {
      state: "wired",
      productionEntryPoints: ["retry_narrative_legacy_backfill"],
    });
    const backfill = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-backfill",
    );
    delete backfill.implementationStatus.blockedReason;
    delete backfill.implementationStatus.blockedOn;
    const root = writeFixtureRoot({
      runKindPolicy,
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "pub async fn retry_narrative_legacy_backfill() {",
          `    ${BACKFILL_SYMBOL}(&database);`,
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-backfill") &&
          error.includes("not actually wired"),
      ),
      `expected the Admin N-API call to remain excluded, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("counts an exact declared main-only N-API method as an automatic trigger", () => {
    const runKindPolicy = baseRunKindPolicy();
    const incremental = incrementalFreshness(runKindPolicy);
    incremental.implementationStatus.state = "wired";
    delete incremental.implementationStatus.blockedReason;
    delete incremental.implementationStatus.blockedOn;
    const root = writeFixtureRoot({
      runKindPolicy,
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    #[napi]",
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("does not count a method-shaped call from the main-only N-API entrypoint", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    #[napi]",
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        fake.${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected a method-shaped trigger decoy to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count an exact trigger call hidden behind cfg!(test)", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    #[napi]",
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          "        if cfg!(any(test)) {",
          `            narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "        }",
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected a cfg!(test)-only trigger to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count a declared main-only method that is not exported through N-API", () => {
    const runKindPolicy = setIncrementalFreshnessWired(baseRunKindPolicy());
    const root = writeFixtureRoot({
      runKindPolicy,
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected a non-N-API method to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not count a main-only method exported under a different N-API js_name", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          '    #[napi(js_name = "somethingElse")]',
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected a renamed N-API method to remain unwired, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("accepts an exact multiline N-API js_name for the main-only method", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    #[napi(",
          '        js_name = "runNarrativeFreshnessCycle"',
          "    )]",
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("accepts an exact raw-string N-API js_name", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          '    #[napi(js_name = r#"runNarrativeFreshnessCycle"#)]',
          "    pub async fn run_narrative_freshness_cycle(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("does not count a main-only N-API call from an undeclared method", () => {
    const runKindPolicy = baseRunKindPolicy();
    const incremental = incrementalFreshness(runKindPolicy);
    incremental.implementationStatus.state = "wired";
    delete incremental.implementationStatus.blockedReason;
    delete incremental.implementationStatus.blockedOn;
    const root = writeFixtureRoot({
      runKindPolicy,
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": [
          "#[napi]",
          "impl Backend {",
          "    #[napi]",
          "    pub async fn some_manual_admin_method(&self) {",
          `        narrative_extraction::${INCREMENTAL_SYMBOL}(&database);`,
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness") &&
          error.includes("not actually wired"),
      ),
      `expected an undeclared-entrypoint error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects wired incremental Freshness when Electron main never creates the scheduler", () => {
    const runKindPolicy = setIncrementalFreshnessWired(baseRunKindPolicy());
    const root = writeFixtureRoot({
      runKindPolicy,
      electronMainIndex:
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";\n',
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("does not create the Narrative Freshness scheduler"),
      ),
      `expected a missing scheduler creation error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects wired incremental Freshness when Electron main creates but never starts the scheduler", () => {
    const runKindPolicy = setIncrementalFreshnessWired(baseRunKindPolicy());
    const root = writeFixtureRoot({
      runKindPolicy,
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
        "const narrativeFreshness = createNarrativeFreshnessScheduler(backend);",
        "// narrativeFreshness.start(); comments are not production wiring",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("creates its scheduler without calling start()"),
      ),
      `expected a missing scheduler start error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a lookalike scheduler that is not imported from the canonical Electron main module", () => {
    const runKindPolicy = setIncrementalFreshnessWired(baseRunKindPolicy());
    const root = writeFixtureRoot({
      runKindPolicy,
      electronMainIndex: [
        "function createNarrativeFreshnessScheduler() { return scheduler; }",
        "const narrativeFreshness = createNarrativeFreshnessScheduler(backend);",
        "narrativeFreshness.start();",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "does not import createNarrativeFreshnessScheduler from './narrativeFreshness.js'",
        ),
      ),
      `expected a non-canonical scheduler import error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects scheduler create/start matches that resolve to different shadowed bindings", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
        "function shadowed(createNarrativeFreshnessScheduler) {",
        "  const scheduler = createNarrativeFreshnessScheduler(backend);",
        "  return scheduler;",
        "}",
        "const scheduler = { start() {} };",
        "scheduler.start();",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("canonical scheduler binding"),
      ),
      `expected shadowed scheduler wiring to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("accepts an aliased canonical scheduler import when the same result binding is started", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler as makeFreshness } from "./narrativeFreshness.js";',
        "const scheduler = makeFreshness(backend);",
        "scheduler.start();",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("does not accept canonical scheduler calls hidden in an uncalled function", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
        "function neverCalled() {",
        "  const scheduler = createNarrativeFreshnessScheduler(backend);",
        "  scheduler.start();",
        "}",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("canonical scheduler binding"),
      ),
      `expected an uncalled scheduler decoy to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not accept scheduler wiring in a statically dead branch", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
        "if (false) {",
        "  const scheduler = createNarrativeFreshnessScheduler(backend);",
        "  scheduler.start();",
        "}",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("canonical scheduler binding"),
      ),
      `expected statically dead scheduler wiring to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("requires start() on the scheduler value returned by the canonical factory", () => {
    const root = writeFixtureRoot({
      runKindPolicy: setIncrementalFreshnessWired(baseRunKindPolicy()),
      electronMainIndex: [
        'import { createNarrativeFreshnessScheduler } from "./narrativeFreshness.js";',
        "let scheduler = createNarrativeFreshnessScheduler(backend);",
        "scheduler = { start() {} };",
        "scheduler.start();",
        "",
      ].join("\n"),
      extraRustFiles: {
        "electron/native/grimodex-node/src/lib.rs": WIRED_INCREMENTAL_NAPI,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("without calling start() on that same canonical"),
      ),
      `expected reassigned scheduler wiring to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects exposing the main-only Freshness method through renderer NAPI_COMMANDS", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        "export const NAPI_COMMANDS = {",
        "  run_narrative_freshness_cycle: {",
        "    run: async (backend) => backend.runNarrativeFreshnessCycle(),",
        "  },",
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("must not be registered") &&
          error.includes("renderer NAPI_COMMANDS"),
      ),
      `expected a renderer NAPI_COMMANDS exposure error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a renderer NAPI_COMMANDS alias that reaches the main-only Freshness method", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        "export const NAPI_COMMANDS = {",
        '  freshness_alias: { run: async (backend) => backend["runNarrativeFreshnessCycle"]() },',
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("must not be registered") &&
          error.includes("renderer NAPI_COMMANDS"),
      ),
      `expected an aliased renderer NAPI_COMMANDS exposure error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a const-object and concatenated-string alias in renderer NAPI_COMMANDS", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'const methods = { command: "runNarrativeFresh" + "nessCycle" } as const;',
        "const freshnessSpec = {",
        "  run: async (backend) => backend[methods.command](),",
        "};",
        "export const NAPI_COMMANDS = { freshness_alias: freshnessSpec };",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("must not be registered") &&
          error.includes("renderer NAPI_COMMANDS"),
      ),
      `expected a const-object renderer NAPI_COMMANDS exposure error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("resolves NAPI aliases in lexical scope instead of using a later shadow", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'const command = "runNarrativeFresh" + "nessCycle";',
        "const spec = { run: async (backend) => backend[command]() };",
        "function unrelated() {",
        '  const command = "dbExecute";',
        "  return command;",
        "}",
        "export const NAPI_COMMANDS = { alias: spec };",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected lexical alias exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("uses only the exported top-level NAPI_COMMANDS declaration", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        "function decoy() { const NAPI_COMMANDS = {}; return NAPI_COMMANDS; }",
        'const command = "run_narrative_fresh" + "ness_cycle";',
        "export const NAPI_COMMANDS = {",
        "  alias: { run: async (backend) => backend[command]() },",
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected nested NAPI_COMMANDS decoy to be ignored, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a function declaration that indirectly exposes the main-only method", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        "function run(backend) {",
        "  return backend.runNarrativeFreshnessCycle();",
        "}",
        "export const NAPI_COMMANDS = { alias: { run } };",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected function-declaration alias exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an imported main-only method name used for computed access", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'import { runNarrativeFreshnessCycle as method } from "./forbidden.js";',
        "export const NAPI_COMMANDS = {",
        "  alias: { run: async (backend) => backend[method]() },",
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected imported computed-method exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an array-join alias for the main-only method", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'const method = ["runNarrative", "FreshnessCycle"].join("");',
        "export const NAPI_COMMANDS = {",
        "  alias: { run: async (backend) => backend[method]() },",
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected array-join method exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an array binding whose join result aliases the main-only method", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'const parts = ["runNarrative", "FreshnessCycle"] as const;',
        'const method = parts.join("");',
        "export const NAPI_COMMANDS = {",
        "  alias: { run: async (backend) => backend[method]() },",
        "};",
        "export const SHELL_COMMAND_NAMES = [];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => error.includes("renderer NAPI_COMMANDS")),
      `expected array-binding join exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects aliased and concatenated Freshness exposure in renderer, preload, and main IPC", () => {
    const cases = [
      [
        "src/features/debug/freshness.ts",
        [
          'const command = "run_narrative_fresh" + "ness_cycle";',
          "export function exposeFromRenderer() {",
          "  return window.grimodex.invoke(command);",
          "}",
          "",
        ].join("\n"),
      ],
      [
        "electron/preload/freshness.ts",
        [
          'const methods = { command: "runNarrativeFresh" + "nessCycle" } as const;',
          "const bridge = { run: () => ipcRenderer.invoke('grim:invoke', methods.command) };",
          "contextBridge.exposeInMainWorld('maintenance', bridge);",
          "",
        ].join("\n"),
      ],
      [
        "electron/main/freshnessIpc.ts",
        [
          'const channels = { command: "run_narrative_fresh" + "ness_cycle" } as const;',
          "const register = ipcMain.handle.bind(ipcMain);",
          "register(channels.command, async () => undefined);",
          "",
        ].join("\n"),
      ],
    ];

    for (const [relativePath, contents] of cases) {
      const root = writeFixtureRoot({
        extraSourceFiles: { [relativePath]: contents },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("main-only Freshness method") &&
            error.includes(relativePath),
        ),
        `expected ${relativePath} exposure to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("resolves cross-file shared aliases used by main and preload IPC", () => {
    const root = writeFixtureRoot({
      extraSourceFiles: {
        "electron/shared/freshnessParts.ts":
          'export const METHOD_PREFIX = "runNarrative";\n',
        "electron/shared/freshnessBarrel.ts":
          'export { METHOD_PREFIX } from "./freshnessParts.js";\n',
        "electron/shared/freshnessAlias.ts": [
          'import { METHOD_PREFIX } from "./freshnessBarrel.js";',
          'export const COMMAND = "grim:invoke";',
          'export const METHOD = METHOD_PREFIX + "FreshnessCycle";',
          "",
        ].join("\n"),
        "electron/main/freshnessIpc.ts": [
          'import { COMMAND, METHOD } from "../shared/freshnessAlias.js";',
          "const ipc = ipcMain;",
          "ipc.handle(COMMAND, async () => backend[METHOD]());",
          "",
        ].join("\n"),
        "electron/preload/freshnessBridge.ts": [
          'import { COMMAND } from "../shared/freshnessAlias.js";',
          "void ipcRenderer.invoke(COMMAND);",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("main-only Freshness method") &&
          (error.includes("electron/shared/freshnessAlias.ts") ||
            error.includes("electron/main/freshnessIpc.ts")),
      ),
      `expected cross-file shared aliases to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not exempt IPC exposure added inside the canonical main scheduler adapter", () => {
    const root = writeFixtureRoot({
      extraSourceFiles: {
        "electron/main/narrativeFreshness.ts": [
          'const command = "run_narrative_fresh" + "ness_cycle";',
          "ipcMain.handle(command, async () => backend.runNarrativeFreshnessCycle());",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("electron/main/narrativeFreshness.ts") &&
          error.includes("exposed through"),
      ),
      `expected canonical-adapter IPC exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not exempt an aliased ipcMain receiver inside the canonical adapter", () => {
    const root = writeFixtureRoot({
      extraSourceFiles: {
        "electron/main/narrativeFreshness.ts": [
          "const ipc = ipcMain;",
          "ipc.handle('freshness', async () => backend.runNarrativeFreshnessCycle());",
          "",
        ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("electron/main/narrativeFreshness.ts") &&
          error.includes("exposed through"),
      ),
      `expected aliased ipcMain exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects exposing the main-only Freshness method through the renderer shell allowlist", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        "export const NAPI_COMMANDS = {};",
        'export const SHELL_COMMAND_NAMES = ["run_narrative_freshness_cycle"];',
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("must not be registered") &&
          error.includes("renderer shell command allowlist"),
      ),
      `expected a renderer shell allowlist exposure error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an escaped string alias in the renderer shell allowlist", () => {
    const root = writeFixtureRoot({
      ipcContract: [
        'const hidden = "runNarrativeFresh\\x6eessCycle";',
        "export const NAPI_COMMANDS = {};",
        "export const SHELL_COMMAND_NAMES = [hidden];",
        "export interface DispatchDeps {}",
        "",
      ].join("\n"),
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("must not be registered") &&
          error.includes("renderer shell command allowlist"),
      ),
      `expected escaped shell alias exposure to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  // dependency-repair is manual-only, so it has no triggerSymbol and never
  // reaches the call-graph check. Its state/blockedOn consistency still has
  // to be checked, or a 'wired' Run Kind can keep a stale blockedOn forever.
  it("rejects a manual-only run kind marked 'wired' that still carries blockedOn", () => {
    const runKindPolicy = baseRunKindPolicy();
    const repair = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-repair",
    );
    repair.implementationStatus.blockedReason = "still waiting on something";
    repair.implementationStatus.blockedOn = ["some-open-item"];
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-repair") &&
          error.includes("'wired'") &&
          error.includes("blockedOn"),
      ),
      `expected a wired/blockedOn contradiction error, got: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-repair") &&
          error.includes("blockedReason"),
      ),
      `expected a wired/blockedReason contradiction error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a manual-only run kind marked 'unwired-blocked' with no blockedOn", () => {
    const runKindPolicy = baseRunKindPolicy();
    const repair = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-repair",
    );
    repair.implementationStatus.state = "unwired-blocked";
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-repair") &&
          error.includes("blockedReason"),
      ),
      `expected a missing-blockedReason error, got: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("dependency-repair") && error.includes("blockedOn"),
      ),
      `expected a missing-blockedOn error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a duplicate runKind entry", () => {
    const runKindPolicy = baseRunKindPolicy();
    runKindPolicy.runKinds.push({ ...runKindPolicy.runKinds[0] });
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("duplicate runKind: dependency-backfill"),
      ),
    );
  });

  it("rejects an existingRunKindColumnValue the real run_kind CHECK constraint does not accept", () => {
    const runKindPolicy = baseRunKindPolicy();
    const backfill = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-backfill",
    );
    backfill.existingRunKindColumnValue = "not-a-real-column-value";
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-backfill.existingRunKindColumnValue ('not-a-real-column-value') is not a value the real 'run_kind' CHECK constraint",
        ),
      ),
    );
  });

  it("accepts a narrower historical run_kind CHECK that is a subset of the current one", () => {
    const root = writeFixtureRoot({
      migrateRsOptions: {
        checkLines: [
          // A historical ADD COLUMN/rebuild statement legitimately keeps
          // an older, narrower value set verbatim so replaying migration
          // history against an old workspace still reproduces that exact
          // intermediate schema shape.
          "CHECK(run_kind IN ('interpretation','backfill'))",
          RUN_KIND_CHECK_LINE,
        ],
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      !result.errors.some((error) => error.includes("CHECK(run_kind IN")),
      `unexpected CHECK-related errors: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not let an older wider CHECK hide a narrowed current constraint", () => {
    const root = writeFixtureRoot({
      migrateRsOptions: {
        checkLines: [
          RUN_KIND_CHECK_LINE,
          "CHECK(run_kind IN ('interpretation','semantic-index-rebuild','manual-rebuild','backfill'))",
        ],
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("current production occurrence") ||
          (error.includes("incremental-freshness.existingRunKindColumnValue") &&
            error.includes("freshness-evaluation")),
      ),
      `expected the final narrowed CHECK to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a historical run_kind CHECK value absent from the current one", () => {
    const root = writeFixtureRoot({
      migrateRsOptions: {
        checkLines: [
          RUN_KIND_CHECK_LINE,
          "CHECK(run_kind IN ('interpretation','totally-unrelated-value'))",
        ],
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "contains a value absent from the current production occurrence",
        ),
      ),
    );
  });

  it("does not let a cfg(test) CHECK widen the production run_kind constraint", () => {
    const root = writeFixtureRoot();
    const migratePath = path.join(
      root,
      "src-tauri/crates/grimodex-db/src/migrate.rs",
    );
    writeFileSync(
      migratePath,
      [
        "const PRODUCTION_SQL: &str = r#\"CREATE TABLE runs (run_kind TEXT CHECK(run_kind IN ('interpretation','backfill','semantic-index-rebuild')))\"#;",
        `// ${RUN_KIND_CHECK_LINE}`,
        "#[cfg(test)]",
        `const TEST_ONLY_SQL: &str = r#"${RUN_KIND_CHECK_LINE}"#;`,
        "",
      ].join("\n"),
    );
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("incremental-freshness.existingRunKindColumnValue") &&
          error.includes("freshness-evaluation"),
      ),
      `expected test-only CHECK values to stay invisible, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an automatic-on-trigger-event run kind with no triggerEvents", () => {
    const runKindPolicy = baseRunKindPolicy();
    const verify = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-verify",
    );
    delete verify.triggerEvents;
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-verify declares trigger 'automatic-on-trigger-event' but has no triggerEvents",
        ),
      ),
    );
  });

  it("accepts cursorBound only for incremental-freshness", () => {
    const runKindPolicy = baseRunKindPolicy();
    const backfill = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-backfill",
    );
    backfill.cursorBound = true;
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-backfill.cursorBound must be false; only incremental-freshness",
        ),
      ),
    );
  });

  it("requires incremental-freshness to remain cursor-bound", () => {
    const runKindPolicy = baseRunKindPolicy();
    incrementalFreshness(runKindPolicy).cursorBound = false;
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("incremental-freshness.cursorBound must be true"),
      ),
    );
  });

  it("pins the incremental Freshness cursor, batch, authority, and write boundary", () => {
    const cases = [
      [
        { cursorConsumerId: "unstable" },
        "cursorConsumerId must be 'narrative-incremental-freshness/v1'",
      ],
      [
        { maxCanonicalSequencesPerBatch: 31 },
        "maxCanonicalSequencesPerBatch must be 32",
      ],
      [
        { executionAuthority: "detached-workspace-connection" },
        "executionAuthority must be 'serialized-live-workspace-authority'",
      ],
      [
        { missingSemanticEpochBehavior: "create-an-epoch" },
        "missingSemanticEpochBehavior must be 'wait-for-canonical-epoch-authority'",
      ],
      [{ writes: "durable-graph" }, "writes must be 'rebuildable-state-only'"],
      [
        { sameWorkKeyReuse: "reuse-running-and-completed" },
        "sameWorkKeyReuse must be 'reuse-running-only'",
      ],
      [
        {
          resumeSemantics: [
            "reuse-sealed-change-set",
            "reclaim-expired-cursor-reservation",
            "resume-running-run-task-attempt",
            "reuse-completed-publication-on-replay",
          ],
        },
        "completed replay reuse is forbidden",
      ],
      [
        {
          completedWithUnackedRangeInvariant:
            "ack-completed-range-without-publication",
        },
        "completedWithUnackedRangeInvariant must be 'never-reuse-completed-run-and-reprocess-under-new-runtime-owned-run'",
      ],
      [
        { writesAllowed: ["consumer-freshness", "domain-state"] },
        "writesAllowed must contain only its declared operational and rebuildable-state writes",
      ],
      [
        { forbiddenWrites: ["attention"] },
        "forbiddenWrites must include 'domain-state'",
      ],
      [
        { forbiddenWrites: ["domain-state"] },
        "forbiddenWrites must include 'attention'",
      ],
    ];

    for (const [patch, expectedError] of cases) {
      const runKindPolicy = baseRunKindPolicy();
      Object.assign(incrementalFreshness(runKindPolicy), patch);
      const root = writeFixtureRoot({ runKindPolicy });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some((error) => error.includes(expectedError)),
        `expected '${expectedError}', got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("pins bounded retry exhaustion and reserved cursor recovery semantics", () => {
    const cases = [
      ["maxAttemptsPerTask", 4, "must be '3'"],
      [
        "exhaustedFailureCode",
        "NEX_OTHER",
        "must be 'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED'",
      ],
      ["exhaustedRetryDisposition", "retryable", "must be 'terminal'"],
      ["failurePolicyVersion", "v2", "must be 'v1'"],
      ["taskAndRunStatusAfterExhaustion", "queued", "must be 'failed'"],
      ["cursorAfterExhaustion", "released", "must be 'reserved-lease-free'"],
      [
        "schedulerAfterExhaustion",
        "retry-immediately",
        "must be 'idle-until-new-semantic-epoch'",
      ],
      [
        "newEpochReservationRecovery",
        "supersede-failed-run",
        "must be 'release-and-reprocess-under-new-run'",
      ],
      [
        "exhaustedRunAfterNewEpoch",
        "superseded",
        "must be 'remains-terminal-failed'",
      ],
    ];

    for (const [field, value, expectedError] of cases) {
      const runKindPolicy = baseRunKindPolicy();
      incrementalFreshness(runKindPolicy).retryPolicy[field] = value;
      const root = writeFixtureRoot({ runKindPolicy });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes(`incremental-freshness.retryPolicy.${field}`) &&
            error.includes(expectedError),
        ),
        `expected ${field} lifecycle error, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("requires retry exhaustion to be registered as terminal under failure policy v1", () => {
    const cases = [
      [
        { policies: [] },
        "is not registered in policies/narrative/narrative-failure-policy.json",
      ],
      [
        {
          policies: [
            {
              failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
              retryDisposition: "retryable",
              maxAttempts: 3,
              policyVersion: "v1",
            },
          ],
        },
        "retry exhaustion disposition 'terminal' disagrees",
      ],
      [
        {
          policies: [
            {
              failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
              retryDisposition: "terminal",
              maxAttempts: 3,
              policyVersion: "v2",
            },
          ],
        },
        "retry failure policy version 'v1' disagrees",
      ],
      [
        {
          policies: [
            {
              failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
              retryDisposition: "terminal",
              maxAttempts: 4,
              policyVersion: "v1",
            },
          ],
        },
        "retry max attempts '3' disagrees",
      ],
    ];

    for (const [failurePolicy, expectedError] of cases) {
      const root = writeFixtureRoot({ failurePolicy });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some((error) => error.includes(expectedError)),
        `expected '${expectedError}', got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("requires every persisted incremental Freshness retry/interruption code in failure policy", () => {
    const root = writeFixtureRoot({
      failurePolicy: {
        policies: [
          {
            failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
            retryDisposition: "terminal",
            maxAttempts: 3,
            policyVersion: "v1",
          },
        ],
      },
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          [
            "const MAX_ATTEMPTS_PER_BATCH: i64 = 3;",
            'const FAILURE_POLICY_VERSION: &str = "v1";',
            "fn persist_failures(conn: &Connection, attempt_count: i64) {",
            "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
            "    conn.execute(\"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED', policy_version = ?1\", [FAILURE_POLICY_VERSION]);",
            "    let failure_code = if terminal {",
            '        "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED"',
            "    } else {",
            '        "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"',
            "    };",
            '    conn.execute("UPDATE attempts SET failure_code = ?1, policy_version = ?2", [failure_code, FAILURE_POLICY_VERSION]);',
            "}",
            "",
          ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    for (const failureCode of [
      "NEX_INCREMENTAL_FRESHNESS_RETRYABLE",
      "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED",
    ]) {
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes(failureCode) && error.includes("is not registered"),
        ),
        `expected missing ${failureCode} registration, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("does not let non-persisted or cfg(test) failure-code strings satisfy runtime persistence", () => {
    const runtime = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        '        "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"',
        '        "NEX_OTHER_RETRYABLE"',
      ),
      'const LOG_ONLY: &str = "NEX_INCREMENTAL_FRESHNESS_RETRYABLE";',
      "#[cfg(test)]",
      "fn retry_code_fixture() {",
      '    let _ = r#"NEX_INCREMENTAL_FRESHNESS_RETRYABLE"#;',
      "}",
      "",
    ].join("\n");
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("does not persist required failure code") &&
          error.includes("NEX_INCREMENTAL_FRESHNESS_RETRYABLE"),
      ),
      `expected non-persisted/test-only retry code to be rejected, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not treat an unused failure UPDATE string as a persisted code", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    conn.execute(\"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED', policy_version = ?1\", [FAILURE_POLICY_VERSION]);",
      [
        "    let unused_sql = \"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_INTERRUPTED'\";",
        '    conn.execute("SELECT 1", []);',
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("does not persist required failure code") &&
          error.includes("NEX_INCREMENTAL_FRESHNESS_INTERRUPTED"),
      ),
      `expected unused SQL literal to be ignored, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("tracks a persisted failure-code branch independently of its local variable name", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "let failure_code = if",
      "let selected_code = if",
    ).replace(
      "[failure_code, FAILURE_POLICY_VERSION]",
      "[selected_code, FAILURE_POLICY_VERSION]",
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("requires each failure persistence UPDATE to bind canonical FAILURE_POLICY_VERSION", () => {
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "[FAILURE_POLICY_VERSION]);",
        '["v2"]);',
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "[failure_code, FAILURE_POLICY_VERSION]);",
        "[failure_code, other_version]);",
      ).replace(
        "    let _version = FAILURE_POLICY_VERSION;",
        '    let other_version = "v1";\n    let _version = FAILURE_POLICY_VERSION;',
      ),
    ];

    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("failure persistence") &&
            error.includes("FAILURE_POLICY_VERSION"),
        ),
        `expected a non-canonical failure policy-version binding error, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("does not accept dead or overwritten failure-code branch literals as persistence", () => {
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "let failure_code = if terminal",
        "let failure_code = if false",
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "let failure_code = if terminal",
        "let mut failure_code = if terminal",
      ).replace(
        '    conn.execute("UPDATE attempts SET failure_code = ?1, policy_version = ?2",',
        [
          '    failure_code = "NEX_OTHER_FAILURE";',
          '    conn.execute("UPDATE attempts SET failure_code = ?1, policy_version = ?2",',
        ].join("\n"),
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        [
          "let mut terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
          "    terminal = false;",
        ].join("\n"),
      ),
    ];
    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("does not persist required failure code") &&
            error.includes("NEX_INCREMENTAL_FRESHNESS_RETRYABLE"),
        ),
        `expected dead/overwritten failure literals to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("cross-checks retryable and interrupted failure-policy metadata", () => {
    const cases = [
      [
        "NEX_INCREMENTAL_FRESHNESS_RETRYABLE",
        { retryDisposition: "terminal" },
        "must be 'retryable'",
      ],
      [
        "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED",
        { policyVersion: "v2" },
        "must use policyVersion 'v1'",
      ],
      [
        "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED",
        { maxAttempts: 4 },
        "must use maxAttempts 3",
      ],
    ];
    for (const [failureCode, patch, expectedError] of cases) {
      const failurePolicy = structuredClone(VALID_FAILURE_POLICY);
      Object.assign(
        failurePolicy.policies.find(
          (entry) => entry.failureCode === failureCode,
        ),
        patch,
      );
      const root = writeFixtureRoot({ failurePolicy });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes(failureCode) && error.includes(expectedError),
        ),
        `expected ${failureCode} metadata error '${expectedError}', got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects a newly persisted incremental Freshness code outside the exact set", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      '        "NEX_INCREMENTAL_FRESHNESS_RETRYABLE"',
      '        "NEX_INCREMENTAL_FRESHNESS_NETWORK"',
    );
    const failurePolicy = structuredClone(VALID_FAILURE_POLICY);
    failurePolicy.policies.push({
      failureCode: "NEX_INCREMENTAL_FRESHNESS_NETWORK",
      retryDisposition: "retryable",
      maxAttempts: 3,
      policyVersion: "v1",
    });
    const root = writeFixtureRoot({
      failurePolicy,
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("unrecognized incremental Freshness failure code") &&
          error.includes("NEX_INCREMENTAL_FRESHNESS_NETWORK"),
      ),
      `expected unknown persisted code to fail exact-set validation, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects incremental failure codes persisted through execute_batch", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    conn.execute_batch(\"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_BYPASS', policy_version = 'v1'\");",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("NEX_INCREMENTAL_FRESHNESS_BYPASS") &&
          error.includes("unrecognized"),
      ),
      `expected execute_batch persistence to fail exact-set validation, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("fails closed when an executed failure SQL expression is not one literal", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        '    let sql = concat!("UPDATE attempts SET failure_code = \'", "NEX_INCREMENTAL_FRESHNESS_CONCAT_BYPASS", "\', policy_version = \'v1\'");',
        "    conn.execute(sql, []);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("SQL expression") && error.includes("fail closed"),
      ),
      `expected concatenated persistence SQL to fail closed, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects incremental failure codes persisted through prepared statements", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    let mut statement = conn.prepare(\"UPDATE attempts SET failure_code = 'NEX_INCREMENTAL_FRESHNESS_PREPARED_BYPASS', policy_version = ?1\");",
        "    statement.execute([FAILURE_POLICY_VERSION]);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("NEX_INCREMENTAL_FRESHNESS_PREPARED_BYPASS") &&
          error.includes("unrecognized"),
      ),
      `expected prepared-statement persistence to fail exact-set validation, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects incremental failure codes persisted through INSERT values", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    conn.execute(\"INSERT INTO attempts (id, failure_code, policy_version) VALUES (?1, 'NEX_INCREMENTAL_FRESHNESS_INSERT_BYPASS', ?2)\", [attempt_id, FAILURE_POLICY_VERSION]);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("NEX_INCREMENTAL_FRESHNESS_INSERT_BYPASS") &&
          error.includes("unrecognized"),
      ),
      `expected INSERT persistence to fail exact-set validation, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("checks every tuple in a multi-row failure persistence INSERT", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    conn.execute(\"INSERT INTO attempts (id, failure_code, policy_version) VALUES (?1, NULL, ?2), (?3, 'NEX_INCREMENTAL_FRESHNESS_MULTIROW_BYPASS', ?4)\", [first_id, FAILURE_POLICY_VERSION, second_id, FAILURE_POLICY_VERSION]);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("NEX_INCREMENTAL_FRESHNESS_MULTIROW_BYPASS") &&
          error.includes("unrecognized"),
      ),
      `expected every multi-row INSERT tuple to be checked, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an uninterpretable production failure_code assignment", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    conn.execute(\"UPDATE attempts SET failure_code = CASE WHEN 1 THEN 'opaque' END, policy_version = ?1\", [FAILURE_POLICY_VERSION]);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("cannot be tied to the canonical retry branch"),
      ),
      `expected uninterpretable failure assignment to fail closed, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("does not treat required codes or version placeholders in WHERE as SET bindings", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
      [
        "    let terminal = attempt_count >= MAX_ATTEMPTS_PER_BATCH;",
        "    conn.execute(\"UPDATE attempts SET failure_code = 'OTHER', policy_version = 'v2' WHERE failure_code = 'NEX_INCREMENTAL_FRESHNESS_RETRYABLE' AND policy_version = ?1\", [FAILURE_POLICY_VERSION]);",
      ].join("\n"),
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("cannot be tied to the canonical retry branch"),
      ),
      `expected SET/WHERE failure-code confusion to fail, got: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("policy_version") &&
          error.includes("FAILURE_POLICY_VERSION"),
      ),
      `expected SET/WHERE policy-version confusion to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects an extra incremental Freshness registry code not persisted by runtime", () => {
    const failurePolicy = structuredClone(VALID_FAILURE_POLICY);
    failurePolicy.policies.push({
      failureCode: "NEX_INCREMENTAL_FRESHNESS_UNUSED",
      retryDisposition: "terminal",
      maxAttempts: 3,
      policyVersion: "v1",
    });
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("NEX_INCREMENTAL_FRESHNESS_UNUSED") &&
          error.includes("not persisted by runtime"),
      ),
      `expected extra registry code to fail exact-set validation, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("cross-checks the incremental policy against Rust canonical runtime constants", () => {
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs": [
          'pub(crate) const INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID: &str = "wrong-consumer/v9";',
          "",
        ].join("\n"),
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          [
            "use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;",
            "const CURSOR_CONSUMER_ID: &str = INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;",
            'const TASK_KIND: &str = "wrong-task-kind";',
            "const MAX_CANONICAL_SEQUENCES_PER_BATCH: i64 = 31;",
            'const FAILURE_POLICY_VERSION: &str = "v2";',
            "const MAX_ATTEMPTS_PER_BATCH: i64 = 4;",
            "fn create(conn: &Connection) {",
            "    get_changes_since(conn, project_id, acknowledged, MAX_CANONICAL_SEQUENCES_PER_BATCH);",
            "    create_system_run_in_tx(",
            '        conn, project_id, "interpretation", semantic_epoch_id,',
            "        work_key, sealed, digest, SystemRunWorkKeyReuse::RunningAndCompleted, None,",
            "    );",
            "}",
            'const RETRYABLE: &str = "NEX_INCREMENTAL_FRESHNESS_RETRYABLE";',
            'const INTERRUPTED: &str = "NEX_INCREMENTAL_FRESHNESS_INTERRUPTED";',
            'const EXHAUSTED: &str = "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED";',
            "",
          ].join("\n"),
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    for (const expected of [
      "MAX_CANONICAL_SEQUENCES_PER_BATCH",
      "MAX_ATTEMPTS_PER_BATCH",
      "INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID",
      "TASK_KIND",
      "freshness-evaluation",
      "SystemRunWorkKeyReuse::RunningOnly",
      "FAILURE_POLICY_VERSION",
    ]) {
      assert.ok(
        result.errors.some((error) => error.includes(expected)),
        `expected Rust contract drift for ${expected}, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("binds canonical Rust values to the same production calls and retry branch", () => {
    const runtime = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replaceAll(
        "        MAX_CANONICAL_SEQUENCES_PER_BATCH,",
        "        31,",
      )
        .replace('        "freshness-evaluation",', '        "interpretation",')
        .replace(
          "CURSOR_CONSUMER_ID, semantic_epoch_id, &run_id, through_sequence,",
          '"wrong-consumer", semantic_epoch_id, &run_id, through_sequence,',
        )
        .replace(
          "CURSOR_CONSUMER_ID, &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,",
          '"wrong-consumer", &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,',
        )
        .replace(
          "task_kinds: Some(vec![TASK_KIND.to_string()])",
          'task_kinds: Some(vec!["wrong-task".to_string()])',
        )
        .replace(
          "attempt_count >= MAX_ATTEMPTS_PER_BATCH",
          "attempt_count >= 99",
        ),
      "fn decoy_contract_uses(conn: &Connection) {",
      "    load_change_batch_envelope(conn, project_id, acknowledged, MAX_CANONICAL_SEQUENCES_PER_BATCH);",
      "    get_changes_since(conn, project_id, acknowledged, MAX_CANONICAL_SEQUENCES_PER_BATCH);",
      "    create_system_run_in_tx(",
      '        conn, project_id, "freshness-evaluation", epoch_id,',
      "        work_key, sealed, digest, SystemRunWorkKeyReuse::RunningAndCompleted, None,",
      "    );",
      "    let _ = (CURSOR_CONSUMER_ID, TASK_KIND, MAX_ATTEMPTS_PER_BATCH);",
      "}",
      "",
    ].join("\n");
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    for (const expected of [
      "one canonical load_change_batch_envelope call",
      "one canonical get_changes_since call",
      "MAX_ATTEMPTS_PER_BATCH must govern",
      "canonical reserve_cursor_range_in_tx",
      "TASK_KIND must bind claim_next_task",
      "one canonical create_system_run_in_tx call",
    ]) {
      assert.ok(
        result.errors.some((error) => error.includes(expected)),
        `expected call-bound Rust drift '${expected}', got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("binds TASK_KIND to task creation and exactly one canonical create path", () => {
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "[task_id, run_id, TASK_KIND]",
        '[task_id, run_id, "wrong-task-kind"]',
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "    ensure_batch_task_in_tx(\n",
        "    decoy_ensure_batch_task_in_tx(\n",
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "    ensure_batch_task_in_tx(\n",
        [
          "    ensure_batch_task_in_tx(conn, &run_id, &change_set_id, acknowledged, through_sequence);",
          "    ensure_batch_task_in_tx(",
          "",
        ].join("\n"),
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "(id, run_id, task_kind) VALUES (?1, ?2, ?3)",
        "(id, run_id, priority, task_kind) VALUES (?1, ?2, ?3, 'wrong-task-kind')",
      ),
    ];
    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("TASK_KIND") &&
            (error.includes("task INSERT") ||
              error.includes("ensure_batch_task_in_tx")),
        ),
        `expected TASK_KIND creation seam to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("binds TASK_KIND to the claim payload field and expired-task predicate", () => {
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "&ClaimTaskPayload { task_kinds: Some(vec![TASK_KIND.to_string()]) }",
        '&ClaimTaskPayload { task_kinds: Some(vec!["wrong-task".to_string()]), run_id: TASK_KIND.to_string() }',
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "task_kind = ?2 AND attempt_count >= ?3",
        "task_kind = 'wrong-task' AND attempt_count >= ?3 AND ?2 = ?2",
      ),
    ];
    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("TASK_KIND") ||
            error.includes("expired-attempt terminalization"),
        ),
        `expected task claim/query field drift to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects canonical cursor decoys beside wrong reserve or acknowledge calls", () => {
    const reserve = [
      "    reserve_cursor_range_in_tx(",
      '        conn, project_id, "wrong-consumer", semantic_epoch_id, &run_id, through_sequence,',
      "    );",
      "    reserve_cursor_range_in_tx(",
      "        conn, project_id, CURSOR_CONSUMER_ID, semantic_epoch_id, &run_id, through_sequence,",
      "    );",
    ].join("\n");
    const acknowledge = [
      "    acknowledge_cursor_reservation_in_tx(",
      '        conn, &batch.project_id, "wrong-consumer", &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,',
      "    );",
      "    acknowledge_cursor_reservation_in_tx(",
      "        conn, &batch.project_id, CURSOR_CONSUMER_ID, &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,",
      "    );",
    ].join("\n");
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        [
          "    reserve_cursor_range_in_tx(",
          "        conn, project_id, CURSOR_CONSUMER_ID, semantic_epoch_id, &run_id, through_sequence,",
          "    );",
        ].join("\n"),
        reserve,
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        [
          "    acknowledge_cursor_reservation_in_tx(",
          "        conn, &batch.project_id, CURSOR_CONSUMER_ID, &batch.run_id, &batch.semantic_epoch_id, batch.through_sequence_inclusive,",
          "    );",
        ].join("\n"),
        acknowledge,
      ),
    ];
    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("CURSOR_CONSUMER_ID") &&
            (error.includes("reserve_cursor_range_in_tx") ||
              error.includes("acknowledge_cursor_reservation_in_tx")),
        ),
        `expected cursor decoy/live-call drift to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("binds both cursor-release recovery paths to CURSOR_CONSUMER_ID", () => {
    const cases = [
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "conn, &project_id, CURSOR_CONSUMER_ID, &active.run_id",
        'conn, &project_id, "wrong-consumer", &active.run_id',
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "    release_cursor_reservation_in_tx(\n",
        "    decoy_release_cursor_reservation_in_tx(\n",
      ),
      VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        "fn reserve_or_resume_batch_in_tx(conn: &Connection) {",
        [
          "fn reserve_or_resume_batch_in_tx(conn: &Connection) {",
          "    let release_cursor_reservation_in_tx = fake_release;",
        ].join("\n"),
      ),
    ];
    for (const runtime of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("release_cursor_reservation_in_tx") &&
            error.includes("CURSOR_CONSUMER_ID"),
        ),
        `expected cursor-release recovery drift to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("binds MAX_ATTEMPTS_PER_BATCH to expired-attempt terminalization", () => {
    const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
      "[run_id, TASK_KIND, MAX_ATTEMPTS_PER_BATCH]",
      "[run_id, TASK_KIND, 99]",
    );
    const root = writeFixtureRoot({
      extraRustFiles: {
        "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
          runtime,
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("MAX_ATTEMPTS_PER_BATCH") && error.includes("expired"),
      ),
      `expected expired-attempt max policy binding to fail, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("rejects a correct Rust seam call used as a decoy beside a second wrong call", () => {
    const cases = [
      {
        symbol: "load_change_batch_envelope",
        runtime: VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
          "    load_change_batch_envelope(\n",
          [
            "    load_change_batch_envelope(conn, project_id, acknowledged, 999);",
            "    load_change_batch_envelope(",
            "",
          ].join("\n"),
        ),
      },
      {
        symbol: "get_changes_since",
        runtime: VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
          "    get_changes_since(\n",
          [
            "    get_changes_since(conn, project_id, after_sequence, 999);",
            "    get_changes_since(",
            "",
          ].join("\n"),
        ),
      },
      {
        symbol: "create_system_run_in_tx",
        runtime: VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
          "    create_system_run_in_tx(\n",
          [
            "    create_system_run_in_tx(",
            '        conn, project_id, "interpretation", semantic_epoch_id,',
            "        work_key, sealed, digest, SystemRunWorkKeyReuse::RunningOnly, None,",
            "    );",
            "    create_system_run_in_tx(",
            "",
          ].join("\n"),
        ),
      },
    ];

    for (const { symbol, runtime } of cases) {
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("exactly one canonical") && error.includes(symbol),
        ),
        `expected duplicate ${symbol} calls to fail closed, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects method calls that only imitate the three canonical Rust seams", () => {
    const cases = [
      "load_change_batch_envelope",
      "get_changes_since",
      "create_system_run_in_tx",
    ];
    for (const symbol of cases) {
      const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        `    ${symbol}(\n`,
        `    adapter.${symbol}(\n`,
      );
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("exactly one canonical") && error.includes(symbol),
        ),
        `expected method-shaped ${symbol} decoy to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects local bindings that shadow the three canonical Rust seams", () => {
    for (const symbol of [
      "load_change_batch_envelope",
      "get_changes_since",
      "create_system_run_in_tx",
    ]) {
      const runtime = VALID_INCREMENTAL_FRESHNESS_RUNTIME_RS.replace(
        `    ${symbol}(\n`,
        [`    let ${symbol} = decoy;`, `    ${symbol}(`, ""].join("\n"),
      );
      const root = writeFixtureRoot({
        extraRustFiles: {
          "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs":
            runtime,
        },
      });
      const result = validateRunKindPolicy({ repoRoot: root });
      assert.ok(
        result.errors.some(
          (error) =>
            error.includes("exactly one canonical") && error.includes(symbol),
        ),
        `expected local ${symbol} shadow to fail, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects a non-repair run kind that declares a repair-only field", () => {
    const runKindPolicy = baseRunKindPolicy();
    const verify = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-verify",
    );
    verify.allowedRepairs = ["deactivate-duplicate-edge"];
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-verify must not declare 'allowedRepairs'; only dependency-repair may",
        ),
      ),
    );
  });

  it("rejects dependency-repair missing a required repair-only field", () => {
    const runKindPolicy = baseRunKindPolicy();
    const repair = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-repair",
    );
    delete repair.allowedRepairs;
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-repair is missing required field 'allowedRepairs'",
        ),
      ),
    );
  });

  it("rejects dependency-verify declaring anything other than diagnostics-only writes", () => {
    const runKindPolicy = baseRunKindPolicy();
    const verify = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-verify",
    );
    verify.writes = "durable-graph";
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("dependency-verify.writes must be 'diagnostics-only'"),
      ),
    );
  });

  it("rejects an adminCommands entry not covered by apiSplit.operations", () => {
    const runKindPolicy = baseRunKindPolicy();
    const backfill = runKindPolicy.runKinds.find(
      (entry) => entry.runKind === "dependency-backfill",
    );
    backfill.adminCommands.push("someUnlistedOperation");
    const root = writeFixtureRoot({ runKindPolicy });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-backfill.adminCommands references 'someUnlistedOperation', which is not listed in apiSplit.operations",
        ),
      ),
    );
  });

  it("rejects narrative-run-kind-policy.json when it fails schema validation", () => {
    const root = writeFixtureRoot({
      runKindPolicy: {
        schemaVersion: 1,
        contract: "narrative-run-kind-policy",
      },
    });
    const result = validateRunKindPolicy({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("narrative-run-kind-policy.schema.json rejects"),
      ),
    );
  });
});
