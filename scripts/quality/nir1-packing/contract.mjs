const REQUIRED_CASE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `P-${String(index + 1).padStart(2, "0")}`),
);

const REQUIRED_ATOMIC_PARTS = Object.freeze([
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
]);

const PACKING_KINDS = Object.freeze([
  "raw",
  "accepted-ir",
  "graph-evidence",
  "author-declared",
  "unreviewed-for-review",
]);

const READER_STRING_FIELDS = Object.freeze([
  "revisionId",
  "materialBasisDigest",
  "sourceKey",
  "sourceRevisionToken",
  "dependencyId",
  "evidenceRef",
  "evidenceQuoteDigest",
  "decisionId",
]);

const READER_FRESHNESS_FIELDS = Object.freeze([
  "semanticEpochId",
  "dependencySetDigest",
  "declarationSetId",
  "declarationSetDigest",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function assertStringOrEmpty(value, label, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
  }
}

function validateQualificationOutputs(outputs, errors) {
  if (!isRecord(outputs)) return;
  for (const [outputId, output] of Object.entries(outputs)) {
    const label = `execution.qualificationOutputs.${outputId}`;
    if (!isRecord(output)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const key of ["source", "status", "decision"]) {
      assertString(output[key], `${label}.${key}`, errors);
    }
    if (output.source !== "fixture-only-a2-current-reader") {
      errors.push(`${label}.source must identify the fixture-only A2 reader`);
    }
    if (!["current", "stale"].includes(output.status)) {
      errors.push(`${label}.status must be current or stale`);
    }
    if (!["approved", "rejected"].includes(output.decision)) {
      errors.push(`${label}.decision must be approved or rejected`);
    }
    for (const key of READER_STRING_FIELDS) {
      if (!Object.hasOwn(output, key)) {
        errors.push(`${label}.${key} is required`);
      } else {
        assertStringOrEmpty(output[key], `${label}.${key}`, errors);
      }
    }
    if (!isRecord(output.freshness)) {
      errors.push(`${label}.freshness must be an object`);
      continue;
    }
    for (const key of READER_FRESHNESS_FIELDS) {
      if (!Object.hasOwn(output.freshness, key)) {
        errors.push(`${label}.freshness.${key} is required`);
      } else {
        assertStringOrEmpty(output.freshness[key], `${label}.freshness.${key}`, errors);
      }
    }
  }
}

function assertNonNegativeInteger(value, label, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value, label, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer`);
  }
}

function validateBudget(budget, errors) {
  if (!isRecord(budget)) {
    errors.push("execution.budget must be an object");
    return;
  }

  for (const key of [
    "contextWindowTokens",
    "systemTokens",
    "historyTokens",
    "toolTokens",
    "responseReservationTokens",
  ]) {
    assertNonNegativeInteger(budget[key], `execution.budget.${key}`, errors);
  }

  if (
    Number.isInteger(budget.contextWindowTokens) &&
    Number.isInteger(budget.systemTokens) &&
    Number.isInteger(budget.historyTokens) &&
    Number.isInteger(budget.toolTokens) &&
    Number.isInteger(budget.responseReservationTokens) &&
    budget.contextWindowTokens <=
      budget.systemTokens +
        budget.historyTokens +
        budget.toolTokens +
        budget.responseReservationTokens
  ) {
    errors.push("execution.budget must leave a positive context budget");
  }
}

function validateInputItems(items, label, errors, qualificationOutputs) {
  if (!Array.isArray(items) || items.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }

  const ids = new Set();
  for (const [index, item] of items.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemLabel} must be an object`);
      continue;
    }

    assertString(item.id, `${itemLabel}.id`, errors);
    assertString(item.text, `${itemLabel}.text`, errors);
    assertPositiveInteger(item.tokens, `${itemLabel}.tokens`, errors);
    if (ids.has(item.id)) {
      errors.push(`${label} has duplicate id ${item.id}`);
    }
    ids.add(item.id);

    if (!PACKING_KINDS.includes(item.kind)) {
      errors.push(`${itemLabel}.kind is not a supported packing kind`);
    }
    if (item.kind === "raw") {
      if (
        item.atomicGroup !== undefined ||
        item.atomicPart !== undefined ||
        item.qualificationRef !== undefined
      ) {
        errors.push(`${itemLabel} raw item must not carry an atomic group`);
      }
      continue;
    }

    if (item.qualificationRef !== undefined) {
      assertString(item.qualificationRef, `${itemLabel}.qualificationRef`, errors);
      if (!qualificationOutputs || !Object.hasOwn(qualificationOutputs, item.qualificationRef)) {
        errors.push(`${itemLabel}.qualificationRef is not a declared fixture-only output`);
      }
      if (item.kind !== "accepted-ir" && item.kind !== "graph-evidence") {
        errors.push(`${itemLabel}.qualificationRef is only valid for qualified IR/Graph items`);
      }
    }

    assertString(item.atomicGroup, `${itemLabel}.atomicGroup`, errors);
    if (!REQUIRED_ATOMIC_PARTS.includes(item.atomicPart)) {
      errors.push(`${itemLabel}.atomicPart is incomplete or unknown`);
    }
  }

  const groups = new Map();
  for (const item of items) {
    if (!item || item.kind === "raw" || typeof item.atomicGroup !== "string") {
      continue;
    }
    const parts = groups.get(item.atomicGroup) ?? new Set();
    parts.add(item.atomicPart);
    groups.set(item.atomicGroup, parts);
  }
  for (const [group, parts] of groups.entries()) {
    for (const part of REQUIRED_ATOMIC_PARTS) {
      if (!parts.has(part)) {
        errors.push(`${label} atomic group ${group} is missing ${part}`);
      }
    }
  }
}

