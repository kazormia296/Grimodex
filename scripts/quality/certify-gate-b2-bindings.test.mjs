import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GATE_B2_CONTRACT_VERSION,
  HARNESS_DIGEST_PATHS,
  assertDigestsMatchFreeze,
  assertFreezeActive,
  allocateGateB2Attempt,
  buildDecisionDocument,
  buildGhRunDownloadArgs,
  buildHeavyCertificationEnv,
  checkoutIdentityArtifactName,
  fetchCheckoutIdentityArtifact,
  listRunArtifacts,
  prepareWorktreeDependencies,
  sanitizeCertificationEnv,
  stripCredentialPlaceholders,
  validateFullCiEvidence,
  validateJourneyEvidence,
  validateChronicleProductionReport,
  validateWebAiConsentReport,
  verifyFullCiWithGithub,
} from "./certify-gate-b2-bindings.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const candidate = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};

const fullCiContract = {
  workflowId: 12345678,
  workflowPath: ".github/workflows/ci.yml",
  acceptedEvents: ["push", "pull_request"],
  requiredJobs: ["Frontend", "Rust"],
};

const fullCiContractWithCheckout = {
  ...fullCiContract,
  requireCheckoutIdentityArtifact: true,
};

function makeCheckoutIdentity(overrides = {}) {
  return {
    artifactId: 12345,
    artifactName: "checkout-identity-999-1",
    artifactDigest: `sha256:${"e".repeat(64)}`,
    identity: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ...overrides,
    },
  };
}

function fullCiEvidence(overrides = {}) {
  return {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    workflowId: String(fullCiContract.workflowId),
    runId: "999",
    runAttempt: 1,
    conclusion: "success",
    requiredJobs: [...fullCiContract.requiredJobs],
    ...overrides,
  };
}

function githubRunPayload(overrides = {}) {
  return {
    run: {
      head_sha: candidate.commitSha,
      run_attempt: 1,
      conclusion: "success",
      workflow_id: fullCiContract.workflowId,
      path: fullCiContract.workflowPath,
      event: "push",
      ...overrides.run,
    },
    jobs: overrides.jobs ?? [
      { name: "Frontend", conclusion: "success" },
      { name: "Rust", conclusion: "success" },
    ],
  };
}

const heavyExpected = {
  commitSha: candidate.commitSha,
  treeSha: candidate.treeSha,
  suiteId: "heavy-narrative-chronicle-production",
  runId: "run-1",
  commandDigest: `sha256:${"d".repeat(64)}`,
};

function validHeavyReport(overrides = {}) {
  return {
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    suiteId: heavyExpected.suiteId,
    runId: heavyExpected.runId,
    commandDigest: heavyExpected.commandDigest,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
    attempt: 1,
    caseCount: 14,
    certificationEligible: true,
    ...overrides,
  };
}

test("stripCredentialPlaceholders removes VAR=... assignments", () => {
  const cleaned = stripCredentialPlaceholders(
    "OPENROUTER_API_KEY=... EMBED_NODE_MODULES=... pnpm test:node --run x.ts",
  );
  assert.equal(cleaned, "pnpm test:node --run x.ts");
  assert.doesNotMatch(cleaned, /OPENROUTER_API_KEY=/);
});

test("sanitizeCertificationEnv strips narrative overrides but keeps GATE_B2 vars", () => {
  const env = sanitizeCertificationEnv({
    NARRATIVE_EVAL_LIMIT: "1",
    NARRATIVE_EVAL_CASE_ID: "x",
    NARRATIVE_EVAL_ATTEMPT: "2",
    GATE_B2_RUN_ID: "run-1",
    GATE_B2_OUTPUT_PATH: "/tmp/report.json",
  });
  assert.equal(env.NARRATIVE_EVAL_LIMIT, undefined);
  assert.equal(env.NARRATIVE_EVAL_CASE_ID, undefined);
  assert.equal(env.NARRATIVE_EVAL_ATTEMPT, undefined);
  assert.equal(env.GATE_B2_RUN_ID, "run-1");
  assert.equal(env.GATE_B2_OUTPUT_PATH, "/tmp/report.json");
});

