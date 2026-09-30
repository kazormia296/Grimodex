import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const GATE_B2_GITHUB_ATTEMPT_PROVIDER = "github-actions";
export const GATE_B2_GITHUB_REPOSITORY = "kazormia296/Grimodex";
export const GATE_B2_GITHUB_WORKFLOW_PATH =
  ".github/workflows/gate-b2-certification.yml";
export const GATE_B2_GITHUB_WORKFLOW_FILE = "gate-b2-certification.yml";
export const GATE_B2_GITHUB_EVENT = "workflow_dispatch";
export const GATE_B2_GITHUB_RUN_NAME_PREFIX = "Gate B2 candidate";

const COMMIT_RE = /^[0-9a-f]{40}$/;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function gateB2GithubSha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function getGateB2GithubAttemptConfig() {
  const contract = {
    provider: GATE_B2_GITHUB_ATTEMPT_PROVIDER,
    repository: GATE_B2_GITHUB_REPOSITORY,
    workflowPath: GATE_B2_GITHUB_WORKFLOW_PATH,
    event: GATE_B2_GITHUB_EVENT,
    runNamePrefix: GATE_B2_GITHUB_RUN_NAME_PREFIX,
    maxRunsPerCandidate: 1,
    maxRunAttempts: 1,
  };
  return Object.freeze({
    ...contract,
    configDigest: gateB2GithubSha256(canonicalize(contract)),
  });
}

export function getGateB2GithubAttemptIdentity() {
  const config = getGateB2GithubAttemptConfig();
  return Object.freeze({
    provider: config.provider,
    configDigest: config.configDigest,
    repository: config.repository,
    workflowPath: config.workflowPath,
    event: config.event,
    runId: null,
    runAttempt: null,
  });
}

export function gateB2GithubRunName(candidateCommitSha) {
  return `${GATE_B2_GITHUB_RUN_NAME_PREFIX} ${requireCandidateSha(candidateCommitSha)}`;
}