export function validateNir1PackingFixtures(manifest) {
  const errors = [];
  if (!isRecord(manifest)) {
    return ["manifest must be an object"];
  }
  if (manifest.version !== 1) {
    errors.push("manifest.version must be 1");
  }
  assertString(manifest.suiteId, "suiteId", errors);
  if (!isRecord(manifest.execution)) {
    errors.push("execution must be an object");
  } else {
    assertString(manifest.execution.seed, "execution.seed", errors);
    if (manifest.execution.liveModelCalls !== 0) {
      errors.push("execution.liveModelCalls must be 0 for D1");
    }
    assertString(
      manifest.execution.qualificationProvenance,
      "execution.qualificationProvenance",
      errors,
    );
    if (manifest.execution.qualificationProvenance !== "fixture-only-a2-current-reader") {
      errors.push("execution.qualificationProvenance must identify fixture-only A2 output");
    }
    if (!isRecord(manifest.execution.qualificationOutputs)) {
      errors.push("execution.qualificationOutputs must declare fixture-only reader outputs");
    } else {
      validateQualificationOutputs(manifest.execution.qualificationOutputs, errors);
    }
    validateBudget(manifest.execution.budget, errors);
    const improvement = manifest.execution.predeclaredImprovement;
    if (!isRecord(improvement)) {
      errors.push("execution.predeclaredImprovement must be declared before candidate evaluation");
    } else {
      assertString(improvement.slot, "execution.predeclaredImprovement.slot", errors);
      assertNonNegativeInteger(improvement.baseline, "execution.predeclaredImprovement.baseline", errors);
      assertNonNegativeInteger(
        improvement.candidateTarget,
        "execution.predeclaredImprovement.candidateTarget",
        errors,
      );
      if (improvement.slot !== "qualifiedEvidence") {
        errors.push("execution.predeclaredImprovement.slot must be qualifiedEvidence");
      }
      if (improvement.baseline !== 0 || improvement.candidateTarget !== 1) {
        errors.push("execution.predeclaredImprovement must declare the fixed 0-to-1 D1 target");
      }
    }
  }

  if (!Array.isArray(manifest.cases) || manifest.cases.length !== REQUIRED_CASE_IDS.length) {
    errors.push(`cases must contain exactly ${REQUIRED_CASE_IDS.length} isolated cases`);
    return errors;
  }

  const seenCaseIds = new Set();
  const seenNamespaces = new Set();
  const seenWorkspaces = new Set();
  const seenConversations = new Set();
  for (const [index, testCase] of manifest.cases.entries()) {
    const label = `cases[${index}]`;
    if (!isRecord(testCase)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    assertString(testCase.caseId, `${label}.caseId`, errors);
    assertString(testCase.workspaceId, `${label}.workspaceId`, errors);
    assertString(testCase.conversationId, `${label}.conversationId`, errors);
    assertString(testCase.artifactNamespace, `${label}.artifactNamespace`, errors);
    assertString(testCase.qualificationRef, `${label}.qualificationRef`, errors);
    if (
      isRecord(manifest.execution?.qualificationOutputs) &&
      !Object.hasOwn(manifest.execution.qualificationOutputs, testCase.qualificationRef)
    ) {
      errors.push(`${label}.qualificationRef is not a declared fixture-only output`);
    }
    if (seenCaseIds.has(testCase.caseId)) errors.push(`duplicate caseId ${testCase.caseId}`);
    if (seenNamespaces.has(testCase.artifactNamespace)) errors.push(`duplicate artifactNamespace ${testCase.artifactNamespace}`);
    if (seenWorkspaces.has(testCase.workspaceId)) errors.push(`duplicate workspaceId ${testCase.workspaceId}`);
    if (seenConversations.has(testCase.conversationId)) errors.push(`duplicate conversationId ${testCase.conversationId}`);
    seenCaseIds.add(testCase.caseId);
    seenNamespaces.add(testCase.artifactNamespace);
    seenWorkspaces.add(testCase.workspaceId);
    seenConversations.add(testCase.conversationId);

    const expected = isRecord(testCase.expected) ? testCase.expected : undefined;
    validateInputItems(
      testCase.input,
      `${label}.input`,
      errors,
      manifest.execution?.qualificationOutputs,
    );
    if (!isRecord(testCase.expected)) {
      errors.push(`${label}.expected must be an object`);
    } else {
      for (const key of ["requiredIds", "selectedIds", "prohibitedIds", "proseOrder"]) {
        if (!Array.isArray(testCase.expected[key])) errors.push(`${label}.expected.${key} must be an array`);
      }
      if (testCase.expected.rejectedGroups !== undefined && !Array.isArray(testCase.expected.rejectedGroups)) {
        errors.push(`${label}.expected.rejectedGroups must be an array when present`);
      }
      if (isRecord(testCase.expected.baseline)) {
        for (const key of ["selectedIds", "proseOrder"]) {
          if (!Array.isArray(testCase.expected.baseline[key])) {
            errors.push(`${label}.expected.baseline.${key} must be an array`);
          }
        }
        if (testCase.expected.baseline.usedTokens !== undefined) {
          assertNonNegativeInteger(
            testCase.expected.baseline.usedTokens,
            `${label}.expected.baseline.usedTokens`,
            errors,
          );
        }
      }
      if (isRecord(testCase.expected.improvement)) {
        const improvement = testCase.expected.improvement;
        assertString(improvement.slot, `${label}.expected.improvement.slot`, errors);
        if (improvement.slot !== "qualifiedEvidence") {
          errors.push(`${label}.expected.improvement.slot must be qualifiedEvidence`);
        }
        if (!Array.isArray(improvement.groupIds) || improvement.groupIds.length === 0) {
          errors.push(`${label}.expected.improvement.groupIds must be a non-empty array`);
        }
        assertString(
          improvement.provenance,
          `${label}.expected.improvement.provenance`,
          errors,
        );
        if (improvement.provenance !== "fixture-only") {
          errors.push(`${label}.expected.improvement.provenance must be fixture-only`);
        }
        assertNonNegativeInteger(
          improvement.baseline,
          `${label}.expected.improvement.baseline`,
          errors,
        );
        assertNonNegativeInteger(
          improvement.candidate,
          `${label}.expected.improvement.candidate`,
          errors,
        );
      }
    }
    if (testCase.cacheBinding !== undefined && !isRecord(testCase.cacheBinding)) {
      errors.push(`${label}.cacheBinding must be an object when present`);
    }
  }

  const actualIds = manifest.cases.map((testCase) => testCase.caseId);
  if (actualIds.some((caseId, index) => caseId !== REQUIRED_CASE_IDS[index])) {
    errors.push(`cases must be ordered exactly as ${REQUIRED_CASE_IDS.join(", ")}`);
  }
  return errors;
}

export { PACKING_KINDS, REQUIRED_ATOMIC_PARTS, REQUIRED_CASE_IDS };
