import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

import {
  certificationExitCode,
  certifyGateB2,
  decideVerdict,
  emptyBucketSummary,
  journeyCertificationCommandDigest,
  loadGateB2Manifest,
  parseCertifyArgs,
  runJourneySuite,
  sha256Text,
  tallyBucket,
  validateGateB2Manifest,
} from "./certify-gate-b2.mjs";
import {
  sanitizeCertificationEnv,
  validateJsonAgainstSchema,
} from "./certify-gate-b2-bindings.mjs";
import { getGateB2GithubAttemptIdentity } from "./gate-b2-github-attempt.mjs";
import { certificationCommandForJourney } from "./run-gate-b2-journey.mjs";
import { validateNativeWriterOwnership } from "./validate-native-writer-ownership.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("Gate B2 v8 is credential-free and uses the dedicated GitHub Actions authority", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  assert.deepEqual(validateGateB2Manifest(raw), []);
  assert.equal(raw.contractVersion, 8);
  assert.deepEqual(
    raw.candidate.attemptAuthority,
    getGateB2GithubAttemptIdentity(),
  );
  assert.equal(
    raw.inputs.attemptWorkflow,
    ".github/workflows/gate-b2-certification.yml",
  );
  assert.equal(raw.fullCi.acceptedEvents.includes("pull_request"), false);
  assert.equal(raw.requiredManualJourneys.length, 7);
  assert.deepEqual(
    raw.requiredHeavy.map((entry) => entry.id),
    ["heavy-web-ai-consent-browser-live"],
  );
  for (const bucket of [
    raw.requiredLight,
    raw.requiredHeavy,
    raw.requiredManualJourneys,
  ]) {
    assert.ok(bucket.every((entry) => !Object.hasOwn(entry, "requiresEnv")));
  }
  assert.deepEqual(raw.assuranceScope, {
    engineeringSafety: "certified",
    liveProviderExecution: "excluded",
    modelQuality: "excluded",
    externalCredentialsUsed: false,
  });
});

test("certifier and Journey runner bind the same fixed command digest", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  for (const entry of raw.requiredManualJourneys) {
    assert.deepEqual(entry.command, certificationCommandForJourney(entry.id));
    assert.equal(
      journeyCertificationCommandDigest(entry),
      sha256Text(JSON.stringify(certificationCommandForJourney(entry.id))),
    );
  }
});

test("trusted project deletion stays inside native writer ownership", () => {
  const result = validateNativeWriterOwnership();
  assert.equal(result.activeCount > 0, true);
  assert.deepEqual(result.violations, []);
});

test("dedicated workflow binds a metadata-only freeze envelope to candidate and Full CI", async () => {
  const workflowText = await readFile(
    path.join(repoRoot, ".github/workflows/gate-b2-certification.yml"),
    "utf8",
  );
  const workflow = yaml.load(workflowText);
  const dispatch = workflow.on?.workflow_dispatch;
  assert.ok(dispatch);
  assert.equal(dispatch.inputs.candidate_sha.required, true);
  assert.equal(dispatch.inputs.freeze_sha.required, true);
  assert.equal(dispatch.inputs.full_ci_run_id.required, true);
  assert.match(workflowText, /gate-b2-github-attempt\.mjs/);
  assert.match(workflowText, /--run-light/);
  assert.match(workflowText, /--run-heavy/);
  assert.match(workflowText, /--run-journeys/);
  const checkout = workflow.jobs.certify.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.with?.ref, "${{ inputs.freeze_sha }}");
  const steps = workflow.jobs.certify.steps;
  const envelopeIndex = steps.findIndex(
    (step) => step.name === "Verify immutable candidate freeze envelope",
  );
  const admissionIndex = steps.findIndex((step) =>
    String(step.run ?? "").includes("gate-b2-github-attempt.mjs"),
  );
  assert.ok(envelopeIndex > 0);
  assert.ok(admissionIndex > envelopeIndex);
  const envelopeCommand = String(steps[envelopeIndex].run);
  assert.match(envelopeCommand, /GATE_B2_FREEZE_SHA\}\^/);
  assert.match(envelopeCommand, /git diff --name-status/);
  assert.match(
    envelopeCommand,
    /evals\/certifications\/gate-b2-candidate\.freeze\.json/,
  );
  assert.match(envelopeCommand, /change_count" -eq 3/);
  assert.match(envelopeCommand, /provisional Gate B2 result/);
  assert.match(workflowText, /credential-free Gate B2 engineering suites/);
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflowText, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(workflowText, /private.?key|ed25519|signature/i);
});

