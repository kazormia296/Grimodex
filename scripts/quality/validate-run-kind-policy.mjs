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

const MAINTENANCE_ROUTE_REGISTRY_VERSION = "narrative-maintenance-route/v1";
const MAINTENANCE_ROUTE_ENTRY_POINT = "run_narrative_maintenance_cycle";
const MAINTENANCE_ROUTE_IDS = new Set([
  "dependency-backfill",
  "dependency-verify",
  "dependency-rebuild-derived",
]);
const C2ZC_FUTURE_OBLIGATION_RUN_KINDS = new Set([
  "dependency-verify",
  "dependency-rebuild-derived",
]);

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

function validateFutureTriggerObligations(entry, errors) {
  const obligations = entry.futureTriggerObligations;
  if (C2ZC_FUTURE_OBLIGATION_RUN_KINDS.has(entry.runKind)) {
    const obligation = obligations?.length === 1 ? obligations[0] : null;
    if (
      !isObject(obligation) ||
      obligation.condition !== "before-c2z-cutover" ||
      obligation.gate !== "C2-ZC" ||
      obligation.satisfiesCurrentWiredStatus !== false
    ) {
      errors.push(
        `${entry.runKind}.futureTriggerObligations must contain exactly one before-c2z-cutover obligation for gate 'C2-ZC' with satisfiesCurrentWiredStatus: false`,
      );
    }
  }
  if (obligations === undefined) return;
  if (!Array.isArray(obligations)) return;

  for (const obligation of obligations) {
    if (!isObject(obligation)) continue;
    if (obligation.condition === "before-c2z-cutover") {
      if (obligation.gate !== "C2-ZC") {
        errors.push(
          `${entry.runKind}.futureTriggerObligations.before-c2z-cutover must target gate 'C2-ZC'`,
        );
      }
      if (obligation.satisfiesCurrentWiredStatus !== false) {
        errors.push(
          `${entry.runKind}.futureTriggerObligations.before-c2z-cutover cannot satisfy current wired status`,
        );
      }
      if (entry.triggerEvents?.includes("before-c2z-cutover")) {
        errors.push(
          `${entry.runKind} must keep 'before-c2z-cutover' out of current triggerEvents; record it only as a futureTriggerObligation`,
        );
      }
    }
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
    for (const field of repairOnlyFields) {
      if (entry[field] === undefined) {
        errors.push(`dependency-repair is missing required field '${field}'`);
      }
    }
  } else {
    for (const field of repairOnlyFields) {
      if (entry[field] !== undefined) {
        errors.push(
          `${entry.runKind} must not declare '${field}'; only dependency-repair may`,
        );
      }
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

function validateApiSplit(policy, errors) {
  if (!isObject(policy?.apiSplit)) return;
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
    validateFutureTriggerObligations(entry, errors);
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
