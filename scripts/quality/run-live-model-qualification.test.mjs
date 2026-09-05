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
  classifyChronicleQualificationReport,
  parseLiveModelQualificationArgs,
  runLiveModelQualification,
  validateLiveModelQualificationManifest,
} from "./run-live-model-qualification.mjs";
import {
  CHRONICLE_PRODUCTION_DIMENSION_SCORE_KEYS,
  CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS,
  CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS,
  CURRENT_NARRATIVE_EVAL_PROTOCOL,
} from "./quality-evaluation-runtime.mjs";

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

function chronicleEvaluation({
  passed = true,
  parseFailureCount = 0,
  unresolvedEvidenceCount = 0,
  criticalViolations = [],
  unobservableDimensions = [],
  dimensions = null,
} = {}) {
  const defaultDimensions = Object.fromEntries(
    CHRONICLE_PRODUCTION_EXPECTED_DIMENSION_KEYS.map((dimension) => [
      dimension,
      Object.fromEntries(
        CHRONICLE_PRODUCTION_DIMENSION_SCORE_KEYS.map((key) => [key, 0]),
      ),
    ]),
  );
  if (!passed) {
    defaultDimensions.eventDetection.falsePositive = 1;
    defaultDimensions.eventDetection.falseNegative = 1;
  }
  return {
    passed,
    parseFailureCount,
    unresolvedEvidenceCount,
    criticalViolations,
    unobservableDimensions,
    dimensions: dimensions ?? defaultDimensions,
  };
}

function chronicleCase({
  passed = true,
  caseId = CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[0],
  evaluation = {},
} = {}) {
  return {
    caseId,
    evidenceMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode,
    receiptMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.receiptMode,
    versions: { ...CURRENT_NARRATIVE_EVAL_PROTOCOL.versions },
    evaluation: chronicleEvaluation({ passed, ...evaluation }),
  };
}

function chronicleFailedCase({
  caseId = CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[0],
  terminalFailure,
} = {}) {
  return {
    caseId,
    evidenceMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode,
    receiptMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.receiptMode,
    versions: { ...CURRENT_NARRATIVE_EVAL_PROTOCOL.versions },
    ...(terminalFailure === undefined ? {} : { terminalFailure }),
  };
}

