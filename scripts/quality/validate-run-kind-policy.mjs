#!/usr/bin/env node
/**
 * Validate the Narrative Run Kind Policy contract.
 *
 * This gate deliberately has a narrow boundary: it reads the JSON policy and
 * its JSON Schema, then applies deterministic checks between fields in that
 * document. Runtime reachability belongs to the runtime/integration tests;
 * this validator never interprets application source or attempts to build a
 * call graph.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const POLICY_PATH = "policies/narrative/narrative-run-kind-policy.json";
const SCHEMA_PATH =
  "policies/narrative/schemas/narrative-run-kind-policy.schema.json";

const REQUIRED_RUN_KINDS = [
  "dependency-backfill",
  "dependency-verify",
  "dependency-rebuild-derived",
  "incremental-freshness",
  "dependency-repair",
];

const EXPECTED_EXISTING_RUN_KIND_VALUES = {
  "dependency-backfill": "backfill",
  "dependency-verify": null,
  "dependency-rebuild-derived": "semantic-index-rebuild",
  "incremental-freshness": "freshness-evaluation",
  "dependency-repair": null,
};

const REQUIRED_DEPENDENCY_VERIFY_DURABLE_CHECKS = [
  "producer-and-generation-consistency",
  "active-edge-duplicates",
  "cross-project-edge",
  "consumer-and-source-key-format",
  "application-revision-artifact-references",
  "dependency-set-digest",
  "contribution-to-application-commit-correspondence",
  "legacy-mirror-migration-parity",
];

const REQUIRED_DEPENDENCY_VERIFY_REBUILDABLE_CHECKS = [
  "edge-state-belongs-to-current-epoch",
  "consumer-freshness-dependency-set-digest",
  "finding-observation-belongs-to-current-epoch",
  "cursor-and-feed-head-consistency",
  "semantic-index-generation-correspondence",
];

const REQUIRED_DEPENDENCY_VERIFY_CHECK_COUNT = 13;
const REQUIRED_DEPENDENCY_VERIFY_PRODUCTION_COVERAGE = "13/13";

const MAINTENANCE_ROUTE_REGISTRY_VERSION = "narrative-maintenance-route/v1";
const MAINTENANCE_ROUTE_ENTRY_POINT = "run_narrative_maintenance_cycle";
const MAINTENANCE_ROUTE_IDS = new Set([
  "dependency-backfill",
  "dependency-verify",
  "dependency-rebuild-derived",
]);
const MAINTENANCE_TRIGGER_VALUES = {
  "dependency-backfill": "automatic-once-after-schema-upgrade",
  "dependency-verify": "automatic-on-trigger-event",
  "dependency-rebuild-derived": "automatic-when-derived-state-absent-or-invalid",
};

const MAINTENANCE_ADMIN_COMMANDS = {
  "dependency-backfill": [
    "retryNarrativeLegacyBackfill",
    "getNarrativeBackfillStatus",
  ],
  "dependency-verify": ["verifyNarrativeDependencyGraph"],
  "dependency-rebuild-derived": ["rebuildNarrativeDerivedState"],
};

const REPAIR_REQUIRED_PRECONDITIONS = [
  "successful-verify-run-id",
  "sealed-repair-plan-from-verify-result",
  "repair-plan-digest",
  "current-semantic-epoch-match",
  "exclusive-workspace-lease",
  "automatic-backup-or-snapshot",
  "explicit-confirmation",
  "stable-request-id",
  "change-count-preview",
];

const REPAIR_ALLOWED_REPAIRS = [
  "edge-fully-reconstructible-from-durable-ledger",
  "artifact-with-explicit-dependency-manifest",
  "proposal-revision-edge-uniquely-derivable-from-source-basis-or-read-set",
  "application-contribution-uniquely-derivable-from-commit-receipt",
  "deactivate-duplicate-edge",
  "supersede-a-clear-prior-generation",
];

const REPAIR_FORBIDDEN_REPAIRS = [
  "infer-dependency-from-payload-semantic-analysis",
  "ai-completion-of-a-missing-dependency",
  "select-an-ambiguous-target-path",
  "modify-a-domain-field",
  "rewrite-author-ownership",
  "guess-an-evidence-range",
  "re-adjudicate-semantic-truth",
];

const REPAIR_UNRECOVERABLE_DISPOSITION = [
  "detached",
  "unknown",
  "manual-review-required",
];

const REPAIR_MANUAL_RETRY =
  "crash-recovery-of-an-already-approved-sealed-plan-only";
const REPAIR_MANUAL_RETRY_NOTE =
  "resuming an approved sealed repair plan after a crash is recovery of an already-approved operation, not a new repair decision.";
const API_SPLIT_OPERATIONS = [
  "verifyNarrativeDependencyGraph",
  "rebuildNarrativeDerivedState",
  "repairNarrativeDependencyDeclarations",
  "getNarrativeBackfillStatus",
  "retryNarrativeLegacyBackfill",
];

const INCREMENTAL_FRESHNESS_RETRY_POLICY = {
  maxAttemptsPerTask: 3,
  exhaustedFailureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
  exhaustedRetryDisposition: "terminal",
  failurePolicyVersion: "v1",
  taskAndRunStatusAfterExhaustion: "failed",
  cursorAfterExhaustion: "reserved-lease-free",
  schedulerAfterExhaustion: "idle-until-new-semantic-epoch",
  newEpochReservationRecovery: "release-and-reprocess-under-new-run",
  exhaustedRunAfterNewEpoch: "remains-terminal-failed",
};

const INCREMENTAL_FRESHNESS_RESUME_SEMANTICS = [
  "reuse-sealed-change-set",
  "reclaim-expired-cursor-reservation",
  "resume-running-run-task-attempt",
];

const INCREMENTAL_FRESHNESS_WRITES_ALLOWED = [
  "run-task-attempt-state",
  "narrative-change-set",
  "freshness-evaluator-cursor",
  "dependency-edge-state",
  "consumer-freshness",
  "finding-observation",
];

const INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT =
  "never-reuse-completed-run-and-reprocess-under-new-runtime-owned-run";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function readJson(repoRoot, relativePath, errors, label) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function validateAgainstSchema(repoRoot, policy, errors) {
  const schema = readJson(repoRoot, SCHEMA_PATH, errors, "policy schema");
  if (!schema || policy === null) return;

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(policy)) {
      errors.push(`schema rejects policy: ${ajv.errorsText(validate.errors)}`);
    }
  } catch (error) {
    errors.push(
      `policy schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateImplementationStatus(entry, errors) {
  const status = entry.implementationStatus;
  if (!isObject(status)) return;

  if (status.state === "wired") {
    if (
      !Array.isArray(status.productionEntryPoints) ||
      status.productionEntryPoints.length === 0
    ) {
      errors.push(
        `${entry.runKind}.implementationStatus.wired requires productionEntryPoints`,
      );
    }
    if (status.blockedReason !== undefined || status.blockedOn !== undefined) {
      errors.push(
        `${entry.runKind}.implementationStatus.wired must not retain blockedReason or blockedOn`,
      );
    }
  }

  if (status.state === "unwired-blocked") {
    if (!isNonEmptyString(status.blockedReason)) {
      errors.push(
        `${entry.runKind}.implementationStatus.unwired-blocked requires blockedReason`,
      );
    }
    if (!Array.isArray(status.blockedOn) || status.blockedOn.length === 0) {
      errors.push(
        `${entry.runKind}.implementationStatus.unwired-blocked requires blockedOn`,
      );
    }
  }

  if (MAINTENANCE_ROUTE_IDS.has(entry.runKind)) {
    const route = entry.runtimeRoute;
    if (!isObject(route)) return;
    if (status.state !== "wired") {
      errors.push(
        `${entry.runKind}.implementationStatus.state must be 'wired' for a registered maintenance route`,
      );
    }
    if (
      !sameStringArray(status.productionEntryPoints, [
        MAINTENANCE_ROUTE_ENTRY_POINT,
      ])
    ) {
      errors.push(
        `${entry.runKind}.implementationStatus.productionEntryPoints must be exactly ['${MAINTENANCE_ROUTE_ENTRY_POINT}']`,
      );
    }
    if (route.routeId !== entry.runKind) {
      errors.push(
        `${entry.runKind}.runtimeRoute.routeId must equal '${entry.runKind}'`,
      );
    }
    if (route.registryVersion !== MAINTENANCE_ROUTE_REGISTRY_VERSION) {
      errors.push(
        `${entry.runKind}.runtimeRoute.registryVersion must be '${MAINTENANCE_ROUTE_REGISTRY_VERSION}'`,
      );
    }
    if (route.productionEntryPoint !== MAINTENANCE_ROUTE_ENTRY_POINT) {
      errors.push(
        `${entry.runKind}.runtimeRoute.productionEntryPoint must be '${MAINTENANCE_ROUTE_ENTRY_POINT}'`,
      );
    }
    if (
      status.state === "wired" &&
      !status.productionEntryPoints?.includes(MAINTENANCE_ROUTE_ENTRY_POINT)
    ) {
      errors.push(
        `${entry.runKind}.implementationStatus.wired must include runtimeRoute.productionEntryPoint '${MAINTENANCE_ROUTE_ENTRY_POINT}'`,
      );
    }
    if (status.triggerSymbol !== undefined) {
      errors.push(
        `${entry.runKind}.implementationStatus must use runtimeRoute instead of triggerSymbol`,
      );
    }
  } else if (entry.runtimeRoute !== undefined) {
    errors.push(
      `${entry.runKind} must not declare runtimeRoute; only the three automatic maintenance kinds use the shared route registry`,
    );
  }
}

function validateRetiredC2ZcTriggerDeclarations(entry, errors) {
  const obligations = entry.futureTriggerObligations;
  if (entry.triggerEvents?.includes("before-c2z-cutover")) {
    errors.push(
      `${entry.runKind} must keep obsolete 'before-c2z-cutover' out of current triggerEvents; C2-ZC activation is owned by the main-only scheduler wake`,
    );
  }
  if (obligations !== undefined) {
    errors.push(
      `${entry.runKind}.futureTriggerObligations is obsolete under the C2-ZC main-only scheduler contract; final C2-ZC acceptance remains pending`,
    );
  }
}

function validateIncrementalFreshness(entry, errors) {
  if (entry.runKind !== "incremental-freshness") return;

  const expected = {
    existingRunKindColumnValue: "freshness-evaluation",
    trigger: "automatic-on-change-feed",
    sameWorkKeyReuse: "reuse-running-only",
    cursorBound: true,
    cursorConsumerId: "narrative-incremental-freshness/v1",
    maxCanonicalSequencesPerBatch: 32,
    executionAuthority: "serialized-live-workspace-authority",
    missingSemanticEpochBehavior: "wait-for-canonical-epoch-authority",
    writes: "rebuildable-state-only",
    manualRetry: false,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (entry[field] !== value) {
      errors.push(`incremental-freshness.${field} must be '${value}'`);
    }
  }

  for (const [field, value] of Object.entries(
    INCREMENTAL_FRESHNESS_RETRY_POLICY,
  )) {
    if (entry.retryPolicy?.[field] !== value) {
      errors.push(
        `incremental-freshness.retryPolicy.${field} must be '${value}'`,
      );
    }
  }
  if (
    !sameStringArray(
      entry.resumeSemantics,
      INCREMENTAL_FRESHNESS_RESUME_SEMANTICS,
    )
  ) {
    errors.push(
      "incremental-freshness.resumeSemantics has drifted from the bounded resume contract",
    );
  }
  if (
    entry.completedWithUnackedRangeInvariant !==
    INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT
  ) {
    errors.push(
      `incremental-freshness.completedWithUnackedRangeInvariant must be '${INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT}'`,
    );
  }
  if (
    !sameStringArray(entry.writesAllowed, INCREMENTAL_FRESHNESS_WRITES_ALLOWED)
  ) {
    errors.push(
      "incremental-freshness.writesAllowed has drifted from the rebuildable-state allowlist",
    );
  }
  for (const forbiddenWrite of ["domain-state", "attention"]) {
    if (!entry.forbiddenWrites?.includes(forbiddenWrite)) {
      errors.push(
        `incremental-freshness.forbiddenWrites must include '${forbiddenWrite}'`,
      );
    }
  }
  if (
    entry.implementationStatus?.triggerSymbol !==
    "run_incremental_freshness_cycle"
  ) {
    errors.push(
      "incremental-freshness.implementationStatus.triggerSymbol must be 'run_incremental_freshness_cycle'",
    );
  }
  if (entry.implementationStatus?.state !== "wired") {
    errors.push(
      "incremental-freshness.implementationStatus.state must be 'wired'",
    );
  }
  if (
    !sameStringArray(entry.implementationStatus?.productionEntryPoints, [
      "run_narrative_freshness_cycle",
    ])
  ) {
    errors.push(
      "incremental-freshness.implementationStatus.productionEntryPoints must name only 'run_narrative_freshness_cycle'",
    );
  }
}

function validateRunKindSpecificFields(entry, errors) {
  if (MAINTENANCE_ROUTE_IDS.has(entry.runKind)) {
    if (entry.trigger !== MAINTENANCE_TRIGGER_VALUES[entry.runKind]) {
      errors.push(
        `${entry.runKind}.trigger must be '${MAINTENANCE_TRIGGER_VALUES[entry.runKind]}'`,
      );
    }
    if (
      !sameStringArray(
        entry.adminCommands,
        MAINTENANCE_ADMIN_COMMANDS[entry.runKind],
      )
    ) {
      errors.push(
        `${entry.runKind}.adminCommands must be exactly ${JSON.stringify(MAINTENANCE_ADMIN_COMMANDS[entry.runKind])}`,
      );
    }
  }

  if (
    entry.trigger === "automatic-on-trigger-event" ||
    entry.trigger === "automatic-when-derived-state-absent-or-invalid"
  ) {
    if (
      !Array.isArray(entry.triggerEvents) ||
      entry.triggerEvents.length === 0
    ) {
      errors.push(
        `${entry.runKind} automatic trigger requires discovery conditions in triggerEvents`,
      );
    }
  }
  if (entry.trigger === "manual-only" && entry.triggerEvents !== undefined) {
    errors.push(
      `${entry.runKind} manual-only policy must not declare current triggerEvents`,
    );
  }

  const repairOnlyFields = [
    "requiredPreconditions",
    "allowedRepairs",
    "forbiddenRepairs",
    "unrecoverableDisposition",
  ];
  if (entry.runKind === "dependency-repair") {
    const expectedScalars = {
      trigger: "manual-only",
      sameRequestIdReuse: "idempotent-replay",
      sameWorkKeyReuse: "no-automatic-reuse-decision",
      epochBound: true,
      cursorBound: false,
      periodic: false,
      manualRetry: REPAIR_MANUAL_RETRY,
      manualRetryNote: REPAIR_MANUAL_RETRY_NOTE,
      writes: "durable-graph",
    };
    for (const [field, value] of Object.entries(expectedScalars)) {
      if (entry[field] !== value) {
        errors.push(`dependency-repair.${field} must be ${JSON.stringify(value)}`);
      }
    }

    const expectedArrays = {
      requiredPreconditions: REPAIR_REQUIRED_PRECONDITIONS,
      allowedRepairs: REPAIR_ALLOWED_REPAIRS,
      forbiddenRepairs: REPAIR_FORBIDDEN_REPAIRS,
      unrecoverableDisposition: REPAIR_UNRECOVERABLE_DISPOSITION,
    };
    for (const [field, value] of Object.entries(expectedArrays)) {
      if (!sameStringArray(entry[field], value)) {
        errors.push(
          `dependency-repair.${field} must be exactly ${JSON.stringify(value)}`,
        );
      }
    }
    if (entry.triggerEvents !== undefined) {
      errors.push("dependency-repair must not declare triggerEvents");
    }
    if (entry.runtimeRoute !== undefined) {
      errors.push("dependency-repair must not declare runtimeRoute");
    }
    if (
      !sameStringArray(entry.adminCommands, [
        "repairNarrativeDependencyDeclarations",
      ])
    ) {
      errors.push(
        "dependency-repair.adminCommands must be exactly ['repairNarrativeDependencyDeclarations']",
      );
    }
    if (entry.implementationStatus?.state !== "wired") {
      errors.push("dependency-repair.implementationStatus.state must be 'wired'");
    }
    if (
      !sameStringArray(entry.implementationStatus?.productionEntryPoints, [
        "repairNarrativeDependencyDeclarations",
      ])
    ) {
      errors.push(
        "dependency-repair.implementationStatus.productionEntryPoints must be exactly ['repairNarrativeDependencyDeclarations']",
      );
    }
    if (entry.implementationStatus?.triggerSymbol !== undefined) {
      errors.push(
        "dependency-repair.implementationStatus must not declare triggerSymbol",
      );
    }
  } else {
    for (const field of repairOnlyFields) {
      if (entry[field] === undefined) continue;
      errors.push(
        `${entry.runKind} must not declare '${field}'; only dependency-repair may`,
      );
    }
  }

  if (entry.runKind === "dependency-verify") {
    if (entry.writes !== "diagnostics-only") {
      errors.push("dependency-verify.writes must be 'diagnostics-only'");
    }
    if (entry.forbidSideEffectRepair !== true) {
      errors.push(
        "dependency-verify must declare forbidSideEffectRepair: true",
      );
    }
    validateDependencyVerifyCoverage(entry, errors);
  }

  if (entry.runKind === "dependency-rebuild-derived") {
    if (entry.writes !== "rebuildable-state-only") {
      errors.push(
        "dependency-rebuild-derived.writes must be 'rebuildable-state-only'",
      );
    }
    if (
      !Array.isArray(entry.forbiddenWrites) ||
      entry.forbiddenWrites.length === 0
    ) {
      errors.push(
        "dependency-rebuild-derived must declare a non-empty forbiddenWrites list",
      );
    }
  }
}

function validateDependencyVerifyCoverage(entry, errors) {
  if (
    !sameStringArray(
      entry.verifiesDurableGraph,
      REQUIRED_DEPENDENCY_VERIFY_DURABLE_CHECKS,
    ) ||
    !sameStringArray(
      entry.verifiesRebuildableState,
      REQUIRED_DEPENDENCY_VERIFY_REBUILDABLE_CHECKS,
    )
  ) {
    errors.push(
      "dependency-verify must retain all 13 production Verify checks without reduction",
    );
  }

  const coverage = entry.verifyCoverage;
  if (
    !isObject(coverage) ||
    coverage.requiredCheckCount !== REQUIRED_DEPENDENCY_VERIFY_CHECK_COUNT
  ) {
    errors.push(
      "dependency-verify.verifyCoverage.requiredCheckCount must be 13",
    );
  }
  if (
    !isObject(coverage) ||
    coverage.productionCoverage !== REQUIRED_DEPENDENCY_VERIFY_PRODUCTION_COVERAGE
  ) {
    errors.push(
      "dependency-verify.verifyCoverage.productionCoverage must be '13/13'",
    );
  }
  if (!isObject(coverage) || coverage.reductionForbidden !== true) {
    errors.push(
      "dependency-verify.verifyCoverage.reductionForbidden must be true",
    );
  }
}

function validateApiSplit(policy, errors) {
  if (!isObject(policy?.apiSplit)) return;
  if (!sameStringArray(policy.apiSplit.operations, API_SPLIT_OPERATIONS)) {
    errors.push(
      `apiSplit.operations must be exactly ${JSON.stringify(API_SPLIT_OPERATIONS)}`,
    );
  }
  const operations = new Set(policy.apiSplit.operations ?? []);
  for (const entry of policy.runKinds ?? []) {
    if (!isObject(entry) || !Array.isArray(entry.adminCommands)) continue;
    for (const command of entry.adminCommands) {
      if (!operations.has(command)) {
        errors.push(
          `${entry.runKind}.adminCommands references '${command}', which is not listed in apiSplit.operations`,
        );
      }
    }
  }
}

function validateCrossFieldContract(policy, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;

  const seen = new Set();
  for (const entry of policy.runKinds) {
    if (!isObject(entry) || !isNonEmptyString(entry.runKind)) continue;
    if (seen.has(entry.runKind))
      errors.push(`duplicate runKind: ${entry.runKind}`);
    seen.add(entry.runKind);

    if (!Object.hasOwn(EXPECTED_EXISTING_RUN_KIND_VALUES, entry.runKind)) {
      errors.push(`unexpected runKind: ${entry.runKind}`);
      continue;
    }
    const expectedColumnValue =
      EXPECTED_EXISTING_RUN_KIND_VALUES[entry.runKind];
    if (entry.existingRunKindColumnValue !== expectedColumnValue) {
      errors.push(
        `${entry.runKind}.existingRunKindColumnValue must be ${expectedColumnValue === null ? "null" : `'${expectedColumnValue}'`}`,
      );
    }
    if (
      entry.runKind === "incremental-freshness" &&
      entry.cursorBound !== true
    ) {
      errors.push("incremental-freshness.cursorBound must be true");
    }
    if (
      entry.runKind !== "incremental-freshness" &&
      entry.cursorBound !== false
    ) {
      errors.push(`${entry.runKind}.cursorBound must be false`);
    }

    validateImplementationStatus(entry, errors);
    validateRetiredC2ZcTriggerDeclarations(entry, errors);
    validateIncrementalFreshness(entry, errors);
    validateRunKindSpecificFields(entry, errors);
  }

  for (const runKind of REQUIRED_RUN_KINDS) {
    if (!seen.has(runKind))
      errors.push(`policy is missing runKind: ${runKind}`);
  }
  for (const runKind of seen) {
    if (!REQUIRED_RUN_KINDS.includes(runKind)) {
      errors.push(`policy declares unexpected runKind: ${runKind}`);
    }
  }
  validateApiSplit(policy, errors);
}

export function validateRunKindPolicy({ repoRoot = REPO_ROOT } = {}) {
  const errors = [];
  const policy = readJson(repoRoot, POLICY_PATH, errors, "policy");
  validateAgainstSchema(repoRoot, policy, errors);
  validateCrossFieldContract(policy, errors);
  return { errors };
}

function main() {
  const result = validateRunKindPolicy();
  if (result.errors.length > 0) {
    console.error("Gate C2 Run Kind Policy is invalid:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("validate-run-kind-policy: ok");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
