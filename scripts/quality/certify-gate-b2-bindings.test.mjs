import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDigestsMatchFreeze,
  buildDecisionDocument,
  stripCredentialPlaceholders,
  validateFullCiEvidence,
  validateJourneyEvidence,
  validateChronicleProductionReport,
  validateWebAiConsentReport,
} from "./certify-gate-b2-bindings.mjs";

test("stripCredentialPlaceholders removes VAR=... assignments", () => {
  const cleaned = stripCredentialPlaceholders(
    "OPENROUTER_API_KEY=... EMBED_NODE_MODULES=... pnpm test:node --run x.ts",
  );
  assert.equal(cleaned, "pnpm test:node --run x.ts");
  assert.doesNotMatch(cleaned, /OPENROUTER_API_KEY=/);
});

test("full-ci evidence rejects bare passed:true without structured fields", () => {
  const candidate = { commitSha: "a".repeat(40), treeSha: "b".repeat(40) };
  const bare = validateFullCiEvidence({ passed: true }, candidate);
  assert.equal(bare.ok, false);
  assert.match(bare.message, /missing required fields/);

  const ok = validateFullCiEvidence(
    {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      workflowId: "ci.yml",
      runId: "123",
      runAttempt: 1,
      conclusion: "success",
      requiredJobs: ["Frontend"],
    },
    candidate,
  );
  assert.equal(ok.ok, true);
});

test("journey evidence requires candidate binding and assertions", () => {
  const candidate = { commitSha: "a".repeat(40), treeSha: "b".repeat(40) };
  const forged = validateJourneyEvidence(
    { result: "passed", passed: true },
    { journeyId: "prepared-plan-toctou", candidate },
  );
  assert.equal(forged.ok, false);

  const ok = validateJourneyEvidence(
    {
      schemaVersion: 1,
      journeyId: "prepared-plan-toctou",
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      runnerId: "manual",
      runnerVersion: "1",
      environmentDigest: `sha256:${"c".repeat(64)}`,
      assertions: [{ id: "source-changed", passed: true }],
      result: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    },
    { journeyId: "prepared-plan-toctou", candidate },
  );
  assert.equal(ok.ok, true);
});

test("chronicle report must be certificationEligible with 14/14", () => {
  const candidate = { treeSha: "b".repeat(40) };
  assert.equal(
    validateChronicleProductionReport(
      {
        attempt: 1,
        caseCount: 14,
        certificationEligible: false,
      },
      candidate,
    ).ok,
    false,
  );
  assert.equal(
    validateChronicleProductionReport(
      {
        attempt: 1,
        caseCount: 14,
        certificationEligible: true,
        candidateTreeSha: candidate.treeSha,
      },
      candidate,
    ).ok,
    true,
  );
});

test("consent report requires observed teardown flags", () => {
  assert.equal(
    validateWebAiConsentReport({
      certificationEligible: true,
      teardown: { serverClosed: false, localStorageCleared: true },
    }).ok,
    false,
  );
  assert.equal(
    validateWebAiConsentReport({
      certificationEligible: true,
      teardown: { serverClosed: true, localStorageCleared: true },
    }).ok,
    true,
  );
});

test("decision document includes suiteSummaries and digests", () => {
  const doc = buildDecisionDocument({
    candidate: {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      baseMasterSha: "c".repeat(40),
    },
    verdict: "INCOMPLETE",
    reasons: ["x"],
    suites: [
      { bucket: "requiredLight", result: "not-run", attempt: 1, suiteId: "a" },
      { bucket: "requiredHeavy", result: "blocked", attempt: 1, suiteId: "b" },
    ],
    reportDigest: `sha256:${"d".repeat(64)}`,
    digests: {
      writerRegistryDigest: `sha256:${"e".repeat(64)}`,
      aiPathRegistryDigest: `sha256:${"f".repeat(64)}`,
      qualityManifestDigest: `sha256:${"1".repeat(64)}`,
      narrativeEvalManifestDigest: `sha256:${"2".repeat(64)}`,
      adrChecklistDigest: `sha256:${"3".repeat(64)}`,
      classificationDigest: `sha256:${"4".repeat(64)}`,
    },
  });
  assert.equal(doc.suiteSummaries.requiredLight.notRun, 1);
  assert.equal(doc.suiteSummaries.requiredHeavy.blocked, 1);
  assert.match(doc.digests.reportDigest, /^sha256:/);
});

test("assertDigestsMatchFreeze detects drift", () => {
  const errors = assertDigestsMatchFreeze(
    { writerRegistryDigest: "sha256:" + "a".repeat(64) },
    { writerRegistryDigest: "sha256:" + "b".repeat(64) },
  );
  assert.equal(errors.length, 1);
});