function chronicleReport({
  cases = Array.from({ length: 14 }, (_, index) =>
    chronicleCase({
      caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
    }),
  ),
  failedCases = [],
  summary = {
    passed: cases.filter((entry) => entry.evaluation?.passed === true).length,
    failed:
      cases.filter((entry) => entry.evaluation?.passed === false).length +
      failedCases.length,
    parseFailureCount: 0,
  },
  ...overrides
} = {}) {
  return {
    mode: "chronicle-production-live",
    evidenceMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode,
    receiptMode: CURRENT_NARRATIVE_EVAL_PROTOCOL.receiptMode,
    versions: { ...CURRENT_NARRATIVE_EVAL_PROTOCOL.versions },
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
    diagnosticOnly: false,
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:01:00.000Z",
    caseCount: cases.length + failedCases.length,
    certificationEligible: false,
    summary,
    cases,
    failedCases,
    ...overrides,
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

test("Chronicle accounting IDs stay bound to the canonical micro corpus", async () => {
  const manifest = yaml.load(
    await readFile(
      path.join(repoRoot, "evals/narrative/manifest.yaml"),
      "utf8",
    ),
  );
  const suite = manifest.suites.find(
    (entry) => entry.id === "chronicle-micro-v1",
  );
  assert.ok(suite);
  const corpus = yaml.load(
    await readFile(
      path.join(repoRoot, "evals/narrative", suite.caseFile),
      "utf8",
    ),
  );
  assert.equal(suite.caseCount, CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS.length);
  assert.deepEqual(
    corpus.cases.map((entry) => entry.id),
    CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS,
  );
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

test("normal qualification pins citation-ID mode despite an ambient legacy selector", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "live-qual-ambient-mode-"));
  let observedMode;
  try {
    const result = await runLiveModelQualification({
      repoRoot,
      args: args(temp, ["heavy-narrative-chronicle-production"]),
      env: {
        OPENROUTER_API_KEY: "test-key",
        NARRATIVE_EVAL_EVIDENCE_MODE: "legacy-v1",
      },
      candidateResolver: fixedCandidate,
      executeCommand: async (_command, _cwd, childEnv) => {
        observedMode = childEnv.NARRATIVE_EVAL_EVIDENCE_MODE;
        assert.equal(childEnv.NARRATIVE_EVAL_SUITE_ID, undefined);
        await writeFile(
          childEnv.QUALITY_EVALUATION_OUTPUT_PATH,
          JSON.stringify(
            chronicleReport({
              candidateCommitSha:
                childEnv.QUALITY_EVALUATION_CANDIDATE_COMMIT_SHA,
              candidateTreeSha: childEnv.QUALITY_EVALUATION_CANDIDATE_TREE_SHA,
              suiteId: childEnv.QUALITY_EVALUATION_SUITE_ID,
              runId: childEnv.QUALITY_EVALUATION_RUN_ID,
              commandDigest: childEnv.QUALITY_EVALUATION_COMMAND_DIGEST,
              certificationEligible: true,
            }),
          ),
          "utf8",
        );
        return capture();
      },
      idFactory: () => "ambient-mode",
      now: fixedNow,
    });
    assert.equal(observedMode, CURRENT_NARRATIVE_EVAL_PROTOCOL.evidenceMode);
    assert.equal(result.report.result, "QUALIFIED");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Chronicle qualification rejects missing, legacy, and drifted current protocol bindings", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const current = chronicleReport();
  for (const [name, report] of [
    ["missing evidence mode", { ...current, evidenceMode: undefined }],
    ["legacy evidence mode", { ...current, evidenceMode: "legacy-v1" }],
    ["missing receipt mode", { ...current, receiptMode: undefined }],
    [
      "old parser version",
      {
        ...current,
        versions: {
          ...current.versions,
          parser: "window-observation-normalizer/1",
        },
      },
    ],
  ]) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", name);
    assert.match(result.message, /mode|version/i, name);
  }
});

test("Chronicle qualification rejects per-case protocol drift and scorer disqualifiers", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const current = chronicleReport();
  const mutateFirstCase = (mutate) =>
    chronicleReport({
      cases: current.cases.map((entry, index) =>
        index === 0 ? mutate(entry) : entry,
      ),
    });
  const protocolReports = [
    [
      "missing per-case evidence mode",
      mutateFirstCase((entry) => ({ ...entry, evidenceMode: undefined })),
    ],
    [
      "legacy per-case evidence mode",
      mutateFirstCase((entry) => ({ ...entry, evidenceMode: "legacy-v1" })),
    ],
    [
      "missing per-case receipt mode",
      mutateFirstCase((entry) => ({ ...entry, receiptMode: undefined })),
    ],
    [
      "drifted per-case parser",
      mutateFirstCase((entry) => ({
        ...entry,
        versions: {
          ...entry.versions,
          parser: "window-observation-normalizer/1",
        },
      })),
    ],
  ];
  for (const [name, report] of protocolReports) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", name);
    assert.match(result.message, /case|mode|version/i, name);
  }

  const cloneDimensions = (evaluation) =>
    Object.fromEntries(
      Object.entries(evaluation.dimensions).map(([dimension, score]) => [
        dimension,
        { ...score },
      ]),
    );
  const scorerReports = [
    [
      "parse failure",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, parseFailureCount: 1 },
      })),
    ],
    [
      "missing parse failure count",
      mutateFirstCase((entry) => {
        const evaluation = { ...entry.evaluation };
        delete evaluation.parseFailureCount;
        return { ...entry, evaluation };
      }),
    ],
    [
      "unresolved evidence",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, unresolvedEvidenceCount: 1 },
      })),
    ],
    [
      "negative unresolved evidence",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, unresolvedEvidenceCount: -1 },
      })),
    ],
    [
      "critical violation",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: {
          ...entry.evaluation,
          passed: false,
          criticalViolations: [{ classId: "critical" }],
        },
      })),
    ],
    [
      "malformed critical violations",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, criticalViolations: {} },
      })),
    ],
    [
      "unobservable dimension list",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: {
          ...entry.evaluation,
          unobservableDimensions: [{ dimension: "eventDetection" }],
        },
      })),
    ],
    [
      "malformed unobservable dimension list",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, unobservableDimensions: {} },
      })),
    ],
    [
      "dimension unobservable score",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.eventDetection.unobservable = 1;
        return { ...entry, evaluation: { ...entry.evaluation, dimensions } };
      }),
    ],
    [
      "missing dimension",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        delete dimensions.actuality;
        return { ...entry, evaluation: { ...entry.evaluation, dimensions } };
      }),
    ],
    [
      "missing dimensions object",
      mutateFirstCase((entry) => ({
        ...entry,
        evaluation: { ...entry.evaluation, dimensions: undefined },
      })),
    ],
    [
      "malformed dimension record",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.actuality = null;
        return { ...entry, evaluation: { ...entry.evaluation, dimensions } };
      }),
    ],
    [
      "malformed dimension score",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.actuality = { ...dimensions.actuality };
        delete dimensions.actuality.unobservable;
        return { ...entry, evaluation: { ...entry.evaluation, dimensions } };
      }),
    ],
    [
      "negative dimension score",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.eventDetection.falsePositive = -1;
        return {
          ...entry,
          evaluation: {
            ...entry.evaluation,
            passed: false,
            dimensions,
          },
        };
      }),
    ],
    [
      "non-integer dimension score",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.eventDetection.truePositive = 0.5;
        return { ...entry, evaluation: { ...entry.evaluation, dimensions } };
      }),
    ],
    [
      "passed consistency mismatch",
      mutateFirstCase((entry) => {
        const dimensions = cloneDimensions(entry.evaluation);
        dimensions.eventDetection.falsePositive = 1;
        dimensions.eventDetection.falseNegative = 1;
        return {
          ...entry,
          evaluation: { ...entry.evaluation, passed: true, dimensions },
        };
      }),
    ],
  ];
  for (const [name, report] of scorerReports) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", name);
    assert.match(
      result.message,
      /case|evaluation|dimension|certification|semantic/i,
      name,
    );
  }
});

