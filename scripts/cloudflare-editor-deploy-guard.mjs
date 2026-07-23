#!/usr/bin/env node

/* global console */

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const gitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isCurrentMasterDeployment(
  workflowRunHeadSha,
  currentMasterSha,
) {
  return (
    gitShaPattern.test(workflowRunHeadSha) &&
    gitShaPattern.test(currentMasterSha) &&
    workflowRunHeadSha.toLowerCase() === currentMasterSha.toLowerCase()
  );
}

function main() {
  const [workflowRunHeadSha = "", currentMasterSha = ""] =
    process.argv.slice(2);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  const deploy = isCurrentMasterDeployment(
    workflowRunHeadSha,
    currentMasterSha,
  );
  appendFileSync(outputPath, `deploy=${deploy}\n`, "utf8");

  if (!deploy) {
    console.log(
      `::notice::Skipping stale deployment ${workflowRunHeadSha}; current master is ${currentMasterSha}.`,
    );
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
