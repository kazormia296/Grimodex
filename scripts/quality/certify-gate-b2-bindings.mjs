/**
 * Gate B2 certification binding helpers — candidate freeze, secrets, evidence.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER_ENV_ASSIGN =
  /\b([A-Z][A-Z0-9_]*)=\.\.\.(\s+)/g;

export const FREEZE_RELATIVE =
  "evals/certifications/gate-b2-candidate.freeze.json";

export function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Remove `VAR=...` placeholder assignments so parent env credentials are used. */
export function stripCredentialPlaceholders(commandString) {
  return String(commandString).replace(PLACEHOLDER_ENV_ASSIGN, "");
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function loadFreezeDocument(repoRoot) {
  const freezePath = path.join(repoRoot, FREEZE_RELATIVE);
  if (!(await pathExists(freezePath))) return null;
  return JSON.parse(await readFile(freezePath, "utf8"));
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${err || out}`));
        return;
      }
      resolve(out);
    });
  });
}

/**
 * Ensure execution tree matches freeze. Prefer detached worktree at frozen SHA.
 * Returns { executionRoot, cleanup, identity }.
 */
export async function bindExecutionRoot({
  repoRoot,
  candidateSha,
  freeze,
  requireTreeShaMatch = true,
  createWorktree = true,
}) {
  if (!candidateSha || !COMMIT_RE.test(candidateSha)) {
    throw new Error("candidate SHA required for certification binding");
  }
  if (!freeze?.candidate?.commitSha) {
    throw new Error(
      `Freeze file missing at ${FREEZE_RELATIVE}; run pnpm certify:gate-b2:freeze first`,
    );
  }
  if (freeze.candidate.commitSha !== candidateSha) {
    throw new Error(
      `Freeze commit ${freeze.candidate.commitSha} does not match --candidate ${candidateSha}`,
    );
  }

  const headSha = (await runGit(["rev-parse", "HEAD"], repoRoot)).toLowerCase();
  const headTree = (
    await runGit(["rev-parse", "HEAD^{tree}"], repoRoot)
  ).toLowerCase();
  const candidateTree = (
    await runGit(["rev-parse", `${candidateSha}^{tree}`], repoRoot)
  ).toLowerCase();

  if (requireTreeShaMatch && freeze.candidate.treeSha !== candidateTree) {
    throw new Error(
      `Freeze treeSha ${freeze.candidate.treeSha} does not match ${candidateSha}^{tree}=${candidateTree}`,
    );
  }

  // Fast path: already on frozen commit with clean tree — still verify digests later.
  const dirty = Boolean(
    await runGit(["status", "--porcelain"], repoRoot).then((out) => out.length),
  );

  if (
    createWorktree === false &&
    headSha === candidateSha &&
    headTree === freeze.candidate.treeSha &&
    !dirty
  ) {
    return {
      executionRoot: repoRoot,
      cleanup: async () => {},
      identity: {
        commitSha: candidateSha,
        treeSha: freeze.candidate.treeSha,
        dirty: false,
        boundVia: "head-match",
      },
    };
  }

  if (!createWorktree) {
    const mismatches = [];
    if (headSha !== candidateSha) {
      mismatches.push(`HEAD ${headSha} != candidate ${candidateSha}`);
    }
    if (headTree !== freeze.candidate.treeSha) {
      mismatches.push(
        `HEAD tree ${headTree} != freeze tree ${freeze.candidate.treeSha}`,
      );
    }
    if (dirty) mismatches.push("working tree dirty");
    throw new Error(
      `Execution tree is not bound to freeze (${mismatches.join("; ")}). Use detached worktree mode.`,
    );
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-"));
  const worktreePath = path.join(temp, "tree");
  await runGit(
    ["worktree", "add", "--detach", worktreePath, candidateSha],
    repoRoot,
  );
  return {
    executionRoot: worktreePath,
    cleanup: async () => {
      try {
        await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      } catch {
        // best-effort
      }
      await rm(temp, { recursive: true, force: true });
    },
    identity: {
      commitSha: candidateSha,
      treeSha: freeze.candidate.treeSha,
      dirty: false,
      boundVia: "detached-worktree",
    },
  };
}

export function assertDigestsMatchFreeze(currentDigests, freezeCandidate) {
  const errors = [];
  for (const key of [
    "writerRegistryDigest",
    "aiPathRegistryDigest",
    "qualityManifestDigest",
    "narrativeEvalManifestDigest",
    "adrChecklistDigest",
    "classificationDigest",
  ]) {
    const expected = freezeCandidate[key];
    const actual = currentDigests[key];
    if (!expected) continue;
    if (actual !== expected) {
      errors.push(`${key}: freeze=${expected} current=${actual}`);
    }
  }
  return errors;
}

export function sanitizeCertificationEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // Full certification must not use partial/diagnostic overrides.
  delete env.NARRATIVE_EVAL_LIMIT;
  delete env.NARRATIVE_EVAL_CASE_ID;
  delete env.NARRATIVE_EVAL_ATTEMPT;
  return env;
}

const FULL_CI_REQUIRED = [
  "commitSha",
  "treeSha",
  "workflowId",
  "runId",
  "runAttempt",
  "conclusion",
  "requiredJobs",
];

export function validateFullCiEvidence(raw, candidate) {
  const missing = FULL_CI_REQUIRED.filter((key) => {
    if (key === "requiredJobs") {
      return !Array.isArray(raw.requiredJobs) || raw.requiredJobs.length === 0;
    }
    return raw[key] === undefined || raw[key] === null || raw[key] === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci evidence missing required fields: ${missing.join(", ")}`,
    };
  }
  if (raw.commitSha !== candidate.commitSha) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci commitSha ${raw.commitSha} != candidate ${candidate.commitSha}`,
    };
  }
  if (raw.treeSha !== candidate.treeSha) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci treeSha ${raw.treeSha} != candidate ${candidate.treeSha}`,
    };
  }
  const conclusion = String(raw.conclusion).toLowerCase();
  if (conclusion !== "success" && conclusion !== "passed") {
    return {
      ok: false,
      result: "failed",
      message: `full-ci conclusion is ${conclusion}`,
    };
  }
  // Do not accept bare passed:true without structured fields (already required above).
  return { ok: true, result: "passed", message: "full-ci evidence accepted" };
}

