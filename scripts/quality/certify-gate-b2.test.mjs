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
  decideVerdict,
  emptyBucketSummary,
  evaluateJourneyEvidence,
  loadGateB2Manifest,
  parseCertifyArgs,
  tallyBucket,
  validateGateB2Manifest,
} from "./certify-gate-b2.mjs";
import { validateFullCiEvidence } from "./certify-gate-b2-bindings.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("Gate B2 certification manifest is valid and separates release-adjacent suites", async () => {
  const text = await readFile(
    path.join(repoRoot, "evals/certifications/gate-b2.yaml"),
    "utf8",
  );
  const raw = yaml.load(text);
  assert.deepEqual(validateGateB2Manifest(raw), []);
  assert.equal(raw.id, "gate-b2");
  assert.equal(raw.contractVersion, 5);
  assert.equal(raw.decisionPolicy.blockedIsPass, false);
  assert.equal(raw.decisionPolicy.deferredIsPass, false);
  assert.equal(raw.decisionPolicy.credentialShortageIsPass, false);
  assert.equal(raw.decisionPolicy.retryOverwritePass, false);
  assert.deepEqual(raw.requiredLight[0], {
    id: "adr-static-certification",
    command: ["pnpm", "test:narrative:gate-b2-adr:certifiable"],
  });

  const requiredHeavy = raw.requiredHeavy.map((entry) => entry.id);
  assert.deepEqual(requiredHeavy, [
    "heavy-agent-tool-loop",
    "heavy-single-shot-surfaces",
    "heavy-rust-post-effect-live",
    "heavy-codex-prompt-surfaces",
    "heavy-narrative-chronicle-production",
    "heavy-web-ai-consent-browser-live",
  ]);
  const browserConsent = raw.requiredHeavy.find(
    (entry) => entry.id === "heavy-web-ai-consent-browser-live",
  );
  assert.equal(browserConsent.status, "blocked");
  assert.ok(raw.fullCi?.workflowId);
  assert.equal(raw.fullCi.workflowPath, ".github/workflows/ci.yml");
  assert.equal(raw.fullCi.acceptedEvents.includes("pull_request"), false);

  const informational = raw.informational.map((entry) => entry.id);
  assert.ok(informational.includes("heavy-web-ai-consent-live"));
  assert.ok(
    informational.includes("heavy-narrative-chronicle-legacy-baseline"),
  );
  const consentEntry = raw.informational.find(
    (entry) => entry.id === "heavy-web-ai-consent-live",
  );
  assert.equal(consentEntry.certificationCredit, false);

  const journey = raw.requiredManualJourneys[0];
  assert.equal(typeof journey, "object");
  assert.equal(journey.id, "prepared-plan-toctou");
  assert.match(journey.runnerId, /^gate-b2-/);
  assert.equal(journey.runnerVersion, "1");
  assert.ok(Array.isArray(journey.requiredAssertions));
  assert.ok(journey.requiredAssertions.length > 0);
  assert.equal(journey.status, "blocked");
  assert.ok(journey.requiredAction);

  const releaseAdjacent = raw.releaseAdjacent.map((entry) => entry.id);
  assert.ok(releaseAdjacent.includes("heavy-related-scenes"));
  assert.ok(releaseAdjacent.includes("heavy-impact-gate31"));
  assert.ok(releaseAdjacent.includes("blocked-impact-gate4-fresh-holdout"));
  assert.equal(
    requiredHeavy.includes("heavy-related-scenes"),
    false,
    "retrieval Heavy must not be required for Gate B2 Engineering",
  );
});