test("buildHeavyCertificationEnv binds heavy runner metadata", () => {
  const env = buildHeavyCertificationEnv({
    candidate,
    suiteId: "heavy-web-ai-consent-live",
    runId: "run-42",
    outputPath: "/tmp/consent-report.json",
    commandDigest: heavyExpected.commandDigest,
    freezeId: "freeze-42",
    certificationRunId: "certification-42",
    attempt: 2,
    attemptDir: "/tmp/gate-b2/attempt-2",
    baseEnv: { HOME: "/home/tester" },
  });
  assert.equal(env.GATE_B2_CANDIDATE_COMMIT_SHA, candidate.commitSha);
  assert.equal(env.GATE_B2_CANDIDATE_TREE_SHA, candidate.treeSha);
  assert.equal(env.GATE_B2_SUITE_ID, "heavy-web-ai-consent-live");
  assert.equal(env.GATE_B2_RUN_ID, "run-42");
  assert.equal(env.GATE_B2_OUTPUT_PATH, "/tmp/consent-report.json");
  assert.equal(env.GATE_B2_COMMAND_DIGEST, heavyExpected.commandDigest);
  assert.equal(env.GATE_B2_FREEZE_ID, "freeze-42");
  assert.equal(env.GATE_B2_CERTIFICATION_RUN_ID, "certification-42");
  assert.equal(env.GATE_B2_ATTEMPT, "2");
  assert.equal(env.GATE_B2_ATTEMPT_DIR, "/tmp/gate-b2/attempt-2");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.NARRATIVE_EVAL_LIMIT, undefined);
});

test("Gate B2 attempt ledger allocates append-only attempts per candidate suite", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-attempts-"));
  try {
    const first = await allocateGateB2Attempt({
      artifactDir: temp,
      suiteId: "heavy-narrative-chronicle-production",
    });
    const second = await allocateGateB2Attempt({
      artifactDir: temp,
      suiteId: "heavy-narrative-chronicle-production",
    });

    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    assert.notEqual(first.attemptDir, second.attemptDir);
    assert.match(first.attemptDir, /attempts\/heavy-narrative-chronicle-production\/attempt-1$/);
    assert.match(second.attemptDir, /attempts\/heavy-narrative-chronicle-production\/attempt-2$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("full-ci evidence rejects bare passed:true without structured fields", () => {
  const bare = validateFullCiEvidence({ passed: true }, candidate);
  assert.equal(bare.ok, false);
  assert.match(bare.message, /missing required fields/);

  const ok = validateFullCiEvidence(fullCiEvidence(), candidate);
  assert.equal(ok.ok, true);
});

test("validateFullCiEvidence rejects requiredJobs that shrink contract set", () => {
  const shrunk = validateFullCiEvidence(
    fullCiEvidence({ requiredJobs: ["Frontend"] }),
    candidate,
    fullCiContract,
  );
  assert.equal(shrunk.ok, false);
  assert.match(shrunk.message, /requiredJobs must match contract/);

  const ok = validateFullCiEvidence(
    fullCiEvidence(),
    candidate,
    fullCiContract,
  );
  assert.equal(ok.ok, true);
});

test("validateFullCiEvidence does not require checkout fields when artifact verification is enabled", () => {
  const withoutCheckout = validateFullCiEvidence(
    fullCiEvidence(),
    candidate,
    fullCiContractWithCheckout,
  );
  assert.equal(withoutCheckout.ok, true);

  const withCheckout = validateFullCiEvidence(
    fullCiEvidence({
      checkoutCommitSha: candidate.commitSha,
      checkoutTreeSha: candidate.treeSha,
    }),
    candidate,
    fullCiContractWithCheckout,
  );
  assert.equal(withCheckout.ok, true);
});

test("verifyFullCiWithGithub accepts injected github payload with contract", async () => {
  const raw = fullCiEvidence();
  const fetchRun = async () => githubRunPayload();
  const ok = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun,
    fullCiContract,
  });
  assert.equal(ok.ok, true);

  const badJobs = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () =>
      githubRunPayload({
        jobs: [{ name: "Frontend", conclusion: "success" }],
      }),
    fullCiContract,
  });
  assert.equal(badJobs.ok, false);
  assert.match(badJobs.message, /missing required job Rust/);
});