const JOURNEY_REQUIRED = [
  "schemaVersion",
  "journeyId",
  "candidateCommitSha",
  "candidateTreeSha",
  "runnerId",
  "runnerVersion",
  "environmentDigest",
  "assertions",
  "result",
  "startedAt",
  "completedAt",
];

export function validateJourneyEvidence(raw, { journeyId, candidate }) {
  const missing = JOURNEY_REQUIRED.filter((key) => {
    if (key === "assertions") {
      return !Array.isArray(raw.assertions) || raw.assertions.length === 0;
    }
    return raw[key] === undefined || raw[key] === null || raw[key] === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      result: "failed",
      message: `journey evidence missing required fields: ${missing.join(", ")}`,
    };
  }
  if (raw.schemaVersion !== 1) {
    return {
      ok: false,
      result: "failed",
      message: "journey schemaVersion must be 1",
    };
  }
  if (raw.journeyId !== journeyId) {
    return {
      ok: false,
      result: "failed",
      message: `journeyId ${raw.journeyId} != filename/manifest ${journeyId}`,
    };
  }
  if (raw.candidateCommitSha !== candidate.commitSha) {
    return {
      ok: false,
      result: "failed",
      message: "journey candidateCommitSha mismatch",
    };
  }
  if (raw.candidateTreeSha !== candidate.treeSha) {
    return {
      ok: false,
      result: "failed",
      message: "journey candidateTreeSha mismatch",
    };
  }
  if (!SHA256_RE.test(String(raw.environmentDigest))) {
    return {
      ok: false,
      result: "failed",
      message: "journey environmentDigest must be sha256:...",
    };
  }
  if (!raw.assertions.every((a) => a && typeof a.id === "string" && a.passed === true)) {
    return {
      ok: false,
      result: "failed",
      message: "journey assertions must all have id and passed:true",
    };
  }
  const result = String(raw.result).toLowerCase();
  if (result === "passed") {
    return { ok: true, result: "passed", message: "journey evidence accepted" };
  }
  if (result === "hold") {
    return { ok: true, result: "hold", message: raw.message ?? "HOLD" };
  }
  if (result === "blocked") {
    return { ok: true, result: "blocked", message: raw.message ?? "BLOCKED" };
  }
  return {
    ok: false,
    result: "failed",
    message: raw.message ?? `journey result=${result}`,
  };
}

