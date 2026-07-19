#!/usr/bin/env node

/* global console */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const environments = {
  staging: {
    pagesBranch: "master",
    pagesProject: "grimodex-try-staging",
  },
  production: {
    pagesBranch: "master",
    pagesProject: "grimodex-try",
  },
};

function environmentSpec(environment) {
  const spec = environments[environment];
  if (!spec) {
    throw new Error("environment must be staging or production");
  }
  return spec;
}

export function createEditorDeployPlan({ action, environment }) {
  const spec = environmentSpec(environment);

  if (action !== "web-build" && action !== "web-deploy") {
    throw new Error(`unsupported action: ${action}`);
  }
  const plan = [
    {
      command: "pnpm",
      args: ["build:web-editor"],
    },
  ];
  if (action === "web-deploy") {
    plan.push({
      command: "pnpm",
      args: [
        "exec",
        "wrangler",
        "pages",
        "deploy",
        "dist",
        "--project-name",
        spec.pagesProject,
        "--branch",
        spec.pagesBranch,
      ],
    });
  }
  return plan;
}

function parseArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.includes("--help") || normalized.length === 0) {
    return { help: true };
  }
  const [action, environment, ...rest] = normalized;
  if (rest.length > 0) throw new Error(`unknown argument: ${rest[0]}`);
  return { action, environment };
}

function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...step.env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${step.command} ${step.args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/cloudflare-editor-deploy.mjs web-build <staging|production>
  node scripts/cloudflare-editor-deploy.mjs web-deploy <staging|production>`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const plan = createEditorDeployPlan(args);
  for (const step of plan) runStep(step);
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
