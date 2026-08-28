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

const EXPECTED_IDLE_CHECKPOINT = {
  kind: "current-epoch-idle-checkpoint",
  version: 1,
  specKind: "incremental-freshness-idle-checkpoint@1",
  runKind: "freshness-evaluation",
  taskKind: "incremental-freshness-batch",
  zeroWidthRange: {
    fromSequenceExclusive: "feedHead",
    throughSequenceInclusive: "feedHead",
    feedHead: "feedHead",
  },
  epochBinding: "current-semantic-epoch",
  cursor: {
    acknowledgedThroughSequence: "feedHead",
    requiresClean: true,
    missingAllowedOnlyAtFeedHead: 0,
  },
  projectSelection: {
    projectsPerWake: 1,
    order: "project-id-ascending",
  },
  suppression: {
    existingCurrentEpochFreshnessRunAnyStatus: true,
  },
  descriptorBinding: {
    digestAlgorithm: "sha256-canonical-json",
    inputDigestBinding: "task-input-to-spec-and-work-key",
    taskInput: {
      exactKeys: [
        "kind",
        "version",
        "projectId",
        "semanticEpochId",
        "fromSequenceExclusive",
        "throughSequenceInclusive",
        "feedHead",
        "inputDigest",
      ],
      kind: "current-epoch-idle-checkpoint",
      version: 1,
      digestField: "inputDigest",
      digestInput: "canonical-payload-without-inputDigest",
    },
    spec: {
      exactKeys: ["kind", "inputDigest"],
      kind: "incremental-freshness-idle-checkpoint@1",
      inputDigest: "same-as-task-input",
      digestField: "specDigest",
      digestInput: "canonical-spec-object",
    },
    workKey: {
      format:
        "incremental-freshness:{semanticEpochId}:{fromSequenceExclusive}:{throughSequenceInclusive}:{inputDigestHex}",
      digestInput: "task-input-inputDigest-without-sha256-prefix",
    },
  },
  lifecycle: {
    taskCount: 1,
    completedTaskCount: 1,
    taskStatus: "completed",
    taskAttemptCountEqualsAttemptRows: true,
    attemptNumbering: "1..N-contiguous",
    attemptStatuses: ["failed", "completed"],
    completedAttemptCount: 1,
    runningAttemptCount: 0,
    activeAttemptCount: 0,
    noActiveAttempt: true,
    failedRetryHistoryAllowed: true,
    failedRetryHistoryOrder: "failed-before-completed-only",
    completedAttemptMustBeLast: true,
    retryCap: {
      maxAttemptsPerTask: 3,
      corruptedTaskKindCannotBypass: true,
    },
  },
  nextWake: {
    noChurn: true,
  },
  databaseEvidence: {
    schedulerLiveness: "not-proven",
    canonicalCutover: "not-proven",
  },
  writesAllowed: ["run-task-attempt-state", "freshness-evaluator-cursor"],
  forbiddenWrites: [
    "narrative-change-set",
    "consumer-freshness",
    "dependency-edge-state",
    "finding-observation",
    "attention",
    "domain-state",
    "d2-declarations",
    "d2-shadow",
    "semantic-index",
  ],
  forbiddenPublishers: ["generic-consumer-freshness"],
};

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

  it("keeps all 13 production Verify checks and forbids coverage reduction", () => {
    const policy = bundledPolicy();
    const verify = runKind(policy, "dependency-verify");
    assert.deepEqual(verify.verifyCoverage, {
      requiredCheckCount: 13,
      productionCoverage: "13/13",
      reductionForbidden: true,
    });
    assert.equal(
      (verify.verifiesDurableGraph ?? []).length +
        (verify.verifiesRebuildableState ?? []).length,
      13,
    );
    assert.deepEqual(validateFixture(policy).errors, []);

    const reduced = bundledPolicy();
    runKind(reduced, "dependency-verify").verifiesRebuildableState.pop();
    const reducedResult = validateFixture(reduced);
    assert.ok(
      reducedResult.errors.some((error) =>
        error.includes("dependency-verify must retain all 13 production Verify checks"),
      ),
    );

    const staleCoverage = bundledPolicy();
    runKind(staleCoverage, "dependency-verify").verifyCoverage.productionCoverage =
      [11, 13].join("/");
    const staleCoverageResult = validateFixture(staleCoverage);
    assert.ok(
      staleCoverageResult.errors.some((error) =>
        error.includes("productionCoverage must be '13/13'"),
      ),
    );
  });

  it("rejects reintroducing the reserved Semantic Index cache as Rebuild-Derived state", () => {
    const policy = bundledPolicy();
    const rebuild = runKind(policy, "dependency-rebuild-derived");
    rebuild.rebuildableTargets = rebuild.rebuildableTargets.filter(
      (target) => target !== "semantic-index-generation-cache",
    );
    rebuild.rebuildableTargets.push("semantic-index-generation-cache");

    const result = validateFixture(policy);

    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "dependency-rebuild-derived.rebuildableTargets must not include 'semantic-index-generation-cache' while semantic-index is reserved",
        ),
      ),
      `reserved Semantic Index cache must remain outside Rebuild-Derived: ${JSON.stringify(result.errors)}`,
    );
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

  it("keeps triggerEvents as discovery conditions after C2-ZC activation", () => {
    const policy = bundledPolicy();
    for (const name of ["dependency-verify", "dependency-rebuild-derived"]) {
      const entry = runKind(policy, name);
      assert.ok(!entry.triggerEvents.includes("before-c2z-cutover"));
      assert.equal(entry.futureTriggerObligations, undefined);
    }
    assert.deepEqual(validateFixture(policy).errors, []);
  });

  it("rejects a retired C2-ZC condition when it is shipped as a trigger", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-verify").triggerEvents.push(
      "before-c2z-cutover",
    );
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) => error.includes("before-c2z-cutover")),
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

  it("rejects an obsolete C2-ZC future obligation under the scheduler contract", () => {
    const policy = bundledPolicy();
    runKind(policy, "dependency-verify").futureTriggerObligations = [
      {
        condition: "before-c2z-cutover",
        gate: "C2-ZC",
        satisfiesCurrentWiredStatus: false,
      },
    ];
    const result = validateFixture(policy);
    assert.ok(
      result.errors.some((error) =>
        error.includes("futureTriggerObligations is obsolete"),
      ),
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

  it("pins the current-Epoch idle checkpoint to the existing Freshness Run Kind", () => {
    const policy = bundledPolicy();
    const runKinds = policy.runKinds.map((entry) => entry.runKind);
    assert.deepEqual(runKinds, [
      "dependency-backfill",
      "dependency-verify",
      "dependency-rebuild-derived",
      "incremental-freshness",
      "dependency-repair",
    ]);
    assert.deepEqual(
      runKind(policy, "incremental-freshness").idleCheckpoint,
      EXPECTED_IDLE_CHECKPOINT,
    );
    assert.deepEqual(validateFixture(policy).errors, []);
  });

  it("rejects every idle checkpoint contract mutation", () => {
    const mutations = [
      ["kind", "wrong-kind"],
      ["version", 2],
      ["specKind", "incremental-freshness-batch@1"],
      ["runKind", "incremental-freshness"],
      ["taskKind", "unexpected-task"],
      ["zeroWidthRange.fromSequenceExclusive", "acknowledged"],
      ["zeroWidthRange.throughSequenceInclusive", "acknowledged"],
      ["zeroWidthRange.feedHead", "throughSequenceInclusive"],
      ["epochBinding", "run-epoch"],
      ["cursor.acknowledgedThroughSequence", "throughSequenceInclusive"],
      ["cursor.requiresClean", false],
      ["cursor.missingAllowedOnlyAtFeedHead", 1],
      ["projectSelection.projectsPerWake", 2],
      ["projectSelection.order", "created-at"],
      ["suppression.existingCurrentEpochFreshnessRunAnyStatus", false],
      ["descriptorBinding.digestAlgorithm", "sha256-json"],
      ["descriptorBinding.inputDigestBinding", "task-input-only"],
      ["descriptorBinding.taskInput.exactKeys", ["kind"]],
      ["descriptorBinding.taskInput.kind", "incremental-freshness"],
      ["descriptorBinding.taskInput.version", 2],
      ["descriptorBinding.taskInput.digestField", "digest"],
      ["descriptorBinding.taskInput.digestInput", "payload-with-inputDigest"],
      ["descriptorBinding.spec.exactKeys", ["kind"]],
      ["descriptorBinding.spec.kind", "incremental-freshness"],
      ["descriptorBinding.spec.inputDigest", "different-from-task-input"],
      ["descriptorBinding.spec.digestField", "inputDigest"],
      ["descriptorBinding.spec.digestInput", "raw-spec"],
      ["descriptorBinding.workKey.format", "run-id"],
      ["descriptorBinding.workKey.digestInput", "task-id"],
      ["lifecycle.taskCount", 2],
      ["lifecycle.completedTaskCount", 0],
      ["lifecycle.taskStatus", "failed"],
      ["lifecycle.taskAttemptCountEqualsAttemptRows", false],
      ["lifecycle.attemptNumbering", "attempts-may-have-gaps"],
      ["lifecycle.attemptStatuses", ["running", "completed"]],
      ["lifecycle.completedAttemptCount", 2],
      ["lifecycle.runningAttemptCount", 1],
      ["lifecycle.activeAttemptCount", 1],
      ["lifecycle.noActiveAttempt", false],
      ["lifecycle.failedRetryHistoryAllowed", false],
      ["lifecycle.failedRetryHistoryOrder", "failed-after-completed"],
      ["lifecycle.completedAttemptMustBeLast", false],
      ["lifecycle.retryCap.maxAttemptsPerTask", 4],
      ["lifecycle.retryCap.corruptedTaskKindCannotBypass", false],
      ["nextWake.noChurn", false],
      ["databaseEvidence.schedulerLiveness", "proven"],
      ["databaseEvidence.canonicalCutover", "proven"],
      ["writesAllowed", ["run-task-attempt-state", "consumer-freshness"]],
      [
        "forbiddenWrites",
        [
          "narrative-change-set",
          "consumer-freshness",
          "dependency-edge-state",
          "finding-observation",
          "attention",
          "domain-state",
          "d2-declarations",
          "d2-shadow",
        ],
      ],
      ["forbiddenPublishers", ["generic-consumer-freshness-publisher"]],
    ];

    for (const [pathExpression, value] of mutations) {
      const policy = bundledPolicy();
      const idleCheckpoint = runKind(
        policy,
        "incremental-freshness",
      ).idleCheckpoint;
      const pathParts = pathExpression.split(".");
      const leaf = pathParts.pop();
      assert.ok(leaf);
      const target = pathParts.reduce(
        (object, key) => object[key],
        idleCheckpoint,
      );
      target[leaf] = value;

      const result = validateFixture(policy);
      assert.ok(
        result.errors.some((error) =>
          error.includes(
            `incremental-freshness.idleCheckpoint.${pathExpression}`,
          ),
        ),
        `expected idle checkpoint mutation ${pathExpression} to fail: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("requires an exact idle checkpoint object on incremental freshness", () => {
    const missing = bundledPolicy();
    delete runKind(missing, "incremental-freshness").idleCheckpoint;
    const missingResult = validateFixture(missing);
    assert.ok(
      missingResult.errors.some((error) =>
        error.includes("incremental-freshness.idleCheckpoint"),
      ),
    );

    const extra = bundledPolicy();
    runKind(extra, "incremental-freshness").idleCheckpoint.unexpected = true;
    const extraResult = validateFixture(extra);
    assert.ok(
      extraResult.errors.some((error) =>
        error.includes("incremental-freshness.idleCheckpoint.unexpected"),
      ),
    );
  });

  it("rejects an idle checkpoint object on every non-incremental run kind", () => {
    const nonIncrementalRunKinds = [
      "dependency-backfill",
      "dependency-verify",
      "dependency-rebuild-derived",
      "dependency-repair",
    ];

    for (const runKindName of nonIncrementalRunKinds) {
      const policy = bundledPolicy();
      runKind(policy, runKindName).idleCheckpoint = structuredClone(
        EXPECTED_IDLE_CHECKPOINT,
      );
      const result = validateFixture(policy);
      assert.ok(
        result.errors.some((error) =>
          error.includes(`${runKindName}.idleCheckpoint`),
        ),
        `expected ${runKindName} to reject an idle checkpoint: ${JSON.stringify(result.errors)}`,
      );
    }
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