test("Chronicle terminal communication and diagnostic parity failures are FAILED even with parseFailureCount zero", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  for (const terminalFailure of [
    {
      kind: "terminal-pipeline-failure",
      stageId: "narrative_observation_extract",
      invocationIndex: 0,
      parseStatus: null,
    },
    {
      kind: "diagnostic-parity-failure",
      dispatchCount: 1,
      diagnosticCount: 0,
      dispatchKeys: ["narrative_observation_extract:0"],
      diagnosticKeys: [],
    },
  ]) {
    const report = chronicleReport({
      cases: Array.from({ length: 13 }, (_, index) =>
        chronicleCase({
          caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
        }),
      ),
      failedCases: [
        chronicleFailedCase({
          caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[13],
          terminalFailure,
        }),
      ],
      summary: { passed: 13, failed: 1, parseFailureCount: 0 },
    });
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED");
    assert.match(result.message, /terminal|failed case|parity|execution/i);
  }
});

test("Chronicle semantic-only threshold miss remains HOLD after complete scoring", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const cases = Array.from({ length: 14 }, (_, index) =>
    chronicleCase({
      caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
      passed: index !== 13,
    }),
  );
  const result = classifyChronicleQualificationReport(
    chronicleReport({
      cases,
      summary: { passed: 13, failed: 1, parseFailureCount: 0 },
    }),
    expected,
    capture({ status: "failed", exitCode: 1 }),
  );
  assert.equal(result.result, "HOLD");
});