test("verifyFullCiWithGithub rejects workflow, path, and event mismatches", async () => {
  const raw = fullCiEvidence();
  const fetchRun = async () => githubRunPayload();

  const badWorkflow = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () => githubRunPayload({ run: { workflow_id: 99999999 } }),
    fullCiContract,
  });
  assert.equal(badWorkflow.ok, false);
  assert.match(badWorkflow.message, /workflow_id/);

  const badPath = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () =>
      githubRunPayload({ run: { path: ".github/workflows/release.yml" } }),
    fullCiContract,
  });
  assert.equal(badPath.ok, false);
  assert.match(badPath.message, /workflow path/);

  const badEvent = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () =>
      githubRunPayload({ run: { event: "workflow_dispatch" } }),
    fullCiContract,
  });
  assert.equal(badEvent.ok, false);
  assert.match(badEvent.message, /acceptedEvents/);
});

test("verifyFullCiWithGithub rejects evidence that shrinks contract requiredJobs", async () => {
  const raw = fullCiEvidence({ requiredJobs: ["Frontend"] });
  const result = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () => githubRunPayload(),
    fullCiContract,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /requiredJobs must match contract/);
});

test("verifyFullCiWithGithub fails when fetchRun throws", async () => {
  const raw = fullCiEvidence({ requiredJobs: ["Frontend"] });
  const failed = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () => {
      throw new Error("gh unavailable");
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /gh unavailable/);
});

test("verifyFullCiWithGithub rejects checkout identity mismatch from artifact", async () => {
  const raw = fullCiEvidence();
  const fetchRun = async () => githubRunPayload();
  const fetchCheckoutIdentity = async () =>
    makeCheckoutIdentity({ treeSha: "c".repeat(40) });

  const badTree = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun,
    fetchCheckoutIdentity,
    fullCiContract: fullCiContractWithCheckout,
  });
  assert.equal(badTree.ok, false);
  assert.match(badTree.message, /checkout-identity treeSha/);

  const ok = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun,
    fetchCheckoutIdentity: async () => makeCheckoutIdentity(),
    fullCiContract: fullCiContractWithCheckout,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.checkoutArtifactId, 12345);
  assert.equal(ok.checkoutArtifactDigest, `sha256:${"e".repeat(64)}`);
  assert.equal(ok.checkoutCommitSha, candidate.commitSha);
  assert.equal(ok.checkoutTreeSha, candidate.treeSha);
});

