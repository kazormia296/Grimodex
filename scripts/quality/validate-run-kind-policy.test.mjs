import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateRunKindPolicy } from "./validate-run-kind-policy.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const POLICY_RELATIVE_PATH =
  "policies/narrative/narrative-run-kind-policy.json";
const SCHEMA_RELATIVE_PATH =
  "policies/narrative/schemas/narrative-run-kind-policy.schema.json";

function bundledPolicy() {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, POLICY_RELATIVE_PATH), "utf8"),
  );
}

function runKind(policy, name) {
  const entry = policy.runKinds.find((candidate) => candidate.runKind === name);
  assert.ok(entry, `missing fixture run kind ${name}`);
  return entry;
}

function fixtureRoot(policy = bundledPolicy()) {
  const root = mkdtempSync(path.join(tmpdir(), "run-kind-policy-json-"));
  mkdirSync(path.join(root, "policies/narrative/schemas"), { recursive: true });
  cpSync(
    path.join(REPO_ROOT, SCHEMA_RELATIVE_PATH),
    path.join(root, SCHEMA_RELATIVE_PATH),
  );
  mkdirSync(path.join(root, "policies/narrative"), { recursive: true });
  writeFileSync(
    path.join(root, POLICY_RELATIVE_PATH),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  return root;
}

function validateFixture(policy = bundledPolicy()) {
  const root = fixtureRoot(policy);
  try {
    return validateRunKindPolicy({ repoRoot: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("validate-run-kind-policy", () => {
  it("accepts the bundled policy and keeps the public export", () => {
    assert.deepEqual(validateRunKindPolicy({ repoRoot: REPO_ROOT }).errors, []);
  });

  it("validates a JSON-only fixture without a source checkout", () => {
    assert.deepEqual(validateFixture().errors, []);
  });

  it("requires the five canonical run kinds", () => {
    const policy = bundledPolicy();
    policy.runKinds = policy.runKinds.filter(
      (entry) => entry.runKind !== "dependency-repair",
    );
    const result = validateFixture(policy);
    assert.ok(result.errors.some((error) => error.includes("missing runKind")));
  });

  it("requires stable route metadata for the three automatic maintenance kinds", () => {
    const policy = bundledPolicy();
    for (const name of [
      "dependency-backfill",
      "dependency-verify",
      "dependency-rebuild-derived",
    ]) {
      const entry = runKind(policy, name);
      assert.deepEqual(entry.runtimeRoute, {
        registryVersion: "narrative-maintenance-route/v1",
        routeId: name,
        productionEntryPoint: "run_narrative_maintenance_cycle",
      });
    }
    assert.equal(
      runKind(policy, "dependency-backfill").trigger,
      "automatic-once-after-schema-upgrade",
    );
    assert.equal(
      runKind(policy, "dependency-verify").trigger,
      "automatic-on-trigger-event",
    );
    assert.equal(
      runKind(policy, "dependency-rebuild-derived").trigger,
      "automatic-when-derived-state-absent-or-invalid",
    );
    for (const name of [
      "dependency-backfill",
      "dependency-verify",
      "dependency-rebuild-derived",
    ]) {
      const entry = runKind(policy, name);
      assert.equal(entry.implementationStatus.state, "wired");
      assert.deepEqual(entry.implementationStatus.productionEntryPoints, [
        "run_narrative_maintenance_cycle",
      ]);
    }
    assert.deepEqual(validateFixture(policy).errors, []);
  });

  it("rejects duplicate run kinds", () => {
    const policy = bundledPolicy();
    policy.runKinds[4] = JSON.parse(
      JSON.stringify(runKind(policy, "dependency-verify")),
    );
    const result = validateFixture(policy);
    assert.ok(result.errors.some((error) => error.includes("duplicate runKind")));
  });

  it("rejects a maintenance route registry version drift", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-verify").runtimeRoute.registryVersion =
      "narrative-maintenance-route/v2";
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("registryVersion")),
    );
  });

  it("rejects a wired automatic kind without the explicit route contract", () => {
    const policy = bundledPolicy();
    delete runKind(policy, "dependency-backfill").runtimeRoute;
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("schema rejects policy")),
    );
  });

  it("rejects a route id that does not match its run kind", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-verify").runtimeRoute.routeId =
      "dependency-rebuild-derived";
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("runtimeRoute.routeId")),
    );
  });

  it("rejects a maintenance route production entry point drift", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-rebuild-derived").runtimeRoute.productionEntryPoint =
      "rebuildNarrativeDerivedState";
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("productionEntryPoint")),
    );
  });

  it("rejects maintenance state drift from wired", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-backfill").implementationStatus.state =
      "unwired-blocked";
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("implementationStatus.state")),
    );
  });

  it("does not broaden the maintenance route to incremental or manual repair", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-repair").runtimeRoute = {
      registryVersion: "narrative-maintenance-route/v1",
      routeId: "dependency-repair",
      productionEntryPoint: "run_narrative_maintenance_cycle",
    };
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must not declare runtimeRoute"),
      ),
    );
  });

  it("requires the shared route entry point before a route can be wired", () => {
    const policy = bundledPolicy();
    runKind(
      policy,
      "dependency-backfill",
    ).implementationStatus.productionEntryPoints = [
      "retryNarrativeLegacyBackfill",
    ];
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must include runtimeRoute.productionEntryPoint"),
      ),
    );
  });

  it("keeps triggerEvents as discovery conditions and moves C2-ZC work to a future obligation", () => {
    const policy = bundledPolicy();
    for (const name of ["dependency-verify", "dependency-rebuild-derived"]) {
      const entry = runKind(policy, name);
      assert.ok(!entry.triggerEvents.includes("before-c2z-cutover"));
      assert.deepEqual(entry.futureTriggerObligations, [
        {
          condition: "before-c2z-cutover",
          gate: "C2-ZC",
          satisfiesCurrentWiredStatus: false,
        },
      ]);
    }
    assert.deepEqual(validateFixture(policy).errors, []);
  });

  it("rejects a future C2-ZC condition when it is still shipped as a trigger", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-verify").triggerEvents.push(
      "before-c2z-cutover",
    );
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("futureTriggerObligation")),
    );
  });

  it("rejects the C2-ZC condition in Backfill current triggerEvents", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-backfill").triggerEvents = [
      "before-c2z-cutover",
    ];
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("before-c2z-cutover")),
    );
  });

  it("rejects the C2-ZC condition in incremental current triggerEvents", () => {
    const policy = bundledPolicy();
    runKind(policy, "incremental-freshness").triggerEvents = [
      "before-c2z-cutover",
    ];
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("before-c2z-cutover")),
    );
  });

  it("requires the explicit C2-ZC obligation on Verify and Rebuild-Derived", () => {
    const policy = bundledPolicy();
    delete runKind(policy, "dependency-verify").futureTriggerObligations;
    runKind(
      policy,
      "dependency-rebuild-derived",
    ).futureTriggerObligations[0].gate = "C2-ZB";
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must contain exactly one before-c2z-cutover"),
      ),
    );
  });

  it("rejects a duplicate future C2-ZC obligation", () => {
    const policy = bundledPolicy();
    const obligations = runKind(
      policy,
      "dependency-verify",
    ).futureTriggerObligations;
    obligations.push(JSON.parse(JSON.stringify(obligations[0])));
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must contain exactly one before-c2z-cutover"),
      ),
    );
  });

  it("rejects a future obligation that claims current wired status", () => {
    const policy = bundledPolicy();
    runKind(
      policy,
      "dependency-verify",
    ).futureTriggerObligations[0].satisfiesCurrentWiredStatus = true;
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("schema rejects policy")),
    );
  });

  it("keeps the named API split complete", () => {
    const policy = bundledPolicy();
    policy.apiSplit.operations = policy.apiSplit.operations.filter(
      (operation) => operation !== "verifyNarrativeDependencyGraph",
    );
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("adminCommands references")),
    );
  });

  it("rejects an API split operation outside the exact five-operation union", () => {
    const policy = bundledPolicy();
    policy.apiSplit.operations.push("unexpectedNarrativeOperation");
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("apiSplit.operations must be exactly")),
    );
  });

  it("rejects dependency-repair safety scalar mutations", () => {
    const mutations = [
      ["trigger", "automatic-on-trigger-event"],
      ["sameRequestIdReuse", "reuse-running-only"],
      ["sameWorkKeyReuse", "reuse-running-and-completed"],
      ["manualRetry", true],
      ["manualRetryNote", "retry the repair"],
      ["writes", "diagnostics-only"],
    ];
    for (const [field, value] of mutations) {
      const policy = bundledPolicy();
      runKind(policy, "dependency-repair")[field] = value;
      const result = validateFixture(policy);
      assert.ok(
        result.errors.some((error) => error.includes(`dependency-repair.${field}`)),
        `expected ${field} mutation to fail`,
      );
    }
  });

  it("rejects dependency-repair precondition and safety-list mutations", () => {
    const fields = [
      "requiredPreconditions",
      "allowedRepairs",
      "forbiddenRepairs",
      "unrecoverableDisposition",
    ];
    for (const field of fields) {
      const policy = bundledPolicy();
      runKind(policy, "dependency-repair")[field].push("unsafe-mutation");
      const result = validateFixture(policy);
      assert.ok(
        result.errors.some((error) => error.includes(`dependency-repair.${field}`)),
        `expected ${field} mutation to fail`,
      );
    }
  });

  it("rejects trigger or route declarations on dependency-repair", () => {
    for (const mutation of [
      (repair) => {
        repair.triggerEvents = ["manual-wake"];
      },
      (repair) => {
        repair.runtimeRoute = {
          registryVersion: "narrative-maintenance-route/v1",
          routeId: "dependency-repair",
          productionEntryPoint: "run_narrative_maintenance_cycle",
        };
      },
      (repair) => {
        repair.implementationStatus.triggerSymbol =
          "run_dependency_repair_cycle";
      },
    ]) {
      const policy = bundledPolicy();
      mutation(runKind(policy, "dependency-repair"));
      const result = validateFixture(policy);
      assert.ok(
        result.errors.some((error) => error.includes("dependency-repair")),
      );
    }
  });

  it("rejects an incremental freshness implementation status that is well-formed but unwired", () => {
    const policy = bundledPolicy();
    runKind(policy, "incremental-freshness").implementationStatus = {
      state: "unwired-blocked",
      triggerSymbol: "run_incremental_freshness_cycle",
      productionEntryPoints: ["run_narrative_freshness_cycle"],
      blockedReason: "scheduler wiring is not available",
      blockedOn: ["electron-main-scheduler"],
    };
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("schema rejects policy")),
      "the item schema must reject an unwired incremental freshness status",
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes("incremental-freshness.implementationStatus.state"),
      ),
      "the exported validator must reject an unwired incremental freshness status",
    );
  });

  it("preserves nonautomatic repair and verify/rebuild semantics", () => {
    const policy = bundledPolicy();
    const repair = runKind(policy, "dependency-repair");
    repair.requiredPreconditions = undefined;
    const verify = runKind(policy, "dependency-verify");
    verify.writes = "durable-graph";
    const rebuild = runKind(policy, "dependency-rebuild-derived");
    rebuild.forbiddenWrites = [];
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("dependency-repair")),
    );
    assert.ok(
      result.errors.some((error) => error.includes("dependency-verify.writes")),
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes("dependency-rebuild-derived"),
      ),
    );
  });

  it("preserves the incremental freshness contract", () => {
    const policy = bundledPolicy();
    runKind(policy, "incremental-freshness").maxCanonicalSequencesPerBatch = 16;
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("maxCanonicalSequencesPerBatch"),
      ),
    );
  });

  it("contains no source interpreter or reachability machinery", () => {
    const validator = readFileSync(
      path.join(REPO_ROOT, "scripts/quality/validate-run-kind-policy.mjs"),
      "utf8",
    );
    for (const forbidden of [
      "readdirSync",
      "typescript",
      "scanRustSource",
      "createTypeScriptBindingResolver",
      "migrate.rs",
      "RUST_SOURCE_ROOTS",
    ]) {
      assert.equal(validator.includes(forbidden), false, `found ${forbidden}`);
    }
  });
});