test("Chronicle success requires complete current scored cases and a successful harness", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const result = classifyChronicleQualificationReport(
    chronicleReport({
      certificationEligible: true,
      summary: { passed: 14, failed: 0, parseFailureCount: 0 },
    }),
    expected,
    capture({ status: "passed", exitCode: 0 }),
  );
  assert.equal(result.result, "QUALIFIED");
});

test("Chronicle certification eligibility cannot override contradictory case accounting", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const scoredFailure = chronicleReport({
    certificationEligible: true,
    cases: Array.from({ length: 14 }, (_, index) =>
      chronicleCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
        passed: index !== 13,
      }),
    ),
    summary: { passed: 13, failed: 1, parseFailureCount: 0 },
  });
  const terminalFailure = chronicleReport({
    certificationEligible: true,
    cases: chronicleReport().cases.slice(0, 13),
    failedCases: [
      chronicleFailedCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[13],
        terminalFailure: {
          kind: "terminal-pipeline-failure",
          stageId: null,
          invocationIndex: null,
          parseStatus: null,
        },
      }),
    ],
    summary: { passed: 13, failed: 1, parseFailureCount: 0 },
  });
  const parseFailure = chronicleReport({
    certificationEligible: true,
    summary: { passed: 14, failed: 0, parseFailureCount: 1 },
  });
  for (const [name, report] of [
    ["scored semantic failure", scoredFailure],
    ["terminal failed case", terminalFailure],
    ["parser failure", parseFailure],
  ]) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "passed", exitCode: 0 }),
    );
    assert.equal(result.result, "FAILED", name);
  }
});

test("Chronicle qualification rejects duplicate, unknown, missing, and malformed terminal case accounting", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const current = chronicleReport();
  const duplicate = chronicleReport({
    cases: current.cases.map((entry, index) =>
      index === 13
        ? { ...entry, caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[0] }
        : entry,
    ),
  });
  const unknown = chronicleReport({
    cases: current.cases.map((entry, index) =>
      index === 0 ? { ...entry, caseId: "chronicle.micro.unknown-999" } : entry,
    ),
  });
  const missing = chronicleReport({
    cases: current.cases.slice(0, 13),
    caseCount: 14,
  });
  const malformedTerminal = chronicleReport({
    cases: current.cases.slice(0, 13),
    failedCases: [
      chronicleFailedCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[13],
        terminalFailure: { kind: "terminal-pipeline-failure" },
      }),
    ],
    summary: { passed: 13, failed: 1, parseFailureCount: 0 },
  });
  const missingTerminalFailure = chronicleReport({
    cases: current.cases.slice(0, 13),
    failedCases: [
      chronicleFailedCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[13],
      }),
    ],
    summary: { passed: 13, failed: 1, parseFailureCount: 0 },
  });
  for (const [name, report, message] of [
    ["duplicate", duplicate, /duplicate/],
    ["unknown", unknown, /unknown/],
    ["missing", missing, /count|missing/],
    ["malformed terminal", malformedTerminal, /terminalFailure/],
    ["missing terminal failure", missingTerminalFailure, /terminalFailure/],
  ]) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", name);
    assert.match(result.message, message, name);
  }
});

