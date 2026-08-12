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
  loadGateB2Manifest,
  parseCertifyArgs,
  runJourneySuite,
  tallyBucket,
  validateGateB2Manifest,
} from "./certify-gate-b2.mjs";
import { validateJsonAgainstSchema } from "./certify-gate-b2-bindings.mjs";
import { getGateB2GithubAttemptIdentity } from "./gate-b2-github-attempt.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("Gate B2 v7 manifest uses the dedicated GitHub Actions authority", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  assert.deepEqual(validateGateB2Manifest(raw), []);
  assert.equal(raw.contractVersion, 7);
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
    [
      "heavy-agent-tool-loop",
      "heavy-single-shot-surfaces",
      "heavy-rust-post-effect-live",
      "heavy-codex-prompt-surfaces",
      "heavy-narrative-chronicle-production",
      "heavy-web-ai-consent-browser-live",
    ],
  );
});

test("dedicated workflow takes candidate and successful Full CI run IDs", async () => {
  const workflowText = await readFile(
    path.join(repoRoot, ".github/workflows/gate-b2-certification.yml"),
    "utf8",
  );
  const workflow = yaml.load(workflowText);
  const dispatch = workflow.on?.workflow_dispatch;
  assert.ok(dispatch);
  assert.equal(dispatch.inputs.candidate_sha.required, true);
  assert.equal(dispatch.inputs.full_ci_run_id.required, true);
  assert.match(workflowText, /gate-b2-github-attempt\.mjs/);
  assert.match(workflowText, /--run-light/);
  assert.match(workflowText, /--run-heavy/);
  assert.match(workflowText, /--run-journeys/);
  assert.doesNotMatch(workflowText, /private.?key|ed25519|signature/i);
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
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-not-for-network";
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
    const production = report.suites.find(
      (suite) => suite.suiteId === "heavy-narrative-chronicle-production",
    );
    const browserConsent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-browser-live",
    );
    const informationalConsent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-live",
    );
    assert.equal(production.result, "not-run");
    assert.equal(browserConsent.result, "not-run");
    assert.equal(informationalConsent.result, "not-run");
    assert.match(production.command.join(" "), /chronicle:production:live/);
    assert.match(browserConsent.command.join(" "), /web-ai-consent:browser/);
    assert.equal(report.verdict, "INCOMPLETE");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
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
  const childEnv = { ...process.env };
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

test("active schemas use the minimal v7 GitHub authority contract", async () => {
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
  assert.equal(reportSchema.properties.contractVersion.const, 7);
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
});