function workflowPathMatches(actual, expected) {
  const normalized = String(actual ?? "").replace(/^\//, "");
  return (
    normalized === expected ||
    normalized.endsWith(`/${expected}`) ||
    normalized.endsWith(expected)
  );
}

function workflowRefMatches(actual, config) {
  const prefix = `${config.repository}/${config.workflowPath}@`;
  return typeof actual === "string" && actual.startsWith(prefix);
}

function requireCandidateSha(candidateCommitSha) {
  const sha = String(candidateCommitSha ?? "").toLowerCase();
  if (!COMMIT_RE.test(sha)) {
    throw new Error(
      "Gate B2 candidate commit SHA must be a full lowercase SHA",
    );
  }
  return sha;
}

export function readGateB2GithubAttemptContext({
  candidateCommitSha,
  env = process.env,
  config = getGateB2GithubAttemptConfig(),
} = {}) {
  const candidate = requireCandidateSha(candidateCommitSha);
  const errors = [];
  if (env.GITHUB_ACTIONS !== "true") {
    errors.push("GITHUB_ACTIONS is not true");
  }
  if (env.GITHUB_REPOSITORY !== config.repository) {
    errors.push(
      `repository ${env.GITHUB_REPOSITORY ?? "missing"} != ${config.repository}`,
    );
  }
  if (env.GITHUB_EVENT_NAME !== config.event) {
    errors.push(
      `event ${env.GITHUB_EVENT_NAME ?? "missing"} != ${config.event}`,
    );
  }
  if (String(env.GATE_B2_CANDIDATE_SHA ?? "").toLowerCase() !== candidate) {
    errors.push(
      `GATE_B2_CANDIDATE_SHA ${env.GATE_B2_CANDIDATE_SHA ?? "missing"} != ${candidate}`,
    );
  }
  if (!workflowRefMatches(env.GITHUB_WORKFLOW_REF, config)) {
    errors.push("GITHUB_WORKFLOW_REF does not identify the Gate B2 workflow");
  }
  if (!/^[1-9][0-9]*$/.test(String(env.GITHUB_RUN_ID ?? ""))) {
    errors.push("GITHUB_RUN_ID is invalid");
  }
  if (Number(env.GITHUB_RUN_ATTEMPT) !== 1) {
    errors.push("GITHUB_RUN_ATTEMPT must be exactly 1");
  }
  if (errors.length > 0) {
    return {
      ok: false,
      message: `Gate B2 execution requires the single-attempt GitHub Actions authority: ${errors.join("; ")}`,
      attemptAuthority: getGateB2GithubAttemptIdentity(),
    };
  }
  return {
    ok: true,
    message: "Gate B2 GitHub Actions execution context accepted",
    attemptAuthority: {
      ...getGateB2GithubAttemptIdentity(),
      runId: String(env.GITHUB_RUN_ID),
      runAttempt: 1,
    },
  };
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

async function defaultListWorkflowRuns({ config, repoRoot }) {
  const runs = [];
  for (let page = 1; page <= 50; page += 1) {
    const json = await runCommand(
      "gh",
      [
        "api",
        `repos/${config.repository}/actions/workflows/${GATE_B2_GITHUB_WORKFLOW_FILE}/runs?event=${config.event}&per_page=100&page=${page}`,
      ],
      repoRoot,
    );
    const payload = JSON.parse(json);
    const batch = payload.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
  throw new Error("Gate B2 workflow run listing exceeded pagination limit");
}

function matchingCandidateRuns(runs, candidateCommitSha, config) {
  return runs.filter(
    (run) =>
      run.display_title === gateB2GithubRunName(candidateCommitSha) &&
      run.event === config.event &&
      workflowPathMatches(run.path, config.workflowPath),
  );
}

export async function verifyGateB2GithubAttemptAdmission({
  candidateCommitSha,
  currentRunId,
  currentRunAttempt,
  repoRoot = process.cwd(),
  config = getGateB2GithubAttemptConfig(),
  listWorkflowRuns = defaultListWorkflowRuns,
} = {}) {
  const candidate = requireCandidateSha(candidateCommitSha);
  const runs = matchingCandidateRuns(
    await listWorkflowRuns({ config, repoRoot }),
    candidate,
    config,
  );
  if (runs.length !== 1) {
    return {
      ok: false,
      message: `Gate B2 candidate ${candidate} must have exactly one workflow_dispatch run; found ${runs.length}`,
      runs,
    };
  }
  const run = runs[0];
  if (String(run.id) !== String(currentRunId)) {
    return {
      ok: false,
      message: `Gate B2 candidate already belongs to run ${run.id}; current run is ${currentRunId}`,
      runs,
    };
  }
  if (Number(currentRunAttempt) !== 1 || Number(run.run_attempt) !== 1) {
    return {
      ok: false,
      message: "Gate B2 reruns are not normative; create a new candidate SHA",
      runs,
    };
  }
  if (
    run.status === "completed" &&
    String(run.conclusion).toLowerCase() !== "success"
  ) {
    return {
      ok: false,
      message: `Gate B2 candidate already has a completed ${run.conclusion} run`,
      runs,
    };
  }
  return {
    ok: true,
    message: "Gate B2 candidate has one first-attempt workflow run",
    run,
  };
}

function parseCliCandidate(argv) {
  const index = argv.indexOf("--candidate");
  if (index === -1) return process.env.GATE_B2_CANDIDATE_SHA;
  if (!argv[index + 1]) throw new Error("--candidate requires a value");
  return argv[index + 1];
}

async function main() {
  const candidateCommitSha = parseCliCandidate(process.argv.slice(2));
  const context = readGateB2GithubAttemptContext({ candidateCommitSha });
  if (!context.ok) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await verifyGateB2GithubAttemptAdmission({
    candidateCommitSha,
    currentRunId: process.env.GITHUB_RUN_ID,
    currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