test("Chronicle qualification keeps scored and terminal case shapes disjoint", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const current = chronicleReport();
  for (const [name, terminalFailure] of [
    ["undefined", undefined],
    ["null", null],
    ["malformed", {}],
    [
      "valid",
      {
        kind: "terminal-pipeline-failure",
        stageId: null,
        invocationIndex: null,
        parseStatus: null,
      },
    ],
  ]) {
    const report = chronicleReport({
      cases: current.cases.map((entry, index) =>
        index === 0 ? { ...entry, terminalFailure } : entry,
      ),
    });
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", `scored terminalFailure ${name}`);
    assert.match(result.message, /terminalFailure/, name);
  }

  const crossArrayDuplicate = chronicleReport({
    cases: current.cases.slice(0, 13),
    failedCases: [
      chronicleFailedCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[0],
        terminalFailure: {
          kind: "terminal-pipeline-failure",
          stageId: null,
          invocationIndex: null,
          parseStatus: null,
        },
      }),
    ],
    summary: { passed: 13, failed: 1, parseFailureCount: 0 },
  });
  const duplicateResult = classifyChronicleQualificationReport(
    crossArrayDuplicate,
    expected,
    capture({ status: "failed", exitCode: 1 }),
  );
  assert.equal(duplicateResult.result, "FAILED");
  assert.match(duplicateResult.message, /duplicate/);

  for (const [name, terminalFailure] of [
    [
      "null stage with invocation",
      {
        kind: "terminal-pipeline-failure",
        stageId: null,
        invocationIndex: 0,
        parseStatus: null,
      },
    ],
    [
      "stage with null invocation",
      {
        kind: "terminal-pipeline-failure",
        stageId: "narrative_observation_extract",
        invocationIndex: null,
        parseStatus: null,
      },
    ],
    [
      "parse status without invocation",
      {
        kind: "terminal-pipeline-failure",
        stageId: null,
        invocationIndex: null,
        parseStatus: "invalid",
      },
    ],
  ]) {
    const report = chronicleReport({
      cases: current.cases.slice(0, 13),
      failedCases: [
        chronicleFailedCase({
          caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[13],
          terminalFailure,
        }),
      ],
      summary: { passed: 13, failed: 1, parseFailureCount: 0 },
    });
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED", name);
    assert.match(result.message, /tuple|terminalFailure/);
  }
});

test("Chronicle eligibility cannot hide a failed or non-semantic harness", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const completeSemanticMiss = chronicleReport({
    cases: Array.from({ length: 14 }, (_, index) =>
      chronicleCase({
        caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
        passed: index !== 13,
      }),
    ),
  });
  assert.equal(
    classifyChronicleQualificationReport(
      { ...completeSemanticMiss, certificationEligible: true },
      expected,
      capture({ status: "failed", exitCode: 17 }),
    ).result,
    "FAILED",
  );
  assert.equal(
    classifyChronicleQualificationReport(
      completeSemanticMiss,
      expected,
      capture({ status: "passed", exitCode: 0 }),
    ).result,
    "FAILED",
  );
});

test("Chronicle qualification rejects incomplete case and summary accounting", () => {
  const expected = {
    commitSha: candidate.commitSha,
    treeSha: candidate.treeSha,
    suiteId: "heavy-narrative-chronicle-production",
    runId: "run-1",
    commandDigest: `sha256:${"c".repeat(64)}`,
    attempt: 1,
  };
  const current = chronicleReport();
  for (const report of [
    { ...current, cases: current.cases.slice(0, 13) },
    { ...current, summary: { passed: 14, failed: 1, parseFailureCount: 0 } },
    { ...current, caseCount: 13 },
  ]) {
    const result = classifyChronicleQualificationReport(
      report,
      expected,
      capture({ status: "failed", exitCode: 1 }),
    );
    assert.equal(result.result, "FAILED");
    assert.match(result.message, /case|summary|count|account/i);
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
          JSON.stringify(
            chronicleReport({
              candidateCommitSha:
                childEnv.QUALITY_EVALUATION_CANDIDATE_COMMIT_SHA,
              candidateTreeSha: childEnv.QUALITY_EVALUATION_CANDIDATE_TREE_SHA,
              suiteId: childEnv.QUALITY_EVALUATION_SUITE_ID,
              runId: childEnv.QUALITY_EVALUATION_RUN_ID,
              commandDigest: childEnv.QUALITY_EVALUATION_COMMAND_DIGEST,
              cases: Array.from({ length: 14 }, (_, index) =>
                chronicleCase({
                  caseId: CHRONICLE_PRODUCTION_EXPECTED_CASE_IDS[index],
                  passed: index !== 13,
                }),
              ),
              certificationEligible: false,
            }),
          ),
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