test("verifyFullCiWithGithub rejects evidence checkout fields that disagree with artifact", async () => {
  const raw = fullCiEvidence({
    checkoutCommitSha: "f".repeat(40),
    checkoutTreeSha: candidate.treeSha,
  });
  const result = await verifyFullCiWithGithub(raw, candidate, {
    fetchRun: async () => githubRunPayload(),
    fetchCheckoutIdentity: async () => makeCheckoutIdentity(),
    fullCiContract: fullCiContractWithCheckout,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /evidence checkoutCommitSha/);
});

test("gh run download args use supported flags only and pin run/artifact name", () => {
  const args = buildGhRunDownloadArgs({
    runId: "999",
    slug: "owner/repo",
    artifactName: checkoutIdentityArtifactName("999", 1),
    dir: "/tmp/out",
  });
  assert.deepEqual(args.slice(0, 3), ["run", "download", "999"]);
  assert.equal(args.includes("--output"), false);
  assert.equal(args.includes("api"), false);
  assert.ok(args.includes("--repo"));
  assert.ok(args.includes("owner/repo"));
  assert.ok(args.includes("--name"));
  assert.ok(args.includes("checkout-identity-999-1"));
  assert.ok(args.includes("--dir"));
  assert.ok(args.includes("/tmp/out"));
});

test("fetchCheckoutIdentityArtifact downloads via gh run download and validates identity", async () => {
  const calls = [];
  const identity = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
  };
  const result = await fetchCheckoutIdentityArtifact({
    repoRoot,
    runId: "999",
    runAttempt: 1,
    slug: "owner/repo",
    runGh: async (command, args, _cwd) => {
      calls.push({ command, args: [...args] });
      assert.equal(command, "gh");
      assert.equal(args.includes("--output"), false);
      if (args[0] === "api" && String(args[1]).includes("/artifacts")) {
        return JSON.stringify({
          artifacts: [
            {
              id: 42,
              name: "checkout-identity-999-1",
            },
          ],
        });
      }
      if (args[0] === "run" && args[1] === "download") {
        const dirIndex = args.indexOf("--dir");
        const dir = args[dirIndex + 1];
        await writeFile(
          path.join(dir, "checkout-identity.json"),
          `${JSON.stringify(identity)}\n`,
          "utf8",
        );
        return "";
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    },
  });
  assert.equal(result.artifactId, 42);
  assert.equal(result.identity.commitSha, candidate.commitSha);
  assert.equal(result.identity.treeSha, candidate.treeSha);
  assert.match(result.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(
    calls.some(
      (entry) =>
        entry.args[0] === "run" &&
        entry.args[1] === "download" &&
        entry.args.includes("checkout-identity-999-1"),
    ),
  );
});

test("fetchCheckoutIdentityArtifact fails on missing, duplicate, or mismatched identity", async () => {
  await assert.rejects(
    () =>
      fetchCheckoutIdentityArtifact({
        repoRoot,
        runId: "1",
        runAttempt: 1,
        slug: "owner/repo",
        runGh: async () => JSON.stringify({ artifacts: [] }),
      }),
    /no checkout-identity artifact/,
  );

  await assert.rejects(
    () =>
      fetchCheckoutIdentityArtifact({
        repoRoot,
        runId: "1",
        runAttempt: 1,
        slug: "owner/repo",
        runGh: async () =>
          JSON.stringify({
            artifacts: [
              { id: 1, name: "checkout-identity-1-1" },
              { id: 2, name: "checkout-identity-1-1" },
            ],
          }),
      }),
    /exactly one checkout-identity artifact/,
  );

  const badTree = await verifyFullCiWithGithub(fullCiEvidence(), candidate, {
    fetchRun: async () => githubRunPayload(),
    fetchCheckoutIdentity: async () =>
      fetchCheckoutIdentityArtifact({
        repoRoot,
        runId: "999",
        runAttempt: 1,
        slug: "owner/repo",
        runGh: async (command, args) => {
          if (args[0] === "api") {
            return JSON.stringify({
              artifacts: [{ id: 7, name: "checkout-identity-999-1" }],
            });
          }
          const dir = args[args.indexOf("--dir") + 1];
          await writeFile(
            path.join(dir, "checkout-identity.json"),
            JSON.stringify({
              commitSha: candidate.commitSha,
              treeSha: "c".repeat(40),
            }),
            "utf8",
          );
          return "";
        },
      }),
    fullCiContract: fullCiContractWithCheckout,
  });
  assert.equal(badTree.ok, false);
  assert.match(badTree.message, /checkout-identity treeSha/);
});

test("listRunArtifacts paginates with per_page=100", async () => {
  const pages = [];
  const artifacts = await listRunArtifacts({
    slug: "owner/repo",
    runId: "55",
    repoRoot,
    runGh: async (_command, args) => {
      pages.push(String(args[1]));
      const page = Number(
        new URLSearchParams(String(args[1]).split("?")[1]).get("page"),
      );
      if (page === 1) {
        return JSON.stringify({
          artifacts: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `artifact-${index + 1}`,
          })),
        });
      }
      return JSON.stringify({
        artifacts: [{ id: 101, name: "checkout-identity-55-1" }],
      });
    },
  });
  assert.equal(artifacts.length, 101);
  assert.ok(pages[0].includes("per_page=100"));
  assert.ok(pages[0].includes("page=1"));
  assert.ok(pages[1].includes("page=2"));
});

