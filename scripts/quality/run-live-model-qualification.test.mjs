import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import { certifyGateB2, parseCertifyArgs } from "./certify-gate-b2.mjs";
import { validateJsonAgainstSchema } from "./certify-gate-b2-bindings.mjs";
import {
  deriveQualificationResult,
  parseLiveModelQualificationArgs,
  runLiveModelQualification,
  validateLiveModelQualificationManifest,
} from "./run-live-model-qualification.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const candidate = {
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  dirty: false,
};

function args(artifactRoot, suites = ["heavy-agent-tool-loop"]) {
  return parseLiveModelQualificationArgs([
    "--candidate",
    "HEAD",
    "--model",
    "openai/gpt-5.6-luna",
    "--reasoning-effort",
    "medium",
    "--artifact-root",
    artifactRoot,
    ...suites.flatMap((suite) => ["--suite", suite]),
  ]);
}

function capture({
  status = "passed",
  exitCode = 0,
  stdout = "",
  stderr = "",
} = {}) {
  return {
    status,
    exitCode,
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:01.000Z",
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

const fixedNow = () => new Date("2026-08-13T00:00:00.000Z");
const fixedCandidate = async () => candidate;

test("live qualification manifest is local-only and references five Quality Manifest Heavy commands", async () => {
  const manifest = yaml.load(
    await readFile(
      path.join(repoRoot, "evals/qualifications/live-models.yaml"),
      "utf8",
    ),
  );
  const quality = yaml.load(
    await readFile(path.join(repoRoot, "evals/quality-manifest.yaml"), "utf8"),
  );
  const heavyIds = new Set(quality.heavyEvaluations.map((entry) => entry.id));
  assert.deepEqual(validateLiveModelQualificationManifest(manifest), []);
  assert.equal(manifest.executionPolicy.allowGitHubActions, false);
  assert.equal(manifest.executionPolicy.requiredForGateB2, false);
  assert.equal(manifest.executionPolicy.requiredForMerge, false);
  assert.equal(manifest.defaultProfile.length, 5);
  assert.ok(manifest.defaultProfile.every((suiteId) => heavyIds.has(suiteId)));
});

test("GitHub Actions is refused before candidate resolution or child execution", async () => {
  let resolved = 0;
  let executed = 0;
  await assert.rejects(
    () =>
      runLiveModelQualification({
        repoRoot,
        args: args("/tmp/unused-live-qualification"),
        env: { GITHUB_ACTIONS: "true", OPENROUTER_API_KEY: "unused" },
        candidateResolver: async () => {
          resolved += 1;
          return candidate;
        },
        executeCommand: async () => {
          executed += 1;
          return capture();
        },
      }),
    /refuses GitHub Actions/i,
  );
  assert.equal(resolved, 0);
  assert.equal(executed, 0);
});

test("missing credentials yield INCOMPLETE without starting a child", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-missing-"));
  let executed = 0;
  try {
    const result = await runLiveModelQualification({
      repoRoot,
      args: args(temp),
      env: {},
      candidateResolver: fixedCandidate,
      executeCommand: async () => {
        executed += 1;
        return capture();
      },
      idFactory: () => "missing-key",
      now: fixedNow,
    });
    assert.equal(executed, 0);
    assert.equal(result.report.result, "INCOMPLETE");
    assert.equal(result.report.suites.length, 0);
    assert.match(result.report.reasons.join("\n"), /OPENROUTER_API_KEY/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unknown suite is rejected before artifact allocation or child execution", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-unknown-"));
  let executed = 0;
  try {
    await assert.rejects(
      () =>
        runLiveModelQualification({
          repoRoot,
          args: args(temp, ["heavy-does-not-exist"]),
          env: { OPENROUTER_API_KEY: "unused" },
          candidateResolver: fixedCandidate,
          executeCommand: async () => {
            executed += 1;
            return capture();
          },
        }),
      /not allowed by the qualification profile/i,
    );
    assert.equal(executed, 0);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("captured logs, source artifacts, and reports never retain credential values", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-redact-"));
  const secret = "sk-live-super-secret";
  const unrelatedSecret = "sk-unrelated-provider-secret";
  try {
    const result = await runLiveModelQualification({
      repoRoot,
      args: args(temp),
      env: {
        OPENROUTER_API_KEY: secret,
        OPENAI_API_KEY: unrelatedSecret,
        OPEN_ROUTER_API_KEY: "legacy-alias-must-not-propagate",
        GH_TOKEN: "github-token-must-not-propagate",
      },
      candidateResolver: fixedCandidate,
      executeCommand: async (_command, _cwd, childEnv) => {
        assert.equal(childEnv.OPENAI_API_KEY, undefined);
        assert.equal(childEnv.OPEN_ROUTER_API_KEY, undefined);
        assert.equal(childEnv.GH_TOKEN, undefined);
        await writeFile(
          childEnv.QUALITY_EVALUATION_OUTPUT_PATH,
          JSON.stringify({ apiKey: secret, note: `token=${secret}` }),
          "utf8",
        );
        return capture({
          stdout: `Authorization: Bearer ${secret}\n${secret}`,
          stderr: `https://user:${secret}@example.test/?api_key=${secret}\n${unrelatedSecret}`,
        });
      },
      idFactory: () => "redacted",
      now: fixedNow,
    });
    assert.equal(result.report.result, "QUALIFIED");
    const files = await readdir(result.runDir, { recursive: true });
    for (const relative of files) {
      const absolute = path.join(result.runDir, relative);
      if (relative.endsWith(".log") || relative.endsWith(".json")) {
        assert.doesNotMatch(
          await readFile(absolute, "utf8"),
          new RegExp(secret),
        );
        assert.doesNotMatch(
          await readFile(absolute, "utf8"),
          new RegExp(unrelatedSecret),
        );
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("one failed suite prevents an overall QUALIFIED result", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-fail-"));
  try {
    const result = await runLiveModelQualification({
      repoRoot,
      args: args(temp, ["heavy-agent-tool-loop", "heavy-single-shot-surfaces"]),
      env: { OPENROUTER_API_KEY: "test-key" },
      candidateResolver: fixedCandidate,
      executeCommand: async (command) =>
        command.includes("singleShot")
          ? capture({ status: "failed", exitCode: 17, stderr: "failed" })
          : capture(),
      idFactory: () => "one-failure",
      now: fixedNow,
    });
    assert.equal(result.report.result, "FAILED");
    assert.deepEqual(
      result.report.suites.map((suite) => suite.result),
      ["QUALIFIED", "FAILED"],
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reruns allocate independent immutable run directories", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-rerun-"));
  const ids = ["first", "second"];
  try {
    const common = {
      repoRoot,
      args: args(temp),
      env: { OPENROUTER_API_KEY: "test-key" },
      candidateResolver: fixedCandidate,
      executeCommand: async () => capture(),
      idFactory: () => ids.shift(),
      now: fixedNow,
    };
    const first = await runLiveModelQualification(common);
    const second = await runLiveModelQualification(common);
    assert.notEqual(first.runDir, second.runDir);
    assert.equal(
      JSON.parse(await readFile(first.reportPath)).runId.endsWith("first"),
      true,
    );
    assert.equal(
      JSON.parse(await readFile(second.reportPath)).runId.endsWith("second"),
      true,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Chronicle semantic threshold misses become HOLD, not FAILED or QUALIFIED", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-hold-"));
  try {
    const result = await runLiveModelQualification({
      repoRoot,
      args: args(temp, ["heavy-narrative-chronicle-production"]),
      env: { OPENROUTER_API_KEY: "test-key" },
      candidateResolver: fixedCandidate,
      executeCommand: async (_command, _cwd, childEnv) => {
        await writeFile(
          childEnv.QUALITY_EVALUATION_OUTPUT_PATH,
          JSON.stringify({
            schemaVersion: 1,
            mode: "chronicle-production-live",
            candidateCommitSha:
              childEnv.QUALITY_EVALUATION_CANDIDATE_COMMIT_SHA,
            candidateTreeSha: childEnv.QUALITY_EVALUATION_CANDIDATE_TREE_SHA,
            suiteId: childEnv.QUALITY_EVALUATION_SUITE_ID,
            runId: childEnv.QUALITY_EVALUATION_RUN_ID,
            commandDigest: childEnv.QUALITY_EVALUATION_COMMAND_DIGEST,
            attempt: 1,
            diagnosticOnly: false,
            startedAt: "2026-08-13T00:00:00.000Z",
            completedAt: "2026-08-13T00:01:00.000Z",
            caseCount: 14,
            certificationEligible: false,
            summary: { passed: 13, failed: 1, parseFailureCount: 0 },
          }),
          "utf8",
        );
        return capture({ status: "failed", exitCode: 1 });
      },
      idFactory: () => "semantic-hold",
      now: fixedNow,
    });
    assert.equal(result.report.result, "HOLD");
    assert.equal(result.report.suites[0].result, "HOLD");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("result aggregation preserves FAILED over HOLD and never invents execution", () => {
  assert.equal(deriveQualificationResult([]), "INCOMPLETE");
  assert.equal(
    deriveQualificationResult([{ result: "QUALIFIED" }, { result: "HOLD" }]),
    "HOLD",
  );
  assert.equal(
    deriveQualificationResult([{ result: "HOLD" }, { result: "FAILED" }]),
    "FAILED",
  );
});

test("Gate B2 and Live Qualification reports fail each other's schemas", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-schema-"));
  try {
    const live = await runLiveModelQualification({
      repoRoot,
      args: args(path.join(temp, "live")),
      env: { OPENROUTER_API_KEY: "test-key" },
      candidateResolver: fixedCandidate,
      executeCommand: async () => capture(),
      idFactory: () => "schema",
      now: fixedNow,
    });
    const gate = await certifyGateB2({
      repoRoot,
      args: parseCertifyArgs([
        "--preflight",
        "--artifact-dir",
        path.join(temp, "gate"),
        "--report",
        path.join(temp, "gate-report.json"),
        "--format",
        "json",
      ]),
    });
    const gateSchema = JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "evals/certifications/schemas/gate-b2-report-v1.schema.json",
        ),
        "utf8",
      ),
    );
    const liveSchema = JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "evals/qualifications/schemas/live-model-qualification-v1.schema.json",
        ),
        "utf8",
      ),
    );
    assert.equal(validateJsonAgainstSchema(live.report, gateSchema).ok, false);
    const validateLive = new Ajv2020({ strict: false }).compile(liveSchema);
    assert.equal(validateLive(gate.report), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
