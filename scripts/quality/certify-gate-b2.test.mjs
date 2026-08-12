import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  decideVerdict,
  emptyBucketSummary,
  loadGateB2Manifest,
  parseCertifyArgs,
  tallyBucket,
  validateGateB2Manifest,
} from "./certify-gate-b2.mjs";

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
    "heavy-web-ai-consent-live",
  ]);

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
    "node scripts/quality/certify-gate-b2.mjs",
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
        runInformational: false,
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
    assert.match(
      production.command.join(" "),
      /eval:narrative:chronicle:production:live/,
    );
    assert.match(consent.command.join(" "), /eval:web-ai-consent:live/);
    assert.match(production.message, /dry-run/i);
    assert.match(consent.message, /dry-run/i);
    assert.notEqual(production.result, "passed");
    assert.notEqual(consent.result, "skipped");
    assert.equal(report.verdict, "INCOMPLETE");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test("credential shortage for billed heavies is BLOCK not passed/skipped", async () => {
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const freeze = JSON.parse(
    await readFile(
      path.join(repoRoot, "evals/certifications/gate-b2-candidate.freeze.json"),
      "utf8",
    ),
  );
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-cred-"));
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const { report } = await certifyGateB2({
      repoRoot,
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
    const bareCi = bareReport.suites.find((suite) => suite.suiteId === "full-ci");
    assert.equal(bareCi.result, "failed");
    assert.match(bareCi.message, /missing required fields/);

    const evidence = path.join(temp, "full-ci.json");
    await writeFile(
      evidence,
      JSON.stringify({
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        workflowId: "ci.yml",
        runId: "1",
        runAttempt: 1,
        conclusion: "success",
        requiredJobs: ["verify"],
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
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("journey evidence rejects forged passed:true without candidate binding", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-journey-"));
  try {
    const journeyDir = path.join(temp, "journeys");
    await mkdir(journeyDir, { recursive: true });
    await writeFile(
      path.join(journeyDir, "prepared-plan-toctou.json"),
      JSON.stringify({ result: "passed", startedAt: "x", completedAt: "y" }),
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
    assert.equal(journey.result, "failed");
    assert.match(journey.message, /missing required fields/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
