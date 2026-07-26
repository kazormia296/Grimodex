import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validatePackageVersion,
  validateReleaseVersion,
} from "./validate-release-version.mjs";

export const RELEASE_BUILD_TARGETS = Object.freeze([
  Object.freeze({
    id: "linux",
    os: "ubuntu-24.04",
    artifact: "electron-linux",
    updaterMetadata: "latest-linux.yml",
  }),
  Object.freeze({
    id: "mac",
    os: "macos-15",
    artifact: "electron-mac",
    updaterMetadata: "latest-mac.yml",
  }),
  Object.freeze({
    id: "windows",
    os: "windows-latest",
    artifact: "electron-windows",
    updaterMetadata: "latest.yml",
  }),
]);

const DEBUG_TARGETS = new Set([
  "windows",
  "mac",
  "linux",
  "publish",
  "all",
]);
const SECRET_BACKED_TARGETS = new Set(["mac", "publish", "all"]);

function copyTargets(target) {
  if (target === "publish") return [];
  const selected =
    target === "all"
      ? RELEASE_BUILD_TARGETS
      : RELEASE_BUILD_TARGETS.filter((entry) => entry.id === target);
  return selected.map((entry) => ({ ...entry }));
}

function parseBoolean(value, name) {
  if (value === true || value === false) return value;
  if (value === "" || value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false: ${String(value)}`);
}

export function resolveReleaseWorkflow({
  eventName,
  refName,
  refType,
  packageVersion,
  basePackageVersion,
  expectedMajor,
  defaultBranch,
  candidateRef,
  candidateSha,
  target,
  publishRequested,
  sourceRunId,
}) {
  const requestedPublish = parseBoolean(publishRequested, "publish");
  const normalizedSourceRunId = String(sourceRunId ?? "").trim();
  const normalizedCandidateRef = String(candidateRef ?? "").trim();
  const normalizedCandidateSha = String(candidateSha ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(normalizedCandidateSha)) {
    throw new Error(
      `Candidate SHA must be a full 40-character commit SHA: ${normalizedCandidateSha}`,
    );
  }

  if (eventName === "push") {
    const release = validateReleaseVersion({
      tag: refName,
      packageVersion,
      expectedMajor,
      refType,
    });
    return {
      mode: "release",
      ...release,
      target: "all",
      runBuild: true,
      shouldPublish: true,
      sourceRunId: "",
      candidateRef: refName,
      candidateSha: normalizedCandidateSha,
      checkoutRef: refName,
      matrix: { include: copyTargets("all") },
    };
  }

  if (eventName !== "workflow_dispatch") {
    throw new Error(`Unsupported release workflow event: ${eventName}`);
  }
  if (requestedPublish) {
    throw new Error(
      "Manual release debugging cannot publish; use an exact v2 tag push only after focused gates pass.",
    );
  }
  if (refType !== "branch" || refName !== defaultBranch) {
    throw new Error(
      `Manual release debugging must dispatch the trusted default branch workflow: ${defaultBranch}`,
    );
  }
  if (!normalizedCandidateRef) {
    throw new Error("candidate ref is required for manual release debugging.");
  }

  const normalizedTarget = target || "windows";
  if (!DEBUG_TARGETS.has(normalizedTarget)) {
    throw new Error(`Unsupported release debug target: ${normalizedTarget}`);
  }
  if (
    SECRET_BACKED_TARGETS.has(normalizedTarget) &&
    normalizedCandidateRef !== defaultBranch
  ) {
    throw new Error(
      `The ${normalizedTarget} target uses release secrets, so its candidate ref must be the default branch: ${defaultBranch}`,
    );
  }
  if (
    !SECRET_BACKED_TARGETS.has(normalizedTarget) &&
    normalizedCandidateRef !== defaultBranch &&
    !/^[0-9a-f]{40}$/i.test(normalizedCandidateRef)
  ) {
    throw new Error(
      `The ${normalizedTarget} target candidate ref must be the default branch or a full 40-character commit SHA.`,
    );
  }
  if (
    /^[0-9a-f]{40}$/i.test(normalizedCandidateRef) &&
    normalizedCandidateRef.toLowerCase() !== normalizedCandidateSha.toLowerCase()
  ) {
    throw new Error(
      `Candidate ref SHA does not match the checked out candidate SHA: requested ${normalizedCandidateRef}, resolved ${normalizedCandidateSha}`,
    );
  }

  const baseVersion = validatePackageVersion({
    packageVersion: basePackageVersion,
    expectedMajor,
  });
  const candidateVersion = validatePackageVersion({
    packageVersion,
    expectedMajor,
  });
  if (candidateVersion.version !== baseVersion.version) {
    throw new Error(
      `Release debugging must not change package.json version: default branch ${baseVersion.version}, candidate ${candidateVersion.version}`,
    );
  }
  const version = {
    tag: `v${candidateVersion.version}`,
    ...candidateVersion,
  };

  if (normalizedTarget === "publish") {
    if (!/^[1-9]\d*$/.test(normalizedSourceRunId)) {
      throw new Error(
        "A numeric source run ID is required for publish-stage debugging.",
      );
    }
    if (version.prerelease) {
      throw new Error(
        "The Tauri v1 bridge publish debug target is only valid for a stable version.",
      );
    }
  } else if (normalizedSourceRunId) {
    throw new Error("source run ID is only valid for the publish target.");
  }

  return {
    mode: "debug",
    ...version,
    target: normalizedTarget,
    runBuild: normalizedTarget !== "publish",
    shouldPublish: false,
    sourceRunId: normalizedSourceRunId,
    candidateRef: normalizedCandidateRef,
    candidateSha: normalizedCandidateSha,
    checkoutRef: normalizedCandidateSha,
    matrix: { include: copyTargets(normalizedTarget) },
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid arguments near: ${key ?? "<end>"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packagePath = path.resolve(args.package ?? "package.json");
  const basePackagePath = path.resolve(
    args["base-package"] ?? args.package ?? "package.json",
  );
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const basePkg = JSON.parse(await readFile(basePackagePath, "utf8"));
  const expectedMajor = Number.parseInt(args.major ?? "2", 10);
  if (!Number.isInteger(expectedMajor) || expectedMajor < 0) {
    throw new Error(`--major must be a non-negative integer: ${args.major}`);
  }

  const result = resolveReleaseWorkflow({
    eventName: args.event ?? "",
    refName: args["ref-name"] ?? "",
    refType: args["ref-type"] ?? "",
    packageVersion: pkg.version,
    basePackageVersion: basePkg.version,
    expectedMajor,
    defaultBranch: args["default-branch"] ?? "",
    candidateRef: args["candidate-ref"] ?? "",
    candidateSha: args["candidate-sha"] ?? "",
    target: args.target ?? "",
    publishRequested: args.publish ?? "false",
    sourceRunId: args["source-run-id"] ?? "",
  });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `mode=${result.mode}`,
        `tag=${result.tag}`,
        `version=${result.version}`,
        `major=${result.major}`,
        `prerelease=${String(result.prerelease)}`,
        `target=${result.target}`,
        `run_build=${String(result.runBuild)}`,
        `should_publish=${String(result.shouldPublish)}`,
        `source_run_id=${result.sourceRunId}`,
        `candidate_ref=${result.candidateRef}`,
        `candidate_sha=${result.candidateSha}`,
        `checkout_ref=${result.checkoutRef}`,
        `matrix=${JSON.stringify(result.matrix)}`,
        "",
      ].join("\n"),
    );
  }
  console.log(JSON.stringify(result));
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
