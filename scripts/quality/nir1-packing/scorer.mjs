function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function countExpectedIds(selectedIds, expectedIds) {
  const selected = new Set(selectedIds);
  return expectedIds.reduce((count, id) => count + (selected.has(id) ? 1 : 0), 0);
}

function expectedSelectedText(testCase, selectedIds) {
  const byId = new Map(testCase.input.map((item) => [item.id, item.text]));
  return selectedIds.map((id) => byId.get(id));
}

function validateMaterializedItems(arm, testCase, failures, label) {
  if (!Array.isArray(arm.selectedItems)) return;
  const selectedItemIds = arm.selectedItems.map((item) => item?.id);
  if (!sameArray(selectedItemIds, arm.selectedIds)) {
    failures.push(`${label}.selectedItems must preserve selectedIds exactly`);
  }
  const byId = new Map(testCase.input.map((item) => [item.id, item]));
  for (const [index, item] of arm.selectedItems.entries()) {
    const expected = byId.get(item?.id);
    if (!expected) {
      failures.push(`${label}.selectedItems[${index}] is not a fixture item`);
      continue;
    }
    for (const key of ["kind", "text", "tokens", "atomicGroup", "atomicPart", "stability"]) {
      const actualValue = item[key] ?? null;
      const expectedValue = expected[key] ?? null;
      if (actualValue !== expectedValue) {
        failures.push(`${label}.selectedItems[${index}].${key} changed fixture material`);
      }
    }
  }
}

function proofKey(item) {
  return item?.qualificationProof?.reader
    ? JSON.stringify({
        provenance: item.qualificationProof.provenance,
        reader: item.qualificationProof.reader,
      })
    : null;
}

const READER_STRING_FIELDS = [
  "revisionId",
  "materialBasisDigest",
  "sourceKey",
  "sourceRevisionToken",
  "dependencyId",
  "evidenceRef",
  "evidenceQuoteDigest",
  "decisionId",
];

const READER_FRESHNESS_FIELDS = [
  "semanticEpochId",
  "dependencySetDigest",
  "declarationSetId",
  "declarationSetDigest",
];

function isFixtureReaderOutput(reader, expectedReader) {
  return (
    reader &&
    typeof reader === "object" &&
    reader.source === "fixture-only-a2-current-reader" &&
    reader.status === "current" &&
    reader.decision === "approved" &&
    READER_STRING_FIELDS.every(
      (key) => typeof reader[key] === "string" && reader[key].trim().length > 0,
    ) &&
    reader.freshness &&
    typeof reader.freshness === "object" &&
    READER_FRESHNESS_FIELDS.every(
      (key) =>
        typeof reader.freshness[key] === "string" &&
        reader.freshness[key].trim().length > 0,
    ) &&
    (!expectedReader || JSON.stringify(reader) === JSON.stringify(expectedReader))
  );
}

/** Derive the predeclared slot from materialized arm output, never a counter. */
export function deriveQualifiedEvidenceCount(output, expectedGroupIds = [], expectedReader) {
  if (!output || !Array.isArray(output.selectedItems)) return null;
  const allowed = new Set(expectedGroupIds);
  const groups = new Map();
  for (const item of output.selectedItems) {
    if (!allowed.has(item.atomicGroup)) continue;
    const group = groups.get(item.atomicGroup) ?? [];
    group.push(item);
    groups.set(item.atomicGroup, group);
  }
  let count = 0;
  for (const groupId of expectedGroupIds) {
    const group = groups.get(groupId) ?? [];
    const parts = new Set(group.map((item) => item.atomicPart));
    const kinds = new Set(group.map((item) => item.kind));
    const proofKeys = new Set(group.map(proofKey));
    const valid =
      group.length === 5 &&
      parts.size === 5 &&
      kinds.size === 1 &&
      ["statement", "negation", "attribution", "evidence", "qualification"].every((part) =>
        parts.has(part),
      ) &&
      group.every(
        (item) =>
          item.kind === "accepted-ir" || item.kind === "graph-evidence",
      ) &&
      group.every(
        (item) =>
          item?.qualificationProof?.provenance === "fixture-only" &&
          isFixtureReaderOutput(item.qualificationProof.reader, expectedReader),
      ) &&
      proofKeys.size === 1 &&
      !proofKeys.has(null) &&
      group[0]?.qualificationProof?.reader?.source === "fixture-only-a2-current-reader" &&
      group[0]?.qualificationProof?.reader?.status === "current" &&
      group[0]?.qualificationProof?.reader?.decision === "approved";
    if (valid) count += 1;
  }
  return count;
}

