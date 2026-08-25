#!/usr/bin/env node
/**
 * Validate the Gate C2-00 Contract / Registry / Ledger Spine.
 *
 * This is a JSON-contract-only validator: it checks that
 * narrative-execution-state.json, narrative-failure-policy.json,
 * narrative-finding-contract.json, and maintenance-attention-contract.json
 * are internally consistent, are linked correctly to the existing
 * semantic-core-authorities.json matrix, and have not silently dropped a
 * status the current TypeScript runtime types already use. It does not
 * assert that a Rust status enum, SQL CHECK constraint, or transition
 * function exists yet — that lands in C2-01 (SQL) and Lane B (Rust), and is
 * enforced by a stricter parity validator at C2-T1. It also re-checks that
 * ADR 005's existing "C2 start condition" checklist is still present and
 * fixed, instead of declaring a second, duplicate checklist.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const ENTITY_NAMES = Object.freeze(["run", "task", "attempt"]);

const ADR_005_PATH = "docs/adr/005-narrative-semantic-core-boundary.md";
const ADR_005_C2_START_CONDITION = Object.freeze([
  "Mutation Route",
  "Source Event Contract",
  "Object Addressing",
  "State Vocabulary",
  "Authority Matrix",
  "Disclosure Policy",
  "Evidence / Scope",
]);

const RUNTIME_STATUS_TYPES = Object.freeze({
  run: "NarrativeExtractionRunStatus",
  task: "NarrativeExtractionTaskStatus",
  attempt: "NarrativeExtractionAttemptStatus",
});
const RUNTIME_TYPES_PATH = "src/features/narrative-extraction/runtime/types.ts";

const REQUIRED_ATTENTION_APPLICATION_CONDITIONS = Object.freeze([
  "finding-key-match",
  "finding-identity-resolved",
  "material-basis-digest-match",
  "snooze-not-expired",
]);

const CANONICAL_TERMINAL_FINDING_RULE = Object.freeze({
  ruleId: "narrative.maintenance-contract-failure",
  // Version 2 folds evidenceDetailDigest into the Observation/Material Basis
  // digests so two graph-repair Findings over different Verify reports are
  // distinguishable (Changed) instead of replaying as the same evidence.
  version: 2,
  identityScope: "maintenance-work",
  observationStorageClass: "durable-derived-history",
  writerAuthority: "maintenance-run-finalization-transaction",
  observationFields: Object.freeze([
    "stableSubject",
    "failureCode",
    "reasonCode",
    "evidenceFreshness",
    "evidenceDetailDigest",
  ]),
  materialBasisFields: Object.freeze([
    "stableSubject",
    "failureCode",
    "reasonCode",
    "evidenceFreshness",
    "evidenceDetailDigest",
  ]),
});

// C2-5B owns the three maintenance lifecycle classifications below.  Keep
// this table exact and code-based: a failure code is not retryable merely
// because it shares a prefix or substring with a known code from another
// phase, and transport-level JavaScript retries do not consume this ledger
// policy's Attempt budget.
const C25B_FAILURE_POLICY_EXPECTATIONS = Object.freeze({
  NEX_MAINTENANCE_TRANSIENT: Object.freeze({
    retryDisposition: "retryable",
    maxAttempts: 3,
    backoffPolicy: "exponential-bounded",
    nextAttemptPolicy: "requeue-same-sealed-system-work",
    findingRoute: "none",
  }),
  NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_UNCLASSIFIED: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_INTERRUPTED: Object.freeze({
    retryDisposition: "retryable",
    maxAttempts: 3,
    backoffPolicy: "exponential-bounded",
    nextAttemptPolicy: "requeue-new-run-same-sealed-system-work",
    findingRoute: "none",
  }),
  // Recovery-synthesized manual halts and the non-clean-Verify repair gate
  // are runtime Finding routes too: the machine-readable contract must name
  // every code the Maintenance Inbox can carry.
  NEX_MAINTENANCE_RETRY_EXHAUSTED: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_FAILURE_DETAIL_MISSING: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_FAILURE_LEDGER_MISSING: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_RETRY_EVIDENCE_INVALID: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
  NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR: Object.freeze({
    retryDisposition: "manual",
    maxAttempts: 0,
    backoffPolicy: "none",
    nextAttemptPolicy: "none",
    findingRoute: "maintenance-inbox",
  }),
});

const C25B_FAILURE_CODE_ORDER = Object.freeze([
  "NEX_MAINTENANCE_TRANSIENT",
  "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
  "NEX_MAINTENANCE_UNCLASSIFIED",
  "NEX_MAINTENANCE_INTERRUPTED",
  "NEX_MAINTENANCE_RETRY_EXHAUSTED",
  "NEX_MAINTENANCE_FAILURE_DETAIL_MISSING",
  "NEX_MAINTENANCE_FAILURE_LEDGER_MISSING",
  "NEX_MAINTENANCE_RETRY_EVIDENCE_INVALID",
  "NEX_MAINTENANCE_RUN_ORDER_AMBIGUOUS",
  "NEX_MAINTENANCE_LEDGER_SELECTOR_INVALID",
  "NEX_SEMANTIC_GRAPH_REQUIRES_REPAIR",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function readJson(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function validateAgainstSchema(repoRoot, schemaName, contractName, errors) {
  const schema = readJson(
    repoRoot,
    `policies/narrative/schemas/${schemaName}`,
    errors,
    `policy JSON Schema ${schemaName}`,
  );
  const contract = readJson(
    repoRoot,
    `policies/narrative/${contractName}`,
    errors,
    `policy contract ${contractName}`,
  );
  if (!schema || !contract) return contract;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(contract)) {
      errors.push(
        `${schemaName} rejects ${contractName}: ${ajv.errorsText(validate.errors)}`,
      );
    }
  } catch (error) {
    errors.push(
      `${schemaName} could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return contract;
}

function validateExecutionStateEntities(executionState, errors) {
  if (!isObject(executionState)) return;
  for (const entityName of ENTITY_NAMES) {
    const entity = executionState.entities?.[entityName];
    if (!isObject(entity)) continue;
    const statuses = new Set(entity.statuses ?? []);
    const terminalStatuses = new Set(entity.terminalStatuses ?? []);
    const derivedKeys = new Set(Object.keys(entity.derivedView ?? {}));

    for (const status of terminalStatuses) {
      if (!statuses.has(status)) {
        errors.push(
          `entities.${entityName}.terminalStatuses contains a status not in statuses: ${status}`,
        );
      }
    }
    if (
      derivedKeys.size !== statuses.size ||
      [...statuses].some((status) => !derivedKeys.has(status))
    ) {
      errors.push(
        `entities.${entityName}.derivedView must declare exactly the same statuses as entities.${entityName}.statuses`,
      );
    }
    for (const [status, view] of Object.entries(entity.derivedView ?? {})) {
      const isTerminalView = view?.phase === "terminal";
      const isTerminalStatus = terminalStatuses.has(status);
      if (isTerminalView !== isTerminalStatus) {
        errors.push(
          `entities.${entityName}.derivedView.${status}.phase disagrees with terminalStatuses (phase=${view?.phase}, terminal=${isTerminalStatus})`,
        );
      }
    }
  }
}

function validateRunSupersedeCascade(executionState, failurePolicy, errors) {
  if (!isObject(executionState) || !isObject(failurePolicy)) return;
  const taskStatuses = new Set(executionState.entities?.task?.statuses ?? []);
  const attemptStatuses = new Set(
    executionState.entities?.attempt?.statuses ?? [],
  );
  const cascade = executionState.runSupersedeCascade;
  if (!isObject(cascade)) return;

  const taskCascade = cascade.task;
  if (isObject(taskCascade)) {
    for (const status of taskCascade.fromStatuses ?? []) {
      if (!taskStatuses.has(status)) {
        errors.push(
          `runSupersedeCascade.task.fromStatuses references unknown task status: ${status}`,
        );
      }
    }
    if (!taskStatuses.has(taskCascade.toStatus)) {
      errors.push(
        `runSupersedeCascade.task.toStatus is not a known task status: ${taskCascade.toStatus}`,
      );
    }
  }

  const attemptCascade = cascade.attempt;
  if (isObject(attemptCascade)) {
    for (const status of attemptCascade.fromStatuses ?? []) {
      if (!attemptStatuses.has(status)) {
        errors.push(
          `runSupersedeCascade.attempt.fromStatuses references unknown attempt status: ${status}`,
        );
      }
    }
    if (!attemptStatuses.has(attemptCascade.toStatus)) {
      errors.push(
        `runSupersedeCascade.attempt.toStatus is not a known attempt status: ${attemptCascade.toStatus}`,
      );
    }
    const policies = Array.isArray(failurePolicy.policies)
      ? failurePolicy.policies
      : [];
    const policy = policies.find(
      (entry) => entry?.failureCode === attemptCascade.failureCode,
    );
    if (!policy) {
      errors.push(
        `runSupersedeCascade.attempt.failureCode is not registered in narrative-failure-policy.json: ${attemptCascade.failureCode}`,
      );
    } else if (policy.retryDisposition !== attemptCascade.retryDisposition) {
      errors.push(
        `runSupersedeCascade.attempt.retryDisposition (${attemptCascade.retryDisposition}) disagrees with the registered failure policy for ${attemptCascade.failureCode} (${policy.retryDisposition})`,
      );
    }
  }
}

function validateFailurePolicy(failurePolicy, errors) {
  if (!isObject(failurePolicy) || !Array.isArray(failurePolicy.policies)) {
    return;
  }
  const seen = new Set();
  const policiesByCode = new Map();
  for (const policy of failurePolicy.policies) {
    if (!isObject(policy) || !isNonEmptyString(policy.failureCode)) continue;
    if (seen.has(policy.failureCode)) {
      errors.push(`duplicate failureCode: ${policy.failureCode}`);
    }
    seen.add(policy.failureCode);
    policiesByCode.set(policy.failureCode, policy);
    const isRetryable = policy.retryDisposition === "retryable";
    const hasNextAttemptPolicy = policy.nextAttemptPolicy !== "none";
    if (isRetryable && !hasNextAttemptPolicy) {
      errors.push(
        `${policy.failureCode} is retryable but declares nextAttemptPolicy "none"; the C2-01 invariant requires next_attempt_at to be set only when retryDisposition is retryable`,
      );
    }
    if (!isRetryable && hasNextAttemptPolicy) {
      errors.push(
        `${policy.failureCode} is not retryable (${policy.retryDisposition}) but declares a nextAttemptPolicy other than "none"`,
      );
    }
  }

  // C2-5B is a canonical contract: every policy document, including test
  // fixtures, must carry all three exact registrations and their ordered
  // Finding routing matrix. Runtime activation is intentionally out of scope.
  for (const failureCode of C25B_FAILURE_CODE_ORDER) {
    const expected = C25B_FAILURE_POLICY_EXPECTATIONS[failureCode];
    const policy = policiesByCode.get(failureCode);
    if (!policy) {
      errors.push(
        `C2-5B failure policy is missing the exact registration for ${failureCode}`,
      );
      continue;
    }
    for (const field of [
      "retryDisposition",
      "maxAttempts",
      "backoffPolicy",
      "nextAttemptPolicy",
    ]) {
      if (policy[field] !== expected[field]) {
        errors.push(
          `${failureCode} ${field} must be exactly ${JSON.stringify(expected[field])} for C2-5B failure policy; got ${JSON.stringify(policy[field])}`,
        );
      }
    }
  }

  const routingMatrix = failurePolicy.findingRoutingMatrix;
  if (!Array.isArray(routingMatrix)) {
    errors.push(
      "C2-5B failure policy must declare findingRoutingMatrix for its exact Finding routing contract",
    );
    return;
  }
  const actualOrder = routingMatrix.map((route) =>
    isObject(route) ? route.failureCode : undefined,
  );
  if (
    actualOrder.length !== C25B_FAILURE_CODE_ORDER.length ||
    actualOrder.some(
      (failureCode, index) => failureCode !== C25B_FAILURE_CODE_ORDER[index],
    )
  ) {
    errors.push(
      `C2-5B findingRoutingMatrix must use the canonical order: ${C25B_FAILURE_CODE_ORDER.join(", ")}`,
    );
  }
  const routedCodes = new Set();
  for (const route of routingMatrix) {
    if (!isObject(route) || !isNonEmptyString(route.failureCode)) continue;
    if (routedCodes.has(route.failureCode)) {
      errors.push(
        `C2-5B findingRoutingMatrix contains duplicate failureCode: ${route.failureCode}`,
      );
    }
    routedCodes.add(route.failureCode);
    const expected = C25B_FAILURE_POLICY_EXPECTATIONS[route.failureCode];
    if (!expected) {
      errors.push(
        `C2-5B findingRoutingMatrix contains unknown failureCode ${route.failureCode}; matching by prefix or substring is forbidden`,
      );
      continue;
    }
    if (route.findingRoute !== expected.findingRoute) {
      errors.push(
        `${route.failureCode} Finding route must be exactly '${expected.findingRoute}' for C2-5B failure policy; got '${route.findingRoute}'`,
      );
    }
  }
  for (const failureCode of C25B_FAILURE_CODE_ORDER) {
    const expected = C25B_FAILURE_POLICY_EXPECTATIONS[failureCode];
    if (!routedCodes.has(failureCode)) {
      errors.push(
        `C2-5B findingRoutingMatrix is missing the exact route for ${failureCode} (expected '${expected.findingRoute}')`,
      );
    }
  }
  if (routedCodes.size !== Object.keys(C25B_FAILURE_POLICY_EXPECTATIONS).length) {
    errors.push(
      "C2-5B findingRoutingMatrix must contain exactly the canonical C2-5B failure codes; unknown or cross-phase codes are not routed by substring",
    );
  }
}

function validateFindingRuleRegistry(findingContract, errors) {
  if (!isObject(findingContract) || !Array.isArray(findingContract.rules)) {
    return;
  }
  const seen = new Set();
  for (const rule of findingContract.rules) {
    if (
      !isObject(rule) ||
      !isNonEmptyString(rule.ruleId) ||
      !Number.isInteger(rule.version)
    ) {
      continue;
    }
    const key = `${rule.ruleId}@${rule.version}`;
    if (seen.has(key)) {
      errors.push(
        `narrative-finding-contract.json has duplicate ruleId/version: ${key}`,
      );
    }
    seen.add(key);
    if (rule.identityScope === "maintenance-work") {
      if (rule.observationStorageClass !== "durable-derived-history") {
        errors.push(
          `maintenance-work rule must declare observationStorageClass durable-derived-history: ${key}`,
        );
      }
      if (rule.writerAuthority !== "maintenance-run-finalization-transaction") {
        errors.push(
          `maintenance-work rule must declare writerAuthority maintenance-run-finalization-transaction: ${key}`,
        );
      }
    }
  }

  const canonicalRules = findingContract.rules.filter(
    (rule) =>
      isObject(rule) &&
      rule.ruleId === CANONICAL_TERMINAL_FINDING_RULE.ruleId &&
      rule.version === CANONICAL_TERMINAL_FINDING_RULE.version,
  );
  if (canonicalRules.length !== 1) {
    errors.push(
      `narrative-finding-contract.json must contain exactly one canonical terminal rule ${CANONICAL_TERMINAL_FINDING_RULE.ruleId}@${CANONICAL_TERMINAL_FINDING_RULE.version}; found ${canonicalRules.length}`,
    );
  }
  const canonicalRuleIdEntries = findingContract.rules.filter(
    (rule) =>
      isObject(rule) && rule.ruleId === CANONICAL_TERMINAL_FINDING_RULE.ruleId,
  );
  if (canonicalRuleIdEntries.length > 1) {
    errors.push(
      `narrative-finding-contract.json canonical terminal ruleId must not have another version: ${CANONICAL_TERMINAL_FINDING_RULE.ruleId}`,
    );
  }
  const [canonicalRule] = canonicalRules;
  if (!canonicalRule) return;
  for (const property of [
    "identityScope",
    "observationStorageClass",
    "writerAuthority",
  ]) {
    if (canonicalRule[property] !== CANONICAL_TERMINAL_FINDING_RULE[property]) {
      errors.push(
        `canonical terminal rule ${CANONICAL_TERMINAL_FINDING_RULE.ruleId}@${CANONICAL_TERMINAL_FINDING_RULE.version} must declare ${property}=${CANONICAL_TERMINAL_FINDING_RULE[property]}`,
      );
    }
  }
  for (const property of ["observationFields", "materialBasisFields"]) {
    if (
      !hasExactStringSet(
        canonicalRule[property],
        CANONICAL_TERMINAL_FINDING_RULE[property],
      )
    ) {
      errors.push(
        `canonical terminal rule ${CANONICAL_TERMINAL_FINDING_RULE.ruleId}@${CANONICAL_TERMINAL_FINDING_RULE.version} must declare the exact ${property} set`,
      );
    }
  }
}

function validateAttentionApplicationConditions(attentionContract, errors) {
  if (
    !isObject(attentionContract) ||
    !Array.isArray(attentionContract.applicationConditions)
  ) {
    return;
  }
  const actual = attentionContract.applicationConditions;
  const exactCanonicalSet =
    actual.length === REQUIRED_ATTENTION_APPLICATION_CONDITIONS.length &&
    new Set(actual).size === actual.length &&
    REQUIRED_ATTENTION_APPLICATION_CONDITIONS.every((condition) =>
      actual.includes(condition),
    );
  if (!exactCanonicalSet) {
    errors.push(
      `maintenance-attention-contract.json applicationConditions must contain exactly: ${REQUIRED_ATTENTION_APPLICATION_CONDITIONS.join(", ")}`,
    );
  }
}

function validateAuthorityMatrixLinkage(
  authorityMatrix,
  findingContract,
  attentionContract,
  errors,
) {
  if (
    !isObject(authorityMatrix) ||
    !Array.isArray(authorityMatrix.authorities)
  ) {
    errors.push(
      "semantic-core-authorities.json is missing or malformed; cannot check C2 concern linkage",
    );
    return;
  }
  const byConcern = new Map(
    authorityMatrix.authorities
      .filter((entry) => isObject(entry) && isNonEmptyString(entry.concern))
      .map((entry) => [entry.concern, entry]),
  );

  const findingAuthority = byConcern.get("maintenance-finding-observation");
  if (!findingAuthority) {
    errors.push(
      "semantic-core-authorities.json is missing the maintenance-finding-observation concern required by C2-00",
    );
  } else if (findingAuthority.writePolicy !== "evaluator-publish-only") {
    errors.push(
      "maintenance-finding-observation authority writePolicy must be evaluator-publish-only",
    );
  }
  const terminalFindingAuthorities = authorityMatrix.authorities.filter(
    (entry) =>
      isObject(entry) &&
      entry.concern === "maintenance-terminal-finding-observation",
  );
  if (terminalFindingAuthorities.length !== 1) {
    errors.push(
      `semantic-core-authorities.json must contain exactly one maintenance-terminal-finding-observation concern required by C2-5B-C; found ${terminalFindingAuthorities.length}`,
    );
  }
  const [terminalFindingAuthority] = terminalFindingAuthorities;
  if (terminalFindingAuthority) {
    if (
      terminalFindingAuthority.canonicalAuthority !==
      "maintenance-run-finalization-transaction"
    ) {
      errors.push(
        "maintenance-terminal-finding-observation canonicalAuthority must be maintenance-run-finalization-transaction",
      );
    }
    if (terminalFindingAuthority.writePolicy !== "maintenance-finalization-only") {
      errors.push(
        "maintenance-terminal-finding-observation writePolicy must be maintenance-finalization-only",
      );
    }
    const canonicalTerminalRule =
      isObject(findingContract) && Array.isArray(findingContract.rules)
        ? findingContract.rules.find(
          (rule) =>
            isObject(rule) &&
            rule.ruleId === CANONICAL_TERMINAL_FINDING_RULE.ruleId &&
            rule.version === CANONICAL_TERMINAL_FINDING_RULE.version,
          )
        : null;
    if (
      canonicalTerminalRule &&
      canonicalTerminalRule.writerAuthority !==
        terminalFindingAuthority.canonicalAuthority
    ) {
      errors.push(
        "canonical terminal Finding writerAuthority must match maintenance-terminal-finding-observation canonicalAuthority",
      );
    }
  }
  if (
    isObject(findingContract) &&
    findingContract.observationStorageClass !== "rebuildable-derived-state"
  ) {
    errors.push(
      "narrative-finding-contract.json observationStorageClass must be rebuildable-derived-state so Finding Observation never becomes a second Freshness authority",
    );
  }

  const attentionAuthority = byConcern.get("maintenance-attention");
  if (!attentionAuthority) {
    errors.push(
      "semantic-core-authorities.json is missing the maintenance-attention concern required by C2-00",
    );
  } else {
    if (attentionAuthority.writePolicy !== "typed-writer-only") {
      errors.push(
        "maintenance-attention authority writePolicy must be typed-writer-only",
      );
    }
    if (
      isObject(attentionContract) &&
      attentionAuthority.canonicalAuthority !==
        attentionContract.writerAuthority
    ) {
      errors.push(
        `maintenance-attention authority canonicalAuthority (${attentionAuthority.canonicalAuthority}) disagrees with maintenance-attention-contract.json writerAuthority (${attentionContract.writerAuthority})`,
      );
    }
  }
  if (
    isObject(attentionContract) &&
    attentionContract.backflowPolicy !== "forbid"
  ) {
    errors.push(
      "maintenance-attention-contract.json backflowPolicy must be forbid",
    );
  }
}

function validateAdr005StartCondition(repoRoot, errors) {
  const absolute = path.join(repoRoot, ADR_005_PATH);
  if (!existsSync(absolute)) {
    errors.push(`ADR 005 is missing: ${ADR_005_PATH}`);
    return;
  }
  const source = readFileSync(absolute, "utf8");
  for (const label of ADR_005_C2_START_CONDITION) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}\\s+fixed\\s*$`, "m");
    if (!pattern.test(source)) {
      errors.push(
        `ADR 005 C2 start condition is missing or no longer says "fixed" for: ${label}`,
      );
    }
  }
}

function extractTsUnionMembers(source, typeName) {
  const pattern = new RegExp(`export type ${typeName} =([\\s\\S]*?);`, "m");
  const match = pattern.exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function validateRuntimeTypesAreCovered(repoRoot, executionState, errors) {
  const absolute = path.join(repoRoot, RUNTIME_TYPES_PATH);
  if (!existsSync(absolute)) {
    errors.push(`runtime status types file is missing: ${RUNTIME_TYPES_PATH}`);
    return;
  }
  const source = readFileSync(absolute, "utf8");
  for (const [entityName, typeName] of Object.entries(RUNTIME_STATUS_TYPES)) {
    const members = extractTsUnionMembers(source, typeName);
    if (!members) {
      errors.push(
        `could not find TypeScript union type ${typeName} in ${RUNTIME_TYPES_PATH}`,
      );
      continue;
    }
    const contractStatuses = new Set(
      executionState?.entities?.[entityName]?.statuses ?? [],
    );
    for (const member of members) {
      if (!contractStatuses.has(member)) {
        errors.push(
          `narrative-execution-state.json entities.${entityName}.statuses drops a status the existing ${typeName} still uses: ${member}`,
        );
      }
    }
  }
}

export function validateExecutionStateAuthority({ repoRoot = REPO_ROOT } = {}) {
  const errors = [];

  const executionState = validateAgainstSchema(
    repoRoot,
    "narrative-execution-state.schema.json",
    "narrative-execution-state.json",
    errors,
  );
  const failurePolicy = validateAgainstSchema(
    repoRoot,
    "narrative-failure-policy.schema.json",
    "narrative-failure-policy.json",
    errors,
  );
  const findingContract = validateAgainstSchema(
    repoRoot,
    "narrative-finding-contract.schema.json",
    "narrative-finding-contract.json",
    errors,
  );
  const attentionContract = validateAgainstSchema(
    repoRoot,
    "maintenance-attention-contract.schema.json",
    "maintenance-attention-contract.json",
    errors,
  );
  const authorityMatrix = readJson(
    repoRoot,
    "policies/narrative/semantic-core-authorities.json",
    errors,
    "semantic authority matrix",
  );

  validateExecutionStateEntities(executionState, errors);
  validateRunSupersedeCascade(executionState, failurePolicy, errors);
  validateFailurePolicy(failurePolicy, errors);
  validateFindingRuleRegistry(findingContract, errors);
  validateAttentionApplicationConditions(attentionContract, errors);
  validateAuthorityMatrixLinkage(
    authorityMatrix,
    findingContract,
    attentionContract,
    errors,
  );
  validateAdr005StartCondition(repoRoot, errors);
  validateRuntimeTypesAreCovered(repoRoot, executionState, errors);

  return { errors };
}

function main() {
  const result = validateExecutionStateAuthority();
  if (result.errors.length > 0) {
    console.error("Gate C2-00 execution-state authority spine is invalid:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("validate-execution-state-authority: ok");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
