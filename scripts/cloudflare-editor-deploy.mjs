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
    apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev",
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

export function createEditorDeployPlan({ action, environment, apiBaseUrl }) {
  const spec = environmentSpec(environment);

  if (action !== "web-build" && action !== "web-deploy") {
    throw new Error(`unsupported action: ${action}`);
  }
  if (environment === "production") {
    throw new Error(
      action +
        " production is blocked until a canonical reviewed production Worker origin is recorded in repository config",
    );
  }

  const configuredApiBaseUrl = apiBaseUrl ?? spec.apiBaseUrl;
  if (!configuredApiBaseUrl) {
    throw new Error(
      "production Editor build requires an explicit --api-base-url",
    );
  }
  let parsedApiBaseUrl;
  try {
    parsedApiBaseUrl = new URL(configuredApiBaseUrl);
  } catch {
    throw new Error("api-base-url must be an HTTPS origin");
  }
  const normalizedApiBaseUrl = parsedApiBaseUrl.toString().replace(/\/$/, "");
  if (normalizedApiBaseUrl !== spec.apiBaseUrl) {
    throw new Error(
      "api-base-url must exactly match the canonical staging Worker origin: " +
        spec.apiBaseUrl,
    );
  }
  if (
    parsedApiBaseUrl.protocol !== "https:" ||
    parsedApiBaseUrl.username ||
    parsedApiBaseUrl.password ||
    parsedApiBaseUrl.pathname !== "/" ||
    parsedApiBaseUrl.search ||
    parsedApiBaseUrl.hash
  ) {
    throw new Error("api-base-url must be an HTTPS origin");
  }

  const plan = [
    {
      command: "pnpm",
      args: ["build"],
      env: {
        VITE_SCAN_API_BASE_URL: normalizedApiBaseUrl,
      },
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
  const result = { action, environment };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--api-base-url") {
      result.apiBaseUrl = rest[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
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
  node scripts/cloudflare-editor-deploy.mjs web-build staging [--api-base-url <canonical-staging-origin>]
  node scripts/cloudflare-editor-deploy.mjs web-deploy staging [--api-base-url <canonical-staging-origin>]

Production web-build and web-deploy are blocked until a reviewed production Worker origin is recorded in repository config.`);
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