test("package script and report schema exist for certify:gate-b2", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["certify:gate-b2"],
    "node scripts/quality/certify-gate-b2-bootstrap.mjs",
  );
  assert.equal(
    packageJson.scripts["test:narrative:gate-b2-adr"],
    "node scripts/quality/validate-gate-b2-adr.mjs",
  );
  assert.equal(
    packageJson.scripts["test:narrative:gate-b2-adr:certifiable"],
    "node scripts/quality/validate-gate-b2-adr.mjs -- --require-certifiable",
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /certify-gate-b2\.test\.mjs/,
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /certify-gate-b2-bindings\.test\.mjs/,
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /validate-gate-b2-adr\.test\.mjs/,
  );

  const schema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-report-v1.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(schema.title, "Gate B2 Certification Report");
  assert.ok(schema.required.includes("contractVersion"));
  assert.equal(schema.properties.contractVersion.const, 5);
  assert.deepEqual(schema.properties.verdict.enum, [
    "PASS",
    "HOLD",
    "BLOCK",
    "INCOMPLETE",
  ]);
  assert.equal(
    schema.properties.candidate.properties.adrChecklistDigest.pattern,
    "^sha256:[0-9a-f]{64}$",
  );
  assert.equal(
    schema.properties.candidate.properties.classificationDigest.pattern,
    "^sha256:[0-9a-f]{64}$",
  );
});

test("parseCertifyArgs defaults to preflight and rejects unknown flags", () => {
  assert.deepEqual(parseCertifyArgs([]).preflight, true);
  assert.equal(parseCertifyArgs(["--run-light"]).runLight, true);
  assert.equal(parseCertifyArgs(["--run-light"]).preflight, false);
  assert.throws(() => parseCertifyArgs(["--nope"]), /Unknown argument/);
  assert.throws(
    () => parseCertifyArgs(["--preflight", "--run-light"]),
    /cannot be combined with execution flags/,
  );
});

test("only a true preflight INCOMPLETE exits successfully", () => {
  assert.equal(
    certificationExitCode({ verdict: "INCOMPLETE", mode: "preflight" }),
    0,
  );
  assert.equal(
    certificationExitCode({ verdict: "INCOMPLETE", mode: "light" }),
    1,
  );
  assert.equal(
    certificationExitCode({ verdict: "INCOMPLETE", mode: "decision" }),
    1,
  );
  assert.equal(certificationExitCode({ verdict: "PASS", mode: "full" }), 0);
  assert.equal(certificationExitCode({ verdict: "BLOCK", mode: "full" }), 1);
});

test("required suites cannot opt out of certification credit", async () => {
  const text = await readFile(
    path.join(repoRoot, "evals/certifications/gate-b2.yaml"),
    "utf8",
  );
  const raw = yaml.load(text);
  raw.requiredHeavy[0].certificationCredit = false;
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /requiredHeavy .* cannot set certificationCredit:false/,
  );
});

test("an active journey requires a candidate runner frozen by the harness", async () => {
  const text = await readFile(
    path.join(repoRoot, "evals/certifications/gate-b2.yaml"),
    "utf8",
  );
  const raw = yaml.load(text);
  delete raw.requiredManualJourneys[0].status;
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /active journey requires runner.command/,
  );
  raw.requiredManualJourneys[0].runner = {
    command: ["pnpm", "test:fake"],
    sourcePath: "scripts/not-frozen.mjs",
  };
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /runner.sourcePath must be frozen/,
  );
  raw.requiredManualJourneys[0].runner = {
    command: ["node", "scripts/other.mjs"],
    sourcePath: "scripts/quality/certify-gate-b2.mjs",
  };
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /runner.command must execute runner.sourcePath directly/,
  );
});

