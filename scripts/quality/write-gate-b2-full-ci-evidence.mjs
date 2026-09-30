#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

import { GATE_B2_GITHUB_REPOSITORY } from "./gate-b2-github-attempt.mjs";

const COMMIT_RE = /^[0-9a-f]{40}$/;

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
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
        resolve(Buffer.concat(stdout).toString("utf8").trim());
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

export function buildGateB2FullCiEvidence({
  candidateCommitSha,
  candidateTreeSha,
  run,
  fullCiContract,
}) {
  const candidate = String(candidateCommitSha ?? "").toLowerCase();
  const tree = String(candidateTreeSha ?? "").toLowerCase();
  if (!COMMIT_RE.test(candidate) || !COMMIT_RE.test(tree)) {
    throw new Error("candidate commit/tree must be full lowercase SHAs");
  }
  if (String(run.head_sha ?? "").toLowerCase() !== candidate) {
    throw new Error(
      `CI run head_sha ${run.head_sha ?? "missing"} != ${candidate}`,
    );
  }
  if (String(run.conclusion ?? "").toLowerCase() !== "success") {
    throw new Error(`CI run conclusion is ${run.conclusion ?? "missing"}`);
  }
  if (Number(run.workflow_id) !== Number(fullCiContract.workflowId)) {
    throw new Error(
      `CI workflow_id ${run.workflow_id} != ${fullCiContract.workflowId}`,
    );
  }
  const runPath = String(run.path ?? "").replace(/^\//, "");
  if (
    runPath !== fullCiContract.workflowPath &&
    !runPath.endsWith(fullCiContract.workflowPath)
  ) {
    throw new Error(`CI workflow path ${run.path} is not accepted`);
  }
  if (!fullCiContract.acceptedEvents.includes(run.event)) {
    throw new Error(`CI event ${run.event} is not accepted`);
  }
  if (
    !Number.isInteger(Number(run.run_attempt)) ||
    Number(run.run_attempt) < 1
  ) {
    throw new Error(`CI run_attempt ${run.run_attempt} is invalid`);
  }
  return {
    commitSha: candidate,
    treeSha: tree,
    workflowId: Number(run.workflow_id),
    runId: String(run.id),
    runAttempt: Number(run.run_attempt),
    conclusion: "success",
    requiredJobs: [...fullCiContract.requiredJobs],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const candidateCommitSha = optionValue(argv, "--candidate").toLowerCase();
  const runId = optionValue(argv, "--run-id");
  const outputPath = path.resolve(optionValue(argv, "--output"));
  if (!COMMIT_RE.test(candidateCommitSha)) {
    throw new Error("--candidate must be a full lowercase SHA");
  }
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("--run-id must be a positive GitHub Actions run ID");
  }

  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const manifest = yaml.load(
    await readFile(
      path.join(repoRoot, "evals/certifications/gate-b2.yaml"),
      "utf8",
    ),
  );
  const [candidateTreeSha, runJson] = await Promise.all([
    runCommand("git", ["rev-parse", `${candidateCommitSha}^{tree}`], repoRoot),
    runCommand(
      "gh",
      ["api", `repos/${GATE_B2_GITHUB_REPOSITORY}/actions/runs/${runId}`],
      repoRoot,
    ),
  ]);
  const evidence = buildGateB2FullCiEvidence({
    candidateCommitSha,
    candidateTreeSha,
    run: JSON.parse(runJson),
    fullCiContract: manifest.fullCi,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
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