test("freeze envelope workflow guard accepts only the three metadata files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-envelope-"));
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: temp,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--quiet");
    git("config", "user.name", "Gate B2 Test");
    git("config", "user.email", "gate-b2@example.invalid");
    await mkdir(path.join(temp, "evals/certifications/archive"), {
      recursive: true,
    });
    await mkdir(path.join(temp, "evals/certifications/results"), {
      recursive: true,
    });
    await writeFile(
      path.join(temp, "evals/certifications/gate-b2-candidate.freeze.json"),
      '{"freezeId":"previous"}\n',
      "utf8",
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "candidate");
    const candidateSha = git("rev-parse", "HEAD");
    const candidateTreeSha = git("rev-parse", "HEAD^{tree}");
    const freezeId = "freeze-envelope-test";
    await writeFile(
      path.join(temp, "evals/certifications/gate-b2-candidate.freeze.json"),
      `${JSON.stringify({
        freezeId,
        candidateCommitSha: candidateSha,
        candidateTreeSha,
        candidate: { commitSha: candidateSha, treeSha: candidateTreeSha },
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(
        temp,
        `evals/certifications/results/gate-b2-${candidateSha}.json`,
      ),
      `${JSON.stringify({
        verdict: "INCOMPLETE",
        freezeId,
        candidateCommitSha: candidateSha,
        candidateTreeSha,
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(
        temp,
        `evals/certifications/archive/gate-b2-candidate.${"a".repeat(40)}.freeze.json`,
      ),
      '{"status":"superseded"}\n',
      "utf8",
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "freeze envelope");

    const workflow = yaml.load(
      await readFile(
        path.join(repoRoot, ".github/workflows/gate-b2-certification.yml"),
        "utf8",
      ),
    );
    const command = workflow.jobs.certify.steps.find(
      (step) => step.name === "Verify immutable candidate freeze envelope",
    ).run;
    const runGuard = () =>
      spawnSync("bash", ["-c", command], {
        cwd: temp,
        encoding: "utf8",
        env: {
          ...process.env,
          GATE_B2_CANDIDATE_SHA: candidateSha,
          GATE_B2_FREEZE_SHA: git("rev-parse", "HEAD"),
        },
      });
    const accepted = runGuard();
    assert.equal(accepted.status, 0, accepted.stderr);

    await mkdir(path.join(temp, "scripts/quality"), { recursive: true });
    await writeFile(
      path.join(temp, "scripts/quality/unexpected.mjs"),
      "export {};\n",
      "utf8",
    );
    git("add", ".");
    git("commit", "--quiet", "--amend", "--no-edit");
    const rejected = runGuard();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unexpected freeze-envelope change/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("manifest rejects required-suite opt-outs and unfrozen Journey runners", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  raw.requiredHeavy[0].certificationCredit = false;
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /requiredHeavy .* cannot set certificationCredit:false/i,
  );

  const { raw: missingRunner } = await loadGateB2Manifest(repoRoot);
  delete missingRunner.requiredManualJourneys[0].runner;
  assert.match(
    validateGateB2Manifest(missingRunner).join("\n"),
    /active journey requires runner.command/i,
  );

  const { raw: unfrozenRunner } = await loadGateB2Manifest(repoRoot);
  unfrozenRunner.requiredManualJourneys[0].runner = {
    command: ["node", "scripts/not-frozen.mjs"],
    sourcePath: "scripts/not-frozen.mjs",
  };
  assert.match(
    validateGateB2Manifest(unfrozenRunner).join("\n"),
    /runner.sourcePath must be frozen/i,
  );

  const { raw: unsafePolicy } = await loadGateB2Manifest(repoRoot);
  unsafePolicy.decisionPolicy.blockedIsPass = true;
  assert.match(
    validateGateB2Manifest(unsafePolicy).join("\n"),
    /blockedIsPass must be false/i,
  );

  for (const bucket of [
    "requiredLight",
    "requiredHeavy",
    "requiredManualJourneys",
  ]) {
    const { raw: credentialed } = await loadGateB2Manifest(repoRoot);
    credentialed[bucket][0].requiresEnv = ["OPENROUTER_API_KEY"];
    assert.match(
      validateGateB2Manifest(credentialed).join("\n"),
      /must not require external credentials/i,
    );
  }
});

test("credential absence does not block an otherwise complete formal Gate B2 decision", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  const suites = [
    ...raw.requiredLight.map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredLight",
      attempt: 1,
      result: "passed",
    })),
    ...raw.requiredHeavy.map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredHeavy",
      attempt: 1,
      result: "passed",
    })),
    ...raw.requiredManualJourneys.map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredJourneys",
      attempt: 1,
      result: "passed",
    })),
  ];
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.equal(
      decideVerdict({
        suites,
        candidate: { frozen: true, dirty: false },
        decisionPolicy: raw.decisionPolicy,
        preflightOnly: false,
      }).verdict,
      "PASS",
    );
  } finally {
    if (previousKey !== undefined) process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test("CLI defaults to preflight and rejects unknown options", () => {
  assert.deepEqual(parseCertifyArgs([]), {
    preflight: true,
    runLight: false,
    runHeavy: false,
    runJourneys: false,
    runInformational: false,
    runReleaseAdjacent: false,
    candidate: null,
    baseMaster: null,
    report: null,
    artifactDir: null,
    format: "markdown",
    ciEvidence: null,
    journeyEvidenceDir: null,
    dryRun: false,
  });
  assert.throws(
    () => parseCertifyArgs(["--unknown-option"]),
    /unknown argument/i,
  );
  assert.throws(
    () => parseCertifyArgs(["--preflight", "--run-light"]),
    /cannot be combined/i,
  );
});

test("only PASS and true preflight INCOMPLETE exit successfully", () => {
  assert.equal(certificationExitCode({ verdict: "PASS", mode: "full" }), 0);
  assert.equal(
    certificationExitCode({ verdict: "INCOMPLETE", mode: "preflight" }),
    0,
  );
  assert.equal(
    certificationExitCode({ verdict: "INCOMPLETE", mode: "light" }),
    1,
  );
  assert.equal(certificationExitCode({ verdict: "BLOCK", mode: "full" }), 1);
});

function requiredSuite(result, attempt = 1) {
  return {
    suiteId: "required-a",
    bucket: "requiredLight",
    attempt,
    result,
  };
}

test("verdict never promotes blocked, deferred, missing, or Attempt 2 results", () => {
  const candidate = { frozen: true, dirty: false };
  const decisionPolicy = { requireCandidateFreeze: true };
  assert.equal(
    decideVerdict({
      suites: [requiredSuite("passed")],
      candidate,
      decisionPolicy,
      preflightOnly: false,
    }).verdict,
    "PASS",
  );
  for (const [result, expected] of [
    ["blocked", "BLOCK"],
    ["failed", "BLOCK"],
    ["deferred", "BLOCK"],
    ["not-run", "INCOMPLETE"],
    ["hold", "HOLD"],
  ]) {
    assert.equal(
      decideVerdict({
        suites: [requiredSuite(result)],
        candidate,
        decisionPolicy,
        preflightOnly: false,
      }).verdict,
      expected,
    );
  }
  assert.equal(
    decideVerdict({
      suites: [requiredSuite("passed", 2)],
      candidate,
      decisionPolicy,
      preflightOnly: false,
    }).verdict,
    "BLOCK",
  );
});

test("bucket tally never invents passes", () => {
  assert.deepEqual(emptyBucketSummary(), {
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    hold: 0,
    notRun: 0,
    deferred: 0,
  });
  assert.deepEqual(
    tallyBucket(
      [
        { bucket: "requiredHeavy", result: "passed" },
        { bucket: "requiredHeavy", result: "blocked" },
        { bucket: "requiredHeavy", result: "informational" },
      ],
      "requiredHeavy",
    ),
    {
      total: 3,
      passed: 1,
      failed: 0,
      blocked: 1,
      hold: 0,
      notRun: 1,
      deferred: 0,
    },
  );
});

test("Journey dry-run does not accept handwritten evidence", async () => {
  const result = await runJourneySuite({
    journeyEntry: {
      id: "journey-a",
      runnerId: "runner-a",
      runnerVersion: "1",
      requiredAssertions: ["assertion-a"],
      runner: { command: ["node", "runner.mjs"] },
    },
    candidate: {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    environment: { digest: `sha256:${"c".repeat(64)}` },
    repoRoot,
    dryRun: true,
    freeze: { freezeId: "freeze-1" },
    certificationRunId: "cert-1",
    allocation: null,
  });
  assert.equal(result.result, "not-run");
  assert.match(result.message, /dry-run|not executed/i);
});

test("Journey runner emits fresh candidate-bound evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-live-"));
  const runnerPath = path.join(temp, "runner.mjs");
  const attemptDir = path.join(temp, "attempt-1");
  const evidencePath = path.join(attemptDir, "journey-evidence.json");
  const candidate = {
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
  };
  const environment = { digest: `sha256:${"c".repeat(64)}` };
  try {
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      runnerPath,
      `import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const artifact = Buffer.from(JSON.stringify({ ok: true }) + "\\n", "utf8");
const artifactDigest = "sha256:" + createHash("sha256").update(artifact).digest("hex");
writeFileSync(process.env.GATE_B2_RUNNER_ARTIFACT_PATH, artifact, { flag: "wx" });
writeFileSync(process.env.GATE_B2_OUTPUT_PATH, JSON.stringify({
  schemaVersion: 2,
  journeyId: process.env.GATE_B2_SUITE_ID,
  candidateCommitSha: process.env.GATE_B2_CANDIDATE_COMMIT_SHA,
  candidateTreeSha: process.env.GATE_B2_CANDIDATE_TREE_SHA,
  freezeId: process.env.GATE_B2_FREEZE_ID,
  certificationRunId: process.env.GATE_B2_CERTIFICATION_RUN_ID,
  runnerId: process.env.GATE_B2_RUNNER_ID,
  runnerVersion: process.env.GATE_B2_RUNNER_VERSION,
  environmentDigest: process.env.GATE_B2_ENVIRONMENT_DIGEST,
  commandDigest: process.env.GATE_B2_COMMAND_DIGEST,
  runnerArtifactDigest: artifactDigest,
  assertions: [{ id: "fresh-assertion", passed: true }],
  result: "passed",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  artifactDigests: [artifactDigest]
}) + "\\n", { flag: "wx" });
`,
      "utf8",
    );
    const suite = await runJourneySuite({
      journeyEntry: {
        id: "fresh-journey",
        runnerId: "gate-b2-fresh-journey",
        runnerVersion: "1",
        requiredAssertions: ["fresh-assertion"],
        command: [process.execPath, runnerPath],
      },
      candidate,
      environment,
      repoRoot,
      dryRun: false,
      freeze: { freezeId: "freeze-1" },
      certificationRunId: "cert-1",
      allocation: { attempt: 1, attemptDir },
      env: process.env,
    });
    assert.equal(suite.result, "passed", suite.message);
    assert.equal(suite.exitCode, 0);
    assert.equal(
      JSON.parse(await readFile(evidencePath, "utf8")).journeyId,
      "fresh-journey",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Journey runner failures stay schema-compatible", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-fail-"));
  const candidate = {
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
  };
  const environment = { digest: `sha256:${"c".repeat(64)}` };
  try {
    for (const entry of [
      {
        id: "non-zero",
        command: [
          process.execPath,
          "-e",
          'process.stderr.write("failed"); process.exit(23);',
        ],
        exitCode: 23,
        message: /exited 23/i,
      },
      {
        id: "missing-evidence",
        command: [process.execPath, "-e", 'process.stdout.write("none");'],
        exitCode: 1,
        message: /did not create fresh evidence/i,
      },
    ]) {
      await t.test(entry.id, async () => {
        const attemptDir = path.join(temp, entry.id);
        await mkdir(attemptDir, { recursive: true });
        const suite = await runJourneySuite({
          journeyEntry: {
            id: entry.id,
            runnerId: `runner-${entry.id}`,
            runnerVersion: "1",
            requiredAssertions: ["recorded"],
            command: entry.command,
          },
          candidate,
          environment,
          repoRoot,
          dryRun: false,
          freeze: { freezeId: "freeze-1" },
          certificationRunId: "cert-1",
          allocation: { attempt: 1, attemptDir },
          env: process.env,
        });
        assert.equal(suite.result, "failed");
        assert.equal(suite.exitCode, entry.exitCode);
        assert.match(suite.message, entry.message);
        assert.match(suite.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
        assert.match(suite.stderrDigest, /^sha256:[0-9a-f]{64}$/);
      });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("preflight writes a schema-valid INCOMPLETE report without a run ID", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-preflight-"));
  try {
    const args = parseCertifyArgs([
      "--preflight",
      "--artifact-dir",
      temp,
      "--format",
      "json",
    ]);
    const { report, reportPath, decisionPath } = await certifyGateB2({
      repoRoot,
      args,
    });
    assert.equal(report.verdict, "INCOMPLETE");
    assert.equal(report.mode, "preflight");
    assert.equal(report.candidate.attemptAuthority.runId, null);
    const savedReport = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(savedReport.verdict, "INCOMPLETE");
    assert.equal(
      JSON.parse(await readFile(decisionPath, "utf8")).verdict,
      "INCOMPLETE",
    );

    const reportSchema = JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "evals/certifications/schemas/gate-b2-report-v1.schema.json",
        ),
        "utf8",
      ),
    );
    const forgedPass = structuredClone(savedReport);
    forgedPass.verdict = "PASS";
    forgedPass.freezeId = "freeze-1";
    forgedPass.candidate.frozen = true;
    forgedPass.candidate.dirty = false;
    assert.equal(
      validateJsonAgainstSchema(forgedPass, reportSchema).ok,
      false,
      "PASS must require a GitHub run ID",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("registered Heavy suites resolve in dry-run without becoming PASS", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-heavy-dry-"));
  try {
    const { report } = await certifyGateB2({
      repoRoot,
      args: parseCertifyArgs([
        "--run-heavy",
        "--run-informational",
        "--dry-run",
        "--artifact-dir",
        path.join(temp, "artifacts"),
        "--report",
        path.join(temp, "report.json"),
        "--format",
        "json",
      ]),
    });
    const browserConsent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-browser-live",
    );
    const informationalConsent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-live",
    );
    assert.equal(browserConsent.result, "not-run");
    assert.equal(informationalConsent.result, "not-run");
    assert.match(browserConsent.command.join(" "), /web-ai-consent:browser/);
    assert.equal(report.summary.requiredHeavy.total, 1);
    assert.equal(
      report.suites.some(
        (suite) => suite.suiteId === "heavy-narrative-chronicle-production",
      ),
      false,
    );
    assert.equal(report.verdict, "INCOMPLETE");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Light dry-run rejects handwritten Full CI evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-ci-dry-"));
  try {
    const evidencePath = path.join(temp, "full-ci.json");
    await writeFile(evidencePath, JSON.stringify({ passed: true }), "utf8");
    const { report } = await certifyGateB2({
      repoRoot,
      args: parseCertifyArgs([
        "--run-light",
        "--dry-run",
        "--ci-evidence",
        evidencePath,
        "--artifact-dir",
        path.join(temp, "artifacts"),
        "--report",
        path.join(temp, "report.json"),
        "--format",
        "json",
      ]),
    });
    const fullCi = report.suites.find((suite) => suite.suiteId === "full-ci");
    assert.equal(fullCi.result, "failed");
    assert.match(fullCi.message, /missing required fields/i);
    assert.equal(report.verdict, "BLOCK");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("execution cannot bypass the candidate bootstrap", (t) => {
  const childEnv = sanitizeCertificationEnv({
    ...process.env,
    GATE_B2_BOUND_EXECUTION: "1",
    GATE_B2_FREEZE_PATH: "/tmp/forged-freeze.json",
  });
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ["scripts/quality/certify-gate-b2.mjs", "--run-light", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8", env: childEnv },
  );
  if (run.error?.code === "EPERM") {
    t.skip("sandbox denied nested process execution");
    return;
  }
  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}\n${run.stderr}`, /bootstrap/i);
});

test("active schemas use the v8 credential-free assurance contract", async () => {
  const reportSchema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-report-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const decisionSchema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-decision-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(reportSchema.properties.contractVersion.const, 8);
  assert.ok(reportSchema.properties.assuranceScope);
  assert.equal(decisionSchema.properties.contractVersion.const, 8);
  assert.ok(decisionSchema.properties.assuranceScope);
  assert.ok(decisionSchema.properties.attemptAuthority);
  assert.deepEqual(decisionSchema.$defs.attemptAuthority.required, [
    "provider",
    "configDigest",
    "repository",
    "workflowPath",
    "event",
    "runId",
    "runAttempt",
  ]);

  const assurance = {
    engineeringSafety: "certified",
    liveProviderExecution: "excluded",
    modelQuality: "excluded",
    externalCredentialsUsed: false,
  };
  const minimalDecision = {
    schemaVersion: 1,
    contractVersion: 8,
    gateId: "gate-b2",
    assuranceScope: assurance,
    candidateCommitSha: "a".repeat(40),
    candidateTreeSha: "b".repeat(40),
    baseMasterSha: null,
    freezeId: null,
    certificationRunId: null,
    attemptAuthority: getGateB2GithubAttemptIdentity(),
    verdict: "INCOMPLETE",
    reasons: ["not run"],
    suiteSummaries: {
      requiredLight: { passed: 0, failed: 0, blocked: 0, hold: 0, notRun: 1 },
      requiredHeavy: { passed: 0, failed: 0, blocked: 0, hold: 0, notRun: 1 },
      requiredJourneys: {
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 1,
      },
    },
    digests: {
      writerRegistryDigest: `sha256:${"a".repeat(64)}`,
      aiPathRegistryDigest: `sha256:${"a".repeat(64)}`,
      qualityManifestDigest: `sha256:${"a".repeat(64)}`,
      narrativeEvalManifestDigest: `sha256:${"a".repeat(64)}`,
      reportDigest: null,
    },
    suiteAttempts: [],
    generatedAt: new Date().toISOString(),
  };
  assert.equal(
    validateJsonAgainstSchema(minimalDecision, decisionSchema).ok,
    true,
  );
  delete minimalDecision.assuranceScope;
  assert.equal(
    validateJsonAgainstSchema(minimalDecision, decisionSchema).ok,
    false,
    "assuranceScope is mandatory",
  );
});