test("active journey evidence is freshly emitted by a candidate-bound runner and schema validated", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-"));
  const runnerPath = path.join(temp, "runner.mjs");
  const evidencePath = path.join(temp, "journeys", "fresh-journey.json");
  const candidate = {
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
  };
  const environment = { digest: `sha256:${"c".repeat(64)}` };
  try {
    await writeFile(
      runnerPath,
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.env.GATE_B2_OUTPUT_PATH;
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  journeyId: process.env.GATE_B2_JOURNEY_ID,
  candidateCommitSha: process.env.GATE_B2_CANDIDATE_COMMIT_SHA,
  candidateTreeSha: process.env.GATE_B2_CANDIDATE_TREE_SHA,
  runnerId: process.env.GATE_B2_RUNNER_ID,
  runnerVersion: process.env.GATE_B2_RUNNER_VERSION,
  environmentDigest: process.env.GATE_B2_ENVIRONMENT_DIGEST,
  assertions: [{ id: "fresh-assertion", passed: true }],
  result: "passed",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString()
}));\n`,
      "utf8",
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, '{"passed":true}', "utf8");
    const suite = await evaluateJourneyEvidence({
      journeyEntry: {
        id: "fresh-journey",
        runnerId: "gate-b2-fresh-journey",
        runnerVersion: "1",
        requiredAssertions: ["fresh-assertion"],
        runner: { command: [process.execPath, runnerPath] },
      },
      artifactDir: temp,
      journeyEvidenceDir: path.dirname(evidencePath),
      candidate,
      repoRoot,
      environment,
      certEnv: process.env,
    });
    assert.equal(suite.result, "passed");
    assert.equal(suite.exitCode, 0);
    assert.match(suite.commandDigest, /^sha256:[0-9a-f]{64}$/);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.journeyId, "fresh-journey");
    assert.equal(evidence.passed, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("active journey runner failures return schema-compatible failed suites", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-failure-"));
  const candidate = {
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
  };
  const environment = { digest: `sha256:${"c".repeat(64)}` };
  const cases = [
    {
      name: "non-zero runner exit",
      journeyId: "failing-journey",
      command: [
        process.execPath,
        "-e",
        'process.stderr.write("journey failed"); process.exit(23);',
      ],
      exitCode: 23,
      message: /candidate journey runner exited 23/,
    },
    {
      name: "missing fresh evidence",
      journeyId: "missing-evidence-journey",
      command: [process.execPath, "-e", 'process.stdout.write("no evidence");'],
      exitCode: 1,
      message: /did not create fresh evidence/,
    },
  ];

  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const suite = await evaluateJourneyEvidence({
          journeyEntry: {
            id: entry.journeyId,
            runnerId: `gate-b2-${entry.journeyId}`,
            runnerVersion: "1",
            requiredAssertions: ["failure-is-recorded"],
            runner: { command: entry.command },
          },
          artifactDir: temp,
          journeyEvidenceDir: path.join(temp, "journeys"),
          candidate,
          repoRoot,
          environment,
          certEnv: process.env,
        });

        assert.equal(suite.suiteId, entry.journeyId);
        assert.equal(suite.bucket, "requiredJourneys");
        assert.equal(suite.attempt, 1);
        assert.match(suite.startedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(suite.completedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(suite.exitCode, entry.exitCode);
        assert.equal(suite.environmentDigest, environment.digest);
        assert.match(suite.commandDigest, /^sha256:[0-9a-f]{64}$/);
        assert.match(suite.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
        assert.match(suite.stderrDigest, /^sha256:[0-9a-f]{64}$/);
        assert.deepEqual(suite.artifactDigests, []);
        assert.equal(suite.result, "failed");
        assert.match(suite.message, entry.message);
        assert.deepEqual(suite.command, entry.command);
      });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("direct execution cannot bypass the frozen candidate bootstrap", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts/quality/certify-gate-b2.mjs"),
      "--run-light",
      "--dry-run",
      "--candidate",
      "a".repeat(40),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be launched through.*bootstrap/);
});

test("decideVerdict never promotes blocked/deferred/skipped to PASS", () => {
  const baseCandidate = {
    frozen: true,
    dirty: false,
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
  };
  const policy = {
    requireCandidateFreeze: true,
    blockedIsPass: false,
    deferredIsPass: false,
    skippedIsPass: false,
  };

  const blocked = decideVerdict({
    suites: [
      {
        suiteId: "heavy-web-ai-consent-live",
        bucket: "requiredHeavy",
        result: "blocked",
        message: "runner missing",
      },
    ],
    candidate: baseCandidate,
    decisionPolicy: policy,
    preflightOnly: false,
  });
  assert.equal(blocked.verdict, "BLOCK");

  const deferred = decideVerdict({
    suites: [
      {
        suiteId: "heavy-agent-tool-loop",
        bucket: "requiredHeavy",
        result: "deferred",
      },
    ],
    candidate: baseCandidate,
    decisionPolicy: policy,
    preflightOnly: false,
  });
  assert.equal(deferred.verdict, "BLOCK");

  const hold = decideVerdict({
    suites: [
      {
        suiteId: "heavy-narrative-chronicle-production",
        bucket: "requiredHeavy",
        result: "hold",
      },
    ],
    candidate: baseCandidate,
    decisionPolicy: policy,
    preflightOnly: false,
  });
  assert.equal(hold.verdict, "HOLD");

  const informational = decideVerdict({
    suites: [
      {
        suiteId: "required-but-non-credit",
        bucket: "requiredHeavy",
        result: "informational",
      },
    ],
    candidate: baseCandidate,
    decisionPolicy: policy,
    preflightOnly: false,
  });
  assert.equal(informational.verdict, "BLOCK");
});

test("decideVerdict never promotes a non-normative Attempt 2 success to PASS", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const result = decideVerdict({
    suites: [
      {
        suiteId: "heavy-agent-tool-loop",
        bucket: "requiredHeavy",
        attempt: 2,
        result: "passed",
        message: "diagnostic retry passed",
      },
    ],
    candidate: {
      frozen: true,
      dirty: false,
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      writerRegistryDigest: digest,
    },
    decisionPolicy: {
      requireCandidateFreeze: true,
      blockedIsPass: false,
      deferredIsPass: false,
      skippedIsPass: false,
      retryOverwritePass: false,
    },
    preflightOnly: false,
  });

  assert.equal(result.verdict, "BLOCK");
  assert.match(result.reasons.join("\n"), /Attempt 2|non-normative|normative/i);
});

test("tallyBucket counts suite results without inventing passes", () => {
  const summary = tallyBucket(
    [
      { bucket: "requiredHeavy", result: "blocked" },
      { bucket: "requiredHeavy", result: "not-run" },
      { bucket: "requiredLight", result: "passed" },
    ],
    "requiredHeavy",
  );
  assert.deepEqual(summary, {
    ...emptyBucketSummary(),
    total: 2,
    blocked: 1,
    notRun: 1,
  });
});

test("preflight loads manifest digests and writes report without claiming PASS", async () => {
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-cert-"));
  try {
    const reportPath = path.join(temp, "report.json");
    const { report } = await certifyGateB2({
      repoRoot,
      args: {
        preflight: true,
        runLight: false,
        runHeavy: false,
        runJourneys: false,
        runInformational: false,
        runReleaseAdjacent: false,
        candidate: null,
        baseMaster: null,
        report: reportPath,
        artifactDir: path.join(temp, "artifacts"),
        format: "json",
        ciEvidence: null,
        journeyEvidenceDir: null,
        dryRun: false,
      },
    });

    assert.equal(report.gateId, "gate-b2");
    assert.equal(report.contractVersion, 5);
    assert.equal(report.mode, "preflight");
    assert.equal(report.verdict, "INCOMPLETE");
    assert.match(report.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(
      report.candidate.writerRegistryDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(
      report.candidate.aiPathRegistryDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(report.candidate.adrChecklistDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(
      report.candidate.classificationDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(report.summary.requiredHeavy.total, 6);
    assert.equal(report.summary.requiredHeavy.notRun, 6);
    assert.equal(report.summary.informational.total, 2);

    const production = report.suites.find(
      (suite) => suite.suiteId === "heavy-narrative-chronicle-production",
    );
    assert.equal(production.result, "not-run");

    const saved = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(saved.verdict, "INCOMPLETE");
    assert.equal(saved.artifactDigests, undefined);
    const sidecar = (await readFile(`${reportPath}.sha256`, "utf8")).trim();
    assert.match(sidecar, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.reportDigest, sidecar);
    const decision = JSON.parse(
      await readFile(path.join(temp, "artifacts", "decision.json"), "utf8"),
    );
    assert.equal(decision.schemaVersion, 1);
    assert.ok(decision.suiteSummaries.requiredLight);
    assert.equal(decision.digests.reportDigest, sidecar);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("registered Gate B2 heavy runners resolve in dry-run without becoming passed", async () => {
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-heavy-"));
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-not-for-network";
  try {
    const { report } = await certifyGateB2({
      repoRoot,
      args: {
        preflight: false,
        runLight: false,
        runHeavy: true,
        runJourneys: false,
        runInformational: true,
        runReleaseAdjacent: false,
        candidate: null,
        baseMaster: null,
        report: path.join(temp, "report.json"),
        artifactDir: path.join(temp, "artifacts"),
        format: "json",
        ciEvidence: null,
        journeyEvidenceDir: null,
        dryRun: true,
      },
    });

    const consent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-live",
    );
    const production = report.suites.find(
      (suite) => suite.suiteId === "heavy-narrative-chronicle-production",
    );
    assert.equal(production.result, "not-run");
    assert.equal(consent.result, "not-run");
    assert.equal(consent.bucket, "informational");
    const browserConsent = report.suites.find(
      (suite) => suite.suiteId === "heavy-web-ai-consent-browser-live",
    );
    assert.equal(browserConsent.result, "blocked");
    assert.match(
      browserConsent.message,
      /Playwright|Vitest Browser|IndexedDB/i,
    );
    assert.match(
      production.command.join(" "),
      /eval:narrative:chronicle:production:live/,
    );
    assert.match(consent.command.join(" "), /eval:web-ai-consent:live/);
    assert.match(production.message, /dry-run/i);
    assert.match(consent.message, /dry-run/i);
    assert.notEqual(production.result, "passed");
    assert.notEqual(consent.result, "skipped");
    assert.equal(report.verdict, "BLOCK");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test("credential shortage for billed heavies is BLOCK not passed/skipped", async (t) => {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.stdout.trim().length > 0) {
    const { raw } = await loadGateB2Manifest(repoRoot);
    const agent = raw.requiredHeavy.find(
      (entry) => entry.id === "heavy-agent-tool-loop",
    );
    assert.deepEqual(agent.requiresEnv, ["OPENROUTER_API_KEY"]);
    t.skip("requires clean working tree for worktree-bound certification run");
    return;
  }

  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const { freezeGateB2Candidate } =
    await import("./freeze-gate-b2-candidate.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-cred-"));
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const isolatedFreezePath = path.join(temp, "gate-b2-candidate.freeze.json");
    const { freeze } = await freezeGateB2Candidate({
      repoRoot,
      writeResults: false,
      writeRepoFreeze: false,
      artifactRoot: path.join(temp, "freeze-artifacts"),
    });
    await writeFile(
      isolatedFreezePath,
      `${JSON.stringify(freeze, null, 2)}\n`,
      "utf8",
    );
    const { report } = await certifyGateB2({
      repoRoot,
      freezePath: isolatedFreezePath,
      freezeDocument: freeze,
      args: {
        preflight: false,
        runLight: false,
        runHeavy: true,
        runJourneys: false,
        runInformational: false,
        runReleaseAdjacent: false,
        candidate: freeze.candidate.commitSha,
        baseMaster: null,
        report: path.join(temp, "report.json"),
        artifactDir: path.join(temp, "artifacts"),
        format: "json",
        ciEvidence: null,
        journeyEvidenceDir: null,
        dryRun: false,
      },
    });
    const agent = report.suites.find(
      (suite) => suite.suiteId === "heavy-agent-tool-loop",
    );
    assert.equal(agent.result, "blocked");
    assert.match(agent.message, /OPENROUTER_API_KEY/);
    assert.equal(report.verdict, "BLOCK");
    assert.equal(report.firstFailure.suiteId, "heavy-agent-tool-loop");
    assert.equal(report.candidate.boundVia, "detached-worktree");
    assert.equal(report.candidate.commitSha, freeze.candidate.commitSha);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await rm(temp, { recursive: true, force: true });
  }
});
test("loadGateB2Manifest rejects policy that would pass blocked suites", async () => {
  const { raw } = await loadGateB2Manifest(repoRoot);
  raw.decisionPolicy.blockedIsPass = true;
  assert.match(
    validateGateB2Manifest(raw).join("\n"),
    /blockedIsPass must be false/,
  );
});

test("full-ci evidence rejects bare passed:true and incomplete binding", async () => {
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-ci-"));
  try {
    const bare = path.join(temp, "bare-ci.json");
    await writeFile(bare, JSON.stringify({ passed: true }), "utf8");
    const { report: bareReport } = await certifyGateB2({
      repoRoot,
      args: {
        preflight: false,
        runLight: true,
        runHeavy: false,
        runJourneys: false,
        runInformational: false,
        runReleaseAdjacent: false,
        candidate: null,
        baseMaster: null,
        report: path.join(temp, "bare-report.json"),
        artifactDir: path.join(temp, "bare-artifacts"),
        format: "json",
        ciEvidence: bare,
        journeyEvidenceDir: null,
        dryRun: true,
      },
    });
    const bareCi = bareReport.suites.find(
      (suite) => suite.suiteId === "full-ci",
    );
    assert.equal(bareCi.result, "failed");
    assert.match(bareCi.message, /missing required fields/);

    const evidence = path.join(temp, "full-ci.json");
    const { raw: manifest } = await loadGateB2Manifest(repoRoot);
    await writeFile(
      evidence,
      JSON.stringify({
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        workflowId: manifest.fullCi.workflowId,
        runId: "1",
        runAttempt: 1,
        conclusion: "success",
        requiredJobs: manifest.fullCi.requiredJobs,
        checkoutCommitSha: "c".repeat(40),
        checkoutTreeSha: "d".repeat(40),
      }),
      "utf8",
    );
    const { report } = await certifyGateB2({
      repoRoot,
      args: {
        preflight: false,
        runLight: true,
        runHeavy: false,
        runJourneys: false,
        runInformational: false,
        runReleaseAdjacent: false,
        candidate: null,
        baseMaster: null,
        report: path.join(temp, "report.json"),
        artifactDir: path.join(temp, "artifacts"),
        format: "json",
        ciEvidence: evidence,
        journeyEvidenceDir: null,
        dryRun: true,
      },
    });
    const fullCi = report.suites.find((suite) => suite.suiteId === "full-ci");
    assert.equal(fullCi.result, "failed");
    assert.match(fullCi.message, /commitSha .* != candidate/);

    const structuralOnly = validateFullCiEvidence(
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        workflowId: manifest.fullCi.workflowId,
        runId: "1",
        runAttempt: 1,
        conclusion: "success",
        requiredJobs: manifest.fullCi.requiredJobs,
        checkoutCommitSha: "c".repeat(40),
        checkoutTreeSha: "d".repeat(40),
      },
      { commitSha: "c".repeat(40), treeSha: "d".repeat(40) },
      manifest.fullCi,
    );
    assert.equal(structuralOnly.ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("report schema requires contractVersion 5 and accepts SuiteResult.runId", async () => {
  const { validateJsonAgainstSchema, sha256Text } =
    await import("./certify-gate-b2-bindings.mjs");
  const schema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-report-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const digest = `sha256:${"a".repeat(64)}`;
  const report = {
    schemaVersion: 1,
    gateId: "gate-b2",
    contractVersion: 5,
    manifestDigest: digest,
    generatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    freezeId: "freeze-test",
    certificationRunId: "certification-test",
    mode: "heavy",
    candidate: {
      commitSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      baseMasterSha: "d".repeat(40),
      schemaVersion: 17,
      writerRegistryDigest: digest,
      aiPathRegistryDigest: digest,
      qualityManifestDigest: digest,
      narrativeEvalManifestDigest: digest,
      freezeId: "freeze-test",
      frozen: true,
      dirty: false,
      boundVia: "detached-worktree",
    },
    environment: {
      node: "v20.0.0",
      platform: "linux",
      arch: "x64",
      digest,
    },
    verdict: "BLOCK",
    verdictReasons: ["heavy-web-ai-consent-browser-live blocked"],
    summary: {
      requiredLight: {
        total: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 0,
        deferred: 0,
      },
      requiredHeavy: {
        total: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 0,
        deferred: 0,
      },
      requiredJourneys: {
        total: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 0,
        deferred: 0,
      },
      informational: {
        total: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 0,
        deferred: 0,
      },
      releaseAdjacent: {
        total: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 0,
        deferred: 0,
      },
    },
    suites: [
      {
        suiteId: "fake-heavy-success",
        bucket: "requiredHeavy",
        attempt: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        exitCode: 0,
        environmentDigest: digest,
        commandDigest: digest,
        stdoutDigest: digest,
        stderrDigest: digest,
        artifactDigests: [digest],
        result: "passed",
        message: "passed",
        runId: "00000000-0000-4000-8000-000000000001",
      },
    ],
    retries: [],
    blockedReasons: [],
  };
  const validated = validateJsonAgainstSchema(report, schema);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors, null, 2));

  const missingContractVersion = structuredClone(report);
  delete missingContractVersion.contractVersion;
  const missingValidation = validateJsonAgainstSchema(
    missingContractVersion,
    schema,
  );
  assert.equal(missingValidation.ok, false);
  assert.match(JSON.stringify(missingValidation.errors), /contractVersion/);

  const wrongVersionValidation = validateJsonAgainstSchema(
    { ...report, contractVersion: 4 },
    schema,
  );
  assert.equal(wrongVersionValidation.ok, false);
  assert.match(JSON.stringify(wrongVersionValidation.errors), /contractVersion/);
  assert.equal(typeof sha256Text, "function");
});

test("journey evidence rejects handwritten PASS while journeys remain blocked", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-"));
  try {
    const journeyDir = path.join(temp, "journeys");
    await mkdir(journeyDir, { recursive: true });
    await writeFile(
      path.join(journeyDir, "prepared-plan-toctou.json"),
      JSON.stringify({
        schemaVersion: 1,
        journeyId: "prepared-plan-toctou",
        candidateCommitSha: "a".repeat(40),
        candidateTreeSha: "b".repeat(40),
        runnerId: "gate-b2-prepared-plan-toctou-journey",
        runnerVersion: "1",
        environmentDigest: `sha256:${"c".repeat(64)}`,
        assertions: [
          { id: "source-changed-after-prepare", passed: true },
          { id: "apply-rejected-or-revalidated", passed: true },
        ],
        result: "passed",
        startedAt: "x",
        completedAt: "y",
      }),
      "utf8",
    );
    const { report } = await certifyGateB2({
      repoRoot,
      args: {
        preflight: false,
        runLight: false,
        runHeavy: false,
        runJourneys: true,
        runInformational: false,
        runReleaseAdjacent: false,
        candidate: null,
        baseMaster: null,
        report: path.join(temp, "report.json"),
        artifactDir: path.join(temp, "artifacts"),
        format: "json",
        ciEvidence: null,
        journeyEvidenceDir: journeyDir,
        dryRun: true,
      },
    });
    const journey = report.suites.find(
      (suite) => suite.suiteId === "prepared-plan-toctou",
    );
    assert.equal(journey.result, "blocked");
    assert.match(journey.message, /GATE_B2_OUTPUT_PATH|Implement pnpm/i);
    assert.equal(report.verdict, "BLOCK");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  "prepareWorktreeDependencies runs ADR format validation in detached worktree",
  {
    skip:
      process.env.GATE_B2_WORKTREE_SMOKE !== "1"
        ? "set GATE_B2_WORKTREE_SMOKE=1"
        : false,
  },
  async () => {
    const { spawn } = await import("node:child_process");
    const { prepareWorktreeDependencies } =
      await import("./certify-gate-b2-bindings.mjs");

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

    const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-smoke-"));
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

      const exitCode = await new Promise((resolve) => {
        const child = spawn(
          "node",
          [
            "scripts/quality/validate-gate-b2-adr.mjs",
            "--",
            "--validate-format",
          ],
          { cwd: worktreePath, stdio: "inherit" },
        );
        child.on("exit", (code) => resolve(code ?? 1));
      });
      assert.equal(exitCode, 0);
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