export function buildDecisionDocument({
  candidate,
  verdict,
  reasons,
  suites,
  reportDigest,
  digests,
}) {
  const tally = (bucket) => {
    const rows = suites.filter((s) => s.bucket === bucket);
    const counts = {
      passed: 0,
      failed: 0,
      blocked: 0,
      hold: 0,
      notRun: 0,
    };
    for (const row of rows) {
      if (row.result === "passed" || row.result === "informational")
        counts.passed += 1;
      else if (row.result === "failed") counts.failed += 1;
      else if (row.result === "blocked") counts.blocked += 1;
      else if (row.result === "hold") counts.hold += 1;
      else counts.notRun += 1;
    }
    return counts;
  };
  return {
    schemaVersion: 1,
    gateId: "gate-b2",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    baseMasterSha: candidate.baseMasterSha,
    schemaVersionProduct: 16,
    verdict,
    reasons,
    suiteSummaries: {
      requiredLight: tally("requiredLight"),
      requiredHeavy: tally("requiredHeavy"),
      requiredJourneys: tally("requiredJourneys"),
    },
    digests: {
      writerRegistryDigest: digests.writerRegistryDigest,
      aiPathRegistryDigest: digests.aiPathRegistryDigest,
      qualityManifestDigest: digests.qualityManifestDigest,
      narrativeEvalManifestDigest: digests.narrativeEvalManifestDigest,
      adrChecklistDigest: digests.adrChecklistDigest ?? null,
      classificationDigest: digests.classificationDigest ?? null,
      reportDigest,
    },
    heavyAttempts: suites
      .filter((s) => s.bucket === "requiredHeavy" && s.attempt)
      .map((s) => ({
        suiteId: s.suiteId,
        attempt: s.attempt,
        result: s.result,
        normative: s.attempt === 1,
        message: s.message,
      })),
    generatedAt: new Date().toISOString(),
  };
}

export async function readHeavyLiveReport(artifactDir, suiteId, repoRoot = null) {
  const candidates = [
    path.join(artifactDir, "heavy", `${suiteId}.json`),
    path.join(artifactDir, "heavy", suiteId, "report.json"),
  ];
  if (suiteId === "heavy-narrative-chronicle-production" && repoRoot) {
    candidates.push(
      path.join(
        repoRoot,
        ".artifacts/narrative-eval/chronicle-production-live/report.json",
      ),
    );
  }
  if (
    (suiteId === "heavy-web-ai-consent-live" ||
      suiteId === "web-ai-consent-live") &&
    repoRoot
  ) {
    candidates.push(
      path.join(repoRoot, ".artifacts/web-ai-consent-live/report.json"),
    );
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return JSON.parse(await readFile(candidate, "utf8"));
    }
  }
  return null;
}

export function validateChronicleProductionReport(report, candidate) {
  if (!report) {
    return {
      ok: false,
      message: "chronicle production report missing under heavy artifacts",
    };
  }
  if (report.diagnosticOnly === true || report.attempt === 2) {
    return {
      ok: false,
      message: "diagnostic-only / attempt 2 cannot pass certification Heavy",
    };
  }
  if (report.attempt !== 1) {
    return { ok: false, message: `expected attempt 1, got ${report.attempt}` };
  }
  if (report.caseCount !== 14) {
    return {
      ok: false,
      message: `expected caseCount 14, got ${report.caseCount}`,
    };
  }
  if (report.certificationEligible !== true) {
    return {
      ok: false,
      message: "certificationEligible must be true",
    };
  }
  if (
    report.candidateTreeSha &&
    report.candidateTreeSha !== candidate.treeSha
  ) {
    return { ok: false, message: "chronicle report candidateTreeSha mismatch" };
  }
  return { ok: true, message: "chronicle production report accepted" };
}

export function validateWebAiConsentReport(report) {
  if (!report) {
    return { ok: false, message: "web AI consent report missing" };
  }
  if (report.certificationEligible !== true) {
    return { ok: false, message: "consent certificationEligible must be true" };
  }
  const teardown = report.teardown ?? {};
  if (teardown.serverClosed !== true || teardown.localStorageCleared !== true) {
    return {
      ok: false,
      message: "consent teardown flags must be observed true after teardown",
    };
  }
  return { ok: true, message: "consent report accepted" };
}
