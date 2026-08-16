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
  for (const [relativePath, contents] of Object.entries(extraRustFiles)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

const BACKFILL_SYMBOL = "fixture_backfill_trigger_symbol_that_is_never_called";

function setBackfillStatus(runKindPolicy, patch) {
  const backfill = runKindPolicy.runKinds.find(
    (entry) => entry.runKind === "dependency-backfill",
  );
  Object.assign(backfill.implementationStatus, patch);
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

  it("rejects a policy missing one of the four required run kinds", () => {
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
