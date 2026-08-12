import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GATE_B2_CONTRACT_VERSION,
  HARNESS_DIGEST_PATHS,
  allocateGateB2ArtifactAttempt,
  assertDigestsMatchFreeze,
  assertFreezeActive,
  buildGhRunDownloadArgs,
  buildDecisionDocument,
  buildHeavyCertificationEnv,
  buildJourneyCertificationEnv,
  checkoutIdentityArtifactName,
  fetchCheckoutIdentityArtifact,
  listRunArtifacts,
  prepareWorktreeDependencies,
  sanitizeCertificationEnv,
  stripCredentialPlaceholders,
  validateChronicleProductionReport,
  validateFullCiEvidence,
  validateJourneyEvidence,
  validateJsonAgainstSchema,
  validateWebAiConsentBrowserReport,
  validateWebAiConsentReport,
  verifyFullCiWithGithub,
  writeGateB2AttemptArtifact,
} from "./certify-gate-b2-bindings.mjs";
import { getGateB2GithubAttemptIdentity } from "./gate-b2-github-attempt.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const digest = `sha256:${"d".repeat(64)}`;
const candidate = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  baseMasterSha: "c".repeat(40),
  schemaVersion: 20,
  attemptAuthority: {
    ...getGateB2GithubAttemptIdentity(),
    runId: "9001",
    runAttempt: 1,
  },
};

const fullCiContract = {
  workflowId: 123,
  workflowPath: ".github/workflows/ci.yml",
  acceptedEvents: ["push", "workflow_dispatch"],
  requiredJobs: ["Quality", "Frontend"],
};

const fullCiContractWithCheckout = {
  ...fullCiContract,
  requireCheckoutIdentityArtifact: true,
};

function fullCiEvidence(overrides = {}) {
  return {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    workflowId: fullCiContract.workflowId,
    runId: "88",
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
      { name: "Quality", conclusion: "success" },
      { name: "Frontend", conclusion: "success" },
    ],
  };
}

function checkoutIdentity(overrides = {}) {
  return {
    artifactId: 12345,
    artifactName: "checkout-identity-88-1",
    artifactDigest: `sha256:${"e".repeat(64)}`,
    identity: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      ...overrides,
    },
  };
}

test("certification environments bind candidate and GitHub run metadata", () => {
  const baseEnv = sanitizeCertificationEnv({
    KEEP_ME: "yes",
    NARRATIVE_EVAL_LIMIT: "1",
  });
  assert.equal(baseEnv.KEEP_ME, "yes");
  assert.equal(baseEnv.NARRATIVE_EVAL_LIMIT, undefined);
  assert.equal(
    stripCredentialPlaceholders(
      "OPENROUTER_API_KEY=... EMBED_NODE_MODULES=... pnpm test:node --run x.ts",
    ),
    "pnpm test:node --run x.ts",
  );

  const heavy = buildHeavyCertificationEnv({
    candidate,
    suiteId: "heavy-a",
    runId: "suite-run",
    outputPath: "/tmp/heavy.json",
    commandDigest: digest,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
    attemptDir: "/tmp/attempt-1",
    baseEnv,
  });
  assert.equal(heavy.GATE_B2_CANDIDATE_COMMIT_SHA, candidate.commitSha);
  assert.equal(heavy.GATE_B2_GITHUB_RUN_ID, "9001");
  assert.equal(heavy.GATE_B2_GITHUB_RUN_ATTEMPT, "1");
  assert.equal(heavy.GATE_B2_ATTEMPT, "1");

  const journey = buildJourneyCertificationEnv({
    candidate,
    journeyId: "journey-a",
    outputPath: "/tmp/journey.json",
    runnerArtifactPath: "/tmp/runner.json",
    commandDigest: digest,
    environmentDigest: digest,
    runnerId: "runner-a",
    runnerVersion: "1",
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
    attemptDir: "/tmp/attempt-1",
    baseEnv,
  });
  assert.equal(journey.GATE_B2_SUITE_ID, "journey-a");
  assert.equal(journey.GATE_B2_GITHUB_RUN_ID, "9001");
});

