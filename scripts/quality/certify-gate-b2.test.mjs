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
  assert.match(packageJson.scripts["test:quality"], /certify-gate-b2\.test\.mjs/);

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
    assert.match(report.candidate.writerRegistryDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(report.candidate.aiPathRegistryDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.summary.requiredHeavy.total, 6);
    assert.equal(report.summary.requiredHeavy.notRun, 6);

    const production = report.suites.find(
      (suite) => suite.suiteId === "heavy-narrative-chronicle-production",
    );
    assert.equal(production.result, "not-run");

    const saved = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(saved.verdict, "INCOMPLETE");
    assert.match(saved.artifactDigests[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(saved.artifactDigests[0].path.endsWith("report.json"), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing heavy runner stays blocked and is not converted to skipped/passed", async () => {
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
    assert.equal(production.result, "blocked");
    assert.match(production.message, /not registered|Runner script/i);
    // Fail-fast retains the first blocker; later required heavies stay not-run.
    assert.ok(
      consent.result === "blocked" || consent.result === "not-run",
      `consent result should be blocked or not-run, got ${consent.result}`,
    );
    assert.notEqual(production.result, "passed");
    assert.notEqual(production.result, "skipped");
    assert.equal(report.verdict, "BLOCK");
    assert.equal(report.firstFailure.suiteId, "heavy-narrative-chronicle-production");
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

test("full-ci evidence mismatch fails rather than skipping", async () => {
  const { certifyGateB2 } = await import("./certify-gate-b2.mjs");
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-ci-"));
  try {
    const evidence = path.join(temp, "full-ci.json");
    await writeFile(
      evidence,
      JSON.stringify({
        commitSha: "c".repeat(40),
        conclusion: "success",
      }),
      "utf8",
    );
    // dry-run light still evaluates full-ci evidence path first entries with commands as not-run,
    // but full-ci uses evidence. Use run-light with dryRun so commands aren't executed.
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
    assert.match(fullCi.message, /does not match candidate/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
