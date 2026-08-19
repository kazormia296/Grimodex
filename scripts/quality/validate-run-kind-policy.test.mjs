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
      failureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
      retryDisposition: "terminal",
      maxAttempts: 3,
      policyVersion: "v1",
    },
  ],
};

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
        `// occurrence ${index}\nrun_kind TEXT NOT NULL ${line},`,
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
  for (const [relativePath, contents] of Object.entries(extraRustFiles)) {
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

  it("rejects a run_kind CHECK constraint occurrence with a value absent from the widest one", () => {
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
          "contains a value absent from the widest occurrence found",
        ),
      ),
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