test("suite Attempt 1 artifacts are staged once inside the workflow artifact", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-attempt-"));
  try {
    const allocation = await allocateGateB2ArtifactAttempt({
      artifactRoot: temp,
      suiteId: "heavy-a",
      bucket: "requiredHeavy",
    });
    assert.equal(allocation.attempt, 1);
    assert.match(allocation.attemptDir, /requiredHeavy\/heavy-a\/attempt-1$/);
    const written = await writeGateB2AttemptArtifact({
      attemptDir: allocation.attemptDir,
      record: {
        schemaVersion: 1,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        suiteId: "heavy-a",
        bucket: "requiredHeavy",
        attempt: 1,
        result: "passed",
      },
    });
    const saved = JSON.parse(await readFile(written.recordPath, "utf8"));
    assert.match(saved.contentDigest, /^sha256:[0-9a-f]{64}$/);
    await assert.rejects(
      () =>
        writeGateB2AttemptArtifact({
          attemptDir: allocation.attemptDir,
          record: saved,
        }),
      /EEXIST/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Full CI evidence is candidate-bound and GitHub-verified", async () => {
  const evidence = fullCiEvidence({ requiredJobs: ["Frontend", "Quality"] });
  assert.equal(
    validateFullCiEvidence(evidence, candidate, fullCiContract).ok,
    true,
  );
  assert.equal(
    validateFullCiEvidence(
      { ...evidence, requiredJobs: ["Frontend"] },
      candidate,
      fullCiContract,
    ).ok,
    false,
  );
  const verified = await verifyFullCiWithGithub(evidence, candidate, {
    fullCiContract,
    fetchRun: async () => githubRunPayload(),
  });
  assert.equal(verified.ok, true, verified.message);
});

test("Full CI verification rejects incomplete evidence and GitHub drift", async () => {
  const bare = validateFullCiEvidence({ passed: true }, candidate);
  assert.equal(bare.ok, false);
  assert.match(bare.message, /missing required fields/i);

  for (const [name, payload, pattern] of [
    [
      "candidate",
      githubRunPayload({ run: { head_sha: "f".repeat(40) } }),
      /head_sha/i,
    ],
    ["attempt", githubRunPayload({ run: { run_attempt: 2 } }), /run_attempt/i],
    [
      "workflow",
      githubRunPayload({ run: { workflow_id: 999 } }),
      /workflow_id/i,
    ],
    [
      "path",
      githubRunPayload({
        run: { path: ".github/workflows/release.yml" },
      }),
      /workflow path/i,
    ],
    [
      "event",
      githubRunPayload({ run: { event: "pull_request" } }),
      /acceptedEvents/i,
    ],
    [
      "jobs",
      githubRunPayload({
        jobs: [{ name: "Quality", conclusion: "success" }],
      }),
      /missing required job Frontend/i,
    ],
  ]) {
    const result = await verifyFullCiWithGithub(fullCiEvidence(), candidate, {
      fullCiContract,
      fetchRun: async () => payload,
    });
    assert.equal(result.ok, false, name);
    assert.match(result.message, pattern, name);
  }

  const unavailable = await verifyFullCiWithGithub(
    fullCiEvidence(),
    candidate,
    {
      fullCiContract,
      fetchRun: async () => {
        throw new Error("gh unavailable");
      },
    },
  );
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /gh unavailable/i);
});

test("Full CI checkout artifact remains candidate-bound", async () => {
  const mismatched = await verifyFullCiWithGithub(fullCiEvidence(), candidate, {
    fullCiContract: fullCiContractWithCheckout,
    fetchRun: async () => githubRunPayload(),
    fetchCheckoutIdentity: async () =>
      checkoutIdentity({ treeSha: "f".repeat(40) }),
  });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.message, /checkout-identity treeSha/i);

  const verified = await verifyFullCiWithGithub(fullCiEvidence(), candidate, {
    fullCiContract: fullCiContractWithCheckout,
    fetchRun: async () => githubRunPayload(),
    fetchCheckoutIdentity: async () => checkoutIdentity(),
  });
  assert.equal(verified.ok, true, verified.message);
  assert.equal(verified.checkoutArtifactId, 12345);
  assert.equal(verified.checkoutCommitSha, candidate.commitSha);
  assert.equal(verified.checkoutTreeSha, candidate.treeSha);
});

test("checkout artifact download is exact and paginated", async () => {
  const args = buildGhRunDownloadArgs({
    runId: "88",
    slug: "owner/repo",
    artifactName: checkoutIdentityArtifactName("88", 1),
    dir: "/tmp/out",
  });
  assert.deepEqual(args.slice(0, 3), ["run", "download", "88"]);
  assert.equal(args.includes("--output"), false);
  assert.ok(args.includes("checkout-identity-88-1"));

  const calls = [];
  const downloaded = await fetchCheckoutIdentityArtifact({
    repoRoot,
    runId: "88",
    runAttempt: 1,
    slug: "owner/repo",
    runGh: async (_command, ghArgs) => {
      calls.push([...ghArgs]);
      if (ghArgs[0] === "api") {
        return JSON.stringify({
          artifacts: [{ id: 42, name: "checkout-identity-88-1" }],
        });
      }
      const dir = ghArgs[ghArgs.indexOf("--dir") + 1];
      await writeFile(
        path.join(dir, "checkout-identity.json"),
        `${JSON.stringify({
          commitSha: candidate.commitSha,
          treeSha: candidate.treeSha,
        })}\n`,
        "utf8",
      );
      return "";
    },
  });
  assert.equal(downloaded.artifactId, 42);
  assert.match(downloaded.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(calls.some((call) => call[0] === "run"));

  const pages = [];
  const artifacts = await listRunArtifacts({
    slug: "owner/repo",
    runId: "88",
    repoRoot,
    runGh: async (_command, ghArgs) => {
      const query = String(ghArgs[1]);
      pages.push(query);
      const page = Number(new URLSearchParams(query.split("?")[1]).get("page"));
      return JSON.stringify({
        artifacts:
          page === 1
            ? Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: `artifact-${index + 1}`,
              }))
            : [{ id: 101, name: "checkout-identity-88-1" }],
      });
    },
  });
  assert.equal(artifacts.length, 101);
  assert.ok(pages[0].includes("per_page=100"));
  assert.ok(pages[1].includes("page=2"));
});