function validateArmCounters(arm, testCase, budget, failures, label) {
  if (!arm || typeof arm !== "object") {
    failures.push(`${label} arm output is required`);
    return;
  }
  if (arm.liveModelCalls !== undefined && arm.liveModelCalls !== 0) {
    failures.push(`${label} live model calls are prohibited`);
  }
  if (!Array.isArray(arm.selectedIds)) {
    failures.push(`${label}.selectedIds must be an array`);
    return;
  }
  if (new Set(arm.selectedIds).size !== arm.selectedIds.length) {
    failures.push(`${label}.selectedIds must not contain duplicates`);
  }
  if (arm.usedTokens !== arm.exactUsedTokens) {
    failures.push(`${label} exact token counter is required`);
  }
  if (!Number.isInteger(arm.usedTokens) || arm.usedTokens < 0) {
    failures.push(`${label}.usedTokens must be a non-negative integer`);
  }
  const expectedBudget =
    budget.contextWindowTokens -
    budget.systemTokens -
    budget.historyTokens -
    budget.toolTokens -
    budget.responseReservationTokens;
  if (arm.usedTokens > expectedBudget) {
    failures.push(`${label}.usedTokens exceeds the frozen context budget`);
  }
  if (arm.contextBudgetTokens !== arm.exactContextBudgetTokens) {
    failures.push(`${label} exact context budget counter is required`);
  }
  if (arm.contextBudgetTokens !== expectedBudget) {
    failures.push(`${label}.contextBudgetTokens does not match the frozen total budget`);
  }
  if (Array.isArray(arm.selectedText)) {
    const expectedText = expectedSelectedText(testCase, arm.selectedIds);
    if (!sameArray(arm.selectedText, expectedText)) {
      failures.push(`${label}.selectedText does not match exact fixture text`);
    }
  } else {
    failures.push(`${label}.selectedText is required for exact quote scoring`);
  }
  if (Array.isArray(arm.proseText)) {
    if (!sameArray(arm.proseText, arm.selectedText)) {
      failures.push(`${label}.proseText changed selected text order`);
    }
  } else {
    failures.push(`${label}.proseText is required for exact quote scoring`);
  }
  validateMaterializedItems(arm, testCase, failures, label);
}

