#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildLocalCiPlan,
  validateLocalCiRegistry,
  verifyLocalCiStagingReport,
} from "./local-ci.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const registryPath = path.join(scriptDirectory, "local-ci-registry.json");

function readOptionValue(argv, argument, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function parseArguments(argv) {
  const [profile, ...options] = argv;
  if (profile !== "quick" && profile !== "full") {
    throw new Error(
      "Usage: local-ci-staging-verifier.mjs <quick|full> [options]",
    );
  }
  const result = { base: null, head: null, profile, report: null };
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index];
    if (argument === "--base") {
      result.base = readOptionValue(options, argument, index);
      index += 1;
    } else if (argument === "--head") {
      result.head = readOptionValue(options, argument, index);
      index += 1;
    } else if (argument === "--report") {
      result.report = readOptionValue(options, argument, index);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (result.base === null || result.head === null || result.report === null) {
    throw new Error(
      "Staging verification requires --base, --head, and --report",
    );
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const registry = validateLocalCiRegistry(
    JSON.parse(await readFile(registryPath, "utf8")),
  );
  const plan = buildLocalCiPlan(registry, {
    base: args.base,
    head: args.head,
    profile: args.profile,
    from: null,
  });
  const reportPath = path.resolve(repoRoot, args.report);
  await verifyLocalCiStagingReport({ plan, reportPath, root: repoRoot });
  process.stdout.write(`[local-ci] staging-verified=${reportPath}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `[local-ci] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