test("journey evidence requires candidate binding and assertions", () => {
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

test("journey contract mismatch rejects forged runner metadata", () => {
  const contract = {
    runnerId: "gate-b2-journey-runner",
    runnerVersion: "2",
    requiredAssertions: ["source-changed", "plan-bound"],
  };
  const mismatch = validateJourneyEvidence(
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
    { journeyId: "prepared-plan-toctou", candidate, contract },
  );
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /runnerId/);

  const ok = validateJourneyEvidence(
    {
      schemaVersion: 1,
      journeyId: "prepared-plan-toctou",
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      runnerId: contract.runnerId,
      runnerVersion: contract.runnerVersion,
      environmentDigest: `sha256:${"c".repeat(64)}`,
      assertions: contract.requiredAssertions.map((id) => ({
        id,
        passed: true,
      })),
      result: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    },
    { journeyId: "prepared-plan-toctou", candidate, contract },
  );
  assert.equal(ok.ok, true);
});

test("chronicle report must bind candidate metadata and remain 14/14 eligible", () => {
  assert.equal(
    validateChronicleProductionReport(
      {
        attempt: 1,
        caseCount: 14,
        certificationEligible: false,
      },
      candidate,
      heavyExpected,
    ).ok,
    false,
  );
  assert.equal(
    validateChronicleProductionReport(
      validHeavyReport(),
      candidate,
      heavyExpected,
    ).ok,
    true,
  );
  assert.equal(
    validateChronicleProductionReport(
      validHeavyReport({ candidateCommitSha: "c".repeat(40) }),
      candidate,
      heavyExpected,
    ).ok,
    false,
  );
});

test("consent report requires observed teardown flags and binding metadata", () => {
  const consentExpected = {
    ...heavyExpected,
    suiteId: "heavy-web-ai-consent-live",
  };
  assert.equal(
    validateWebAiConsentReport(
      {
        certificationEligible: true,
        teardown: { serverClosed: false, localStorageCleared: true },
      },
      consentExpected,
    ).ok,
    false,
  );
  assert.equal(
    validateWebAiConsentReport(
      {
        ...validHeavyReport({ suiteId: consentExpected.suiteId }),
        teardown: { serverClosed: true, localStorageCleared: true },
      },
      consentExpected,
    ).ok,
    true,
  );
  assert.equal(
    validateWebAiConsentReport(
      {
        ...validHeavyReport({
          suiteId: consentExpected.suiteId,
          runId: "wrong",
        }),
        teardown: { serverClosed: true, localStorageCleared: true },
      },
      consentExpected,
    ).ok,
    false,
  );
});

test("decision document includes suiteSummaries and digests", () => {
  const doc = buildDecisionDocument({
    candidate: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
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

test("assertDigestsMatchFreeze detects input and harness drift", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const freezeCandidate = {
    writerRegistryDigest: digest,
    certificationManifestDigest: digest,
    certifyRunnerDigest: digest,
    certifyBindingsDigest: digest,
    adrValidatorDigest: digest,
    reportSchemaDigest: digest,
    decisionSchemaDigest: digest,
    journeySchemaDigest: digest,
    chronicleAdapterDigest: digest,
    chronicleScorerDigest: digest,
    webConsentJourneyDigest: digest,
  };
  const drift = assertDigestsMatchFreeze(
    {
      writerRegistryDigest: `sha256:${"b".repeat(64)}`,
      certificationManifestDigest: digest,
    },
    freezeCandidate,
  );
  assert.ok(drift.some((error) => error.startsWith("writerRegistryDigest:")));

  const harnessDrift = assertDigestsMatchFreeze(
    {
      writerRegistryDigest: digest,
      certificationManifestDigest: `sha256:${"c".repeat(64)}`,
      certifyRunnerDigest: digest,
      certifyBindingsDigest: digest,
      adrValidatorDigest: digest,
      reportSchemaDigest: digest,
      decisionSchemaDigest: digest,
      journeySchemaDigest: digest,
      chronicleAdapterDigest: digest,
      chronicleScorerDigest: digest,
      webConsentJourneyDigest: digest,
    },
    freezeCandidate,
  );
  assert.ok(
    harnessDrift.some((error) =>
      error.startsWith("certificationManifestDigest:"),
    ),
  );
});

test("assertDigestsMatchFreeze errors on missing harness digests and contractVersion", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const missingHarness = assertDigestsMatchFreeze(
    { writerRegistryDigest: digest },
    { writerRegistryDigest: digest },
    { contractVersion: GATE_B2_CONTRACT_VERSION - 1 },
  );
  assert.ok(
    missingHarness.some((error) => error.startsWith("contractVersion:")),
  );
  assert.ok(
    missingHarness.some((error) =>
      error.startsWith("certificationManifestDigest: missing in freeze"),
    ),
  );
  assert.equal(Object.keys(HARNESS_DIGEST_PATHS).length, 11);
  assert.equal(
    HARNESS_DIGEST_PATHS.certifyBootstrapDigest,
    "scripts/quality/certify-gate-b2-bootstrap.mjs",
  );
});

test("assertFreezeActive rejects superseded freeze", () => {
  assert.throws(
    () =>
      assertFreezeActive({
        status: "superseded",
        candidate: { commitSha: candidate.commitSha },
      }),
    /superseded/i,
  );
});

test("prepareWorktreeDependencies rejects lockfile mismatch", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-deps-"));
  const repoRoot = path.join(temp, "repo");
  const executionRoot = path.join(temp, "execution");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(executionRoot, { recursive: true });
  try {
    await writeFile(
      path.join(repoRoot, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
      "utf8",
    );
    await writeFile(
      path.join(executionRoot, "pnpm-lock.yaml"),
      "lockfileVersion: 9\npatched: true\n",
      "utf8",
    );
    await assert.rejects(
      () => prepareWorktreeDependencies({ repoRoot, executionRoot }),
      /pnpm-lock.yaml digest mismatch/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareWorktreeDependencies returns in-place for same root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-same-"));
  try {
    const result = await prepareWorktreeDependencies({
      repoRoot: temp,
      executionRoot: temp,
    });
    assert.deepEqual(result, { mode: "in-place" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  "prepareWorktreeDependencies installs workspace deps under executionRoot in detached worktree",
  {
    skip:
      process.env.GATE_B2_WORKTREE_INSTALL_SMOKE === "0"
        ? "set GATE_B2_WORKTREE_INSTALL_SMOKE=1 or unset to enable"
        : false,
  },
  async () => {
    const { spawn } = await import("node:child_process");
    const { realpathSync } = await import("node:fs");

    const headSha = await new Promise((resolve, reject) => {
      const child = spawn("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error("git rev-parse HEAD failed"));
        else resolve(Buffer.concat(stdout).toString("utf8").trim());
      });
    });

    const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-install-"));
    const worktreePath = path.join(temp, "tree");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          "git",
          ["worktree", "add", "--detach", worktreePath, headSha],
          { cwd: repoRoot, stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error("git worktree add failed"));
          else resolve();
        });
      });

      const prepared = await prepareWorktreeDependencies({
        repoRoot,
        executionRoot: worktreePath,
      });
      assert.ok(
        prepared.mode === "offline-install" ||
          prepared.mode === "online-install",
      );
      assert.match(prepared.lockfileDigest, /^sha256:/);

      const resolved = realpathSync(
        path.join(worktreePath, "node_modules", "@grimodex", "scan-core"),
      );
      const resolvedRoot = realpathSync(worktreePath);
      assert.ok(
        resolved.startsWith(`${resolvedRoot}${path.sep}`) ||
          resolved === resolvedRoot,
        `scan-core resolved outside executionRoot: ${resolved}`,
      );
    } finally {
      await new Promise((resolve) => {
        const child = spawn(
          "git",
          ["worktree", "remove", "--force", worktreePath],
          { cwd: repoRoot, stdio: "inherit" },
        );
        child.on("exit", () => resolve());
      });
      await rm(temp, { recursive: true, force: true });
    }
  },
);