export function scoreNir1PackingCase(
  testCase,
  result,
  budget,
  qualificationOutputs = undefined,
) {
  const failures = [];
  const expected = testCase.expected;
  if (!result || typeof result !== "object") {
    return { status: "failed", failures: ["result must be an object"] };
  }
  if (result.liveModelCalls !== undefined && result.liveModelCalls !== 0) {
    failures.push("live model calls are prohibited");
  }

  const candidate = result.candidate ?? result;
  validateArmCounters(candidate, testCase, budget, failures, "candidate");
  if (!sameArray(candidate.selectedIds, expected.selectedIds)) {
    failures.push("selectedIds do not match the deterministic expected order");
  }
  for (const id of expected.requiredIds) {
    if (!candidate.selectedIds?.includes(id)) failures.push(`required id ${id} is missing`);
  }
  for (const id of expected.prohibitedIds) {
    if (candidate.selectedIds?.includes(id)) failures.push(`prohibited id ${id} was selected`);
  }
  if (!sameArray(candidate.proseOrder, expected.proseOrder)) {
    failures.push("prose order changed");
  }
  if (Array.isArray(expected.rejectedGroups) && !sameArray(candidate.rejectedGroups, expected.rejectedGroups)) {
    failures.push("rejected atomic groups changed");
  }
  const expectedUsedTokens = testCase.input
    .filter((item) => expected.selectedIds.includes(item.id))
    .reduce((total, item) => total + item.tokens, 0);
  if (candidate.usedTokens !== expectedUsedTokens) {
    failures.push("usedTokens does not match the exact fixture token sum");
  }

  const improvement = expected.improvement;
  let improvementStatus = "not-declared";
  if (improvement) {
    if (improvement.provenance !== "fixture-only") {
      failures.push("P-12 qualification provenance must remain fixture-only");
    }
    const baseline = result.baseline;
    if (!baseline || !result.candidate) {
      improvementStatus = "blocked";
      failures.push("P-12 requires measured baseline and candidate arm outputs");
    } else {
      validateArmCounters(baseline, testCase, budget, failures, "baseline");
      const baselineExpected = expected.baseline ?? {
        selectedIds: expected.selectedIds,
        proseOrder: expected.proseOrder,
      };
      if (!sameArray(baseline.selectedIds, baselineExpected.selectedIds)) {
        failures.push("baseline selectedIds do not match the frozen fixture order");
      }
      if (!sameArray(baseline.proseOrder, baselineExpected.proseOrder)) {
        failures.push("baseline prose order changed");
      }
      if (
        baselineExpected.usedTokens !== undefined &&
        baseline.usedTokens !== baselineExpected.usedTokens
      ) {
        failures.push("baseline usedTokens does not match the frozen fixture measurement");
      }
      if (
        JSON.stringify({
          selectedIds: baseline.selectedIds,
          selectedText: baseline.selectedText,
          selectedItems: baseline.selectedItems,
        }) ===
        JSON.stringify({
          selectedIds: result.candidate.selectedIds,
          selectedText: result.candidate.selectedText,
          selectedItems: result.candidate.selectedItems,
        })
      ) {
        failures.push("P-12 identical arms cannot pass");
      }
      const baselineCount = deriveQualifiedEvidenceCount(
        baseline,
        improvement.groupIds ?? [],
        qualificationOutputs?.current ?? undefined,
      );
      const candidateCount = deriveQualifiedEvidenceCount(
        result.candidate,
        improvement.groupIds ?? [],
        qualificationOutputs?.current ?? undefined,
      );
      if (baselineCount === null || candidateCount === null) {
        improvementStatus = "blocked";
        failures.push("P-12 slot must be derived from exact arm outputs");
      } else if (
        baselineCount !== improvement.baseline ||
        candidateCount !== improvement.candidate
      ) {
        improvementStatus = "failed";
        failures.push("P-12 measured slot counters do not match the fixture declaration");
      } else if (candidateCount <= baselineCount) {
        improvementStatus = "failed";
        failures.push("P-12 identical or non-improving arms cannot pass");
      } else {
        improvementStatus = "passed";
      }
      if (result.improvementCounters !== undefined) {
        const supplied = result.improvementCounters;
        if (
          supplied?.baseline !== baselineCount ||
          supplied?.candidate !== candidateCount
        ) {
          failures.push("forged P-12 counters do not match measured arm outputs");
        }
      }
    }
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    requiredCount: countExpectedIds(candidate.selectedIds ?? [], expected.requiredIds),
    prohibitedCount: expected.prohibitedIds.filter((id) => candidate.selectedIds?.includes(id)).length,
    improvementStatus,
  };
}

export function scoreNir1PackingSuite(manifest, results) {
  const byCaseId = new Map(results.map((result) => [result.caseId, result]));
  const cases = manifest.cases.map((testCase) => {
    const scored = scoreNir1PackingCase(
      testCase,
      byCaseId.get(testCase.caseId)?.result,
      manifest.execution.budget,
      manifest.execution.qualificationOutputs,
    );
    return { caseId: testCase.caseId, ...scored };
  });
  const failures = cases.flatMap((scored) =>
    scored.failures.map((failure) => `${scored.caseId}: ${failure}`),
  );
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    cases,
  };
}