test("Journey and Heavy evidence must bind the frozen candidate", () => {
  const journeyContract = {
    runnerId: "runner-a",
    runnerVersion: "1",
    requiredAssertions: ["assertion-a"],
  };
  const journey = {
    schemaVersion: 2,
    journeyId: "journey-a",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    runnerId: "runner-a",
    runnerVersion: "1",
    environmentDigest: digest,
    commandDigest: digest,
    runnerArtifactDigest: digest,
    assertions: [{ id: "assertion-a", passed: true }],
    result: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    artifactDigests: [digest],
  };
  assert.equal(
    validateJourneyEvidence(journey, {
      journeyId: "journey-a",
      candidate,
      contract: journeyContract,
      expected: {
        freezeId: "freeze-1",
        certificationRunId: "cert-1",
        environmentDigest: digest,
        commandDigest: digest,
        runnerArtifactDigest: digest,
      },
    }).ok,
    true,
  );
  assert.equal(
    validateJourneyEvidence(
      { ...journey, candidateTreeSha: "f".repeat(40) },
      { journeyId: "journey-a", candidate, contract: journeyContract },
    ).ok,
    false,
  );

  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: digest,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
  };
  const chronicle = {
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    suiteId: expected.suiteId,
    runId: expected.runId,
    commandDigest: digest,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    caseCount: 14,
    certificationEligible: true,
  };
  assert.equal(
    validateChronicleProductionReport(chronicle, candidate, expected).ok,
    true,
  );
  assert.equal(
    validateChronicleProductionReport(
      { ...chronicle, attempt: 2 },
      candidate,
      expected,
    ).ok,
    false,
  );

  const browser = {
    ...chronicle,
    suiteId: "heavy-web-ai-consent-browser-live",
    mode: "web-ai-consent-browser-live",
    browser: {
      realBrowser: true,
      provider: "@vitest/browser-playwright",
      engine: "chromium",
    },
    requestCountBeforeConsent: 0,
    requestCountAfterRefuse: 0,
    requestCountAfterApprove: 1,
    requestCountAfterDestinationChangeRefuse: 1,
    providerRequestCount: 1,
    assertions: [
      "refusal-before-provider-is-zero-http",
      "approval-dispatches-provider-http",
      "destination-change-requires-fresh-consent",
      "indexeddb-and-localstorage-are-cleared",
      "browser-mock-is-closed-before-evidence",
    ],
    teardown: {
      serverClosed: true,
      evidenceServerClosed: true,
      localStorageCleared: true,
      indexedDbCleared: true,
      consentBrokerDeclined: true,
      browserMockClosed: true,
    },
  };
  assert.equal(
    validateWebAiConsentBrowserReport(browser, {
      ...expected,
      suiteId: browser.suiteId,
    }).ok,
    true,
  );
});

test("Decision contains only current suite attempts and GitHub authority", async () => {
  const digests = {
    writerRegistryDigest: digest,
    aiPathRegistryDigest: digest,
    qualityManifestDigest: digest,
    narrativeEvalManifestDigest: digest,
    adrChecklistDigest: digest,
    classificationDigest: digest,
  };
  const suites = [
    {
      suiteId: "light-a",
      bucket: "requiredLight",
      attempt: 1,
      result: "passed",
      message: "passed",
    },
  ];
  const decision = buildDecisionDocument({
    candidate,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    verdict: "PASS",
    reasons: ["passed"],
    suites,
    reportDigest: digest,
    digests,
  });
  assert.deepEqual(decision.suiteAttempts, [
    {
      suiteId: "light-a",
      bucket: "requiredLight",
      attempt: 1,
      result: "passed",
      message: "passed",
    },
  ]);
  assert.equal(decision.attemptAuthority.runId, "9001");

  const schema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-decision-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(validateJsonAgainstSchema(decision, schema).ok, true);
  const unbound = {
    ...decision,
    attemptAuthority: getGateB2GithubAttemptIdentity(),
  };
  assert.equal(validateJsonAgainstSchema(unbound, schema).ok, false);
});

test("freeze and harness digests are fixed to contract v7 authority", () => {
  const harness = Object.fromEntries(
    Object.keys(HARNESS_DIGEST_PATHS).map((key) => [key, digest]),
  );
  assert.deepEqual(assertDigestsMatchFreeze(harness, harness), []);
  assert.match(
    assertDigestsMatchFreeze(
      { ...harness, attemptWorkflowDigest: `sha256:${"e".repeat(64)}` },
      harness,
    ).join("\n"),
    /attemptWorkflowDigest/,
  );

  const authority = getGateB2GithubAttemptIdentity();
  const freeze = {
    contractVersion: GATE_B2_CONTRACT_VERSION,
    gateId: "gate-b2",
    status: "active",
    freezeId: "freeze-1",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    productSchemaVersion: 20,
    attemptAuthority: authority,
    candidate: {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      schemaVersion: 20,
      attemptAuthority: authority,
    },
  };
  assert.doesNotThrow(() => assertFreezeActive(freeze));
  assert.throws(
    () =>
      assertFreezeActive({
        ...freeze,
        candidate: {
          ...freeze.candidate,
          attemptAuthority: { ...authority, repository: "other/repo" },
        },
      }),
    /GitHub Actions attempt authority/i,
  );
});

test("freeze validation fails closed for supersession and missing harness digests", () => {
  assert.throws(
    () =>
      assertFreezeActive({
        status: "superseded",
        candidate: { commitSha: candidate.commitSha },
      }),
    /superseded/i,
  );

  const failures = assertDigestsMatchFreeze(
    { writerRegistryDigest: digest },
    { writerRegistryDigest: digest },
    { contractVersion: GATE_B2_CONTRACT_VERSION - 1 },
  );
  assert.ok(failures.some((error) => error.startsWith("contractVersion:")));
  assert.ok(
    failures.some((error) =>
      error.startsWith("certificationManifestDigest: missing in freeze"),
    ),
  );
  assert.equal(
    HARNESS_DIGEST_PATHS.attemptWorkflowDigest,
    ".github/workflows/gate-b2-certification.yml",
  );
});

test("Journey and consent validation reject forged metadata", () => {
  const journeyContract = {
    runnerId: "runner-a",
    runnerVersion: "1",
    requiredAssertions: ["assertion-a"],
  };
  const baseJourney = {
    schemaVersion: 2,
    journeyId: "journey-a",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    runnerId: "runner-a",
    runnerVersion: "1",
    environmentDigest: digest,
    commandDigest: digest,
    runnerArtifactDigest: digest,
    assertions: [{ id: "assertion-a", passed: true }],
    result: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    artifactDigests: [digest],
  };
  const forgedJourney = validateJourneyEvidence(
    { ...baseJourney, runnerId: "forged-runner" },
    {
      journeyId: "journey-a",
      candidate,
      contract: journeyContract,
      expected: {
        freezeId: "freeze-1",
        certificationRunId: "cert-1",
        environmentDigest: digest,
        commandDigest: digest,
        runnerArtifactDigest: digest,
      },
    },
  );
  assert.equal(forgedJourney.ok, false);
  assert.match(forgedJourney.message, /runnerId/i);

  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-web-ai-consent-live",
    runId: "run-1",
    commandDigest: digest,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
  };
  const consent = {
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    suiteId: expected.suiteId,
    runId: expected.runId,
    commandDigest: digest,
    freezeId: "freeze-1",
    certificationRunId: "cert-1",
    attempt: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    certificationEligible: true,
    teardown: { serverClosed: true, localStorageCleared: true },
  };
  assert.equal(validateWebAiConsentReport(consent, expected).ok, true);
  assert.equal(
    validateWebAiConsentReport(
      {
        ...consent,
        teardown: { ...consent.teardown, serverClosed: false },
      },
      expected,
    ).ok,
    false,
  );
});

test("detached worktree dependency preparation rejects lockfile drift", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-deps-"));
  const sourceRoot = path.join(temp, "source");
  const executionRoot = path.join(temp, "execution");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(executionRoot, { recursive: true });
  try {
    await writeFile(
      path.join(sourceRoot, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
      "utf8",
    );
    await writeFile(
      path.join(executionRoot, "pnpm-lock.yaml"),
      "lockfileVersion: 9\npatched: true\n",
      "utf8",
    );
    await assert.rejects(
      () =>
        prepareWorktreeDependencies({
          repoRoot: sourceRoot,
          executionRoot,
        }),
      /pnpm-lock.yaml digest mismatch/i,
    );
    assert.deepEqual(
      await prepareWorktreeDependencies({
        repoRoot: sourceRoot,
        executionRoot: sourceRoot,
      }),
      { mode: "in-place" },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
