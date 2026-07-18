#!/usr/bin/env node

/* global AbortSignal, console, fetch */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const environments = {
  staging: {
    bucketName: "grimodex-scan-staging",
    config: "apps/scan-web/wrangler.staging.jsonc",
    databaseName: "grimodex-scan-staging",
    editorOrigin: "https://grimodex-try-staging.pages.dev",
    expectedApiOrigin: "https://grimodex-scan-staging.kazormia296.workers.dev",
    pagesBranch: "master",
    pagesOrigin: "https://grimodex-scan-staging.pages.dev",
    pagesProject: "grimodex-scan-staging",
    turnstileRequired: false,
    workerName: "grimodex-scan-staging",
    workflowName: "grimodex-scan-staging-workflow",
  },
  production: {
    bucketName: "grimodex-scan-production",
    config: "apps/scan-web/wrangler.production.jsonc",
    databaseName: "grimodex-scan-production",
    editorOrigin: "https://try.grimodex.app",
    pagesBranch: "master",
    pagesOrigin: "https://scan.grimodex.app",
    pagesProject: "grimodex-scan",
    turnstileRequired: true,
    workerName: "grimodex-scan-production",
    workflowName: "grimodex-scan-production-workflow",
  },
};

const productionMutations = new Set(["migrate", "worker-deploy", "web-deploy"]);
const productionHttpDeployments = new Set([
  "worker-deploy",
  "web-build",
  "web-deploy",
]);

function environmentSpec(environment) {
  const spec = environments[environment];
  if (!spec) {
    throw new Error("environment must be staging or production");
  }
  return spec;
}

function formatJsonPath(pathSegments) {
  return pathSegments.reduce(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : result
          ? `${result}.${segment}`
          : segment,
    "",
  );
}

function rejectDuplicateKeys(node, pathSegments = []) {
  if (node.type === "object") {
    const seen = new Set();
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      if (typeof keyNode?.value !== "string" || !valueNode) {
        throw new Error("Wrangler config contains an invalid object property");
      }
      const propertyPath = [...pathSegments, keyNode.value];
      if (seen.has(keyNode.value)) {
        throw new Error(
          `Wrangler config contains duplicate key ${formatJsonPath(propertyPath)}`,
        );
      }
      seen.add(keyNode.value);
      rejectDuplicateKeys(valueNode, propertyPath);
    }
    return;
  }
  if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      rejectDuplicateKeys(child, [...pathSegments, index]);
    }
  }
}

function parseJsoncObject(configText) {
  const errors = [];
  const root = parseTree(configText, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!root || errors.length > 0) {
    const firstError = errors[0];
    const detail = firstError
      ? `${printParseErrorCode(firstError.error)} at offset ${firstError.offset}`
      : "empty document";
    throw new Error(`Wrangler config is invalid JSONC: ${detail}`);
  }
  if (root.type !== "object") {
    throw new Error("Wrangler config root must be an object");
  }
  rejectDuplicateKeys(root);
  return getNodeValue(root);
}

function requiredString(value, pathLabel) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${pathLabel} is missing from Wrangler config`);
  }
  return value;
}

function requiredSingleBinding(config, sectionKey, bindingName) {
  const entries = config[sectionKey];
  if (!Array.isArray(entries)) {
    throw new Error(`${sectionKey} is missing from Wrangler config`);
  }
  const matches = entries.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.binding === bindingName,
  );
  if (entries.length !== 1 || matches.length !== 1) {
    throw new Error(
      `${sectionKey} must contain exactly one ${bindingName} binding`,
    );
  }
  return matches[0];
}

export function validateScanDeployConfig({
  environment,
  configText,
  allowProductionTraffic = false,
}) {
  const spec = environmentSpec(environment);
  const config = parseJsoncObject(configText);
  const vars = config.vars;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    throw new Error("vars is missing from Wrangler config");
  }
  const database = requiredSingleBinding(config, "d1_databases", "DB");
  const bucket = requiredSingleBinding(config, "r2_buckets", "SCAN_BUCKET");
  const workflow = requiredSingleBinding(config, "workflows", "SCAN_WORKFLOW");
  const workerName = requiredString(config.name, "name");
  const scanEnvironment = requiredString(
    vars.SCAN_ENVIRONMENT,
    "SCAN_ENVIRONMENT",
  );
  const databaseName = requiredString(database.database_name, "database_name");
  const databaseId = requiredString(database.database_id, "database_id");
  const bucketName = requiredString(bucket.bucket_name, "bucket_name");
  const workflowName = requiredString(workflow.name, "workflows.name");
  const allowedOriginsValue = requiredString(
    vars.ALLOWED_ORIGINS,
    "ALLOWED_ORIGINS",
  );
  const allowedOrigins = allowedOriginsValue.split(",");
  const expectedAllowedOrigins = [spec.pagesOrigin, spec.editorOrigin];
  const acceptingNewJobsValue = requiredString(
    vars.SCAN_ACCEPTING_NEW_JOBS,
    "SCAN_ACCEPTING_NEW_JOBS",
  );
  if (!["true", "false"].includes(acceptingNewJobsValue)) {
    throw new Error("SCAN_ACCEPTING_NEW_JOBS must be true or false");
  }
  const acceptingNewJobs = acceptingNewJobsValue === "true";

  if (/replace-with|placeholder/i.test(configText)) {
    throw new Error(
      `${environment} Wrangler config still contains a placeholder`,
    );
  }

  if (workerName !== spec.workerName) {
    throw new Error(
      `Worker name mismatch: expected ${spec.workerName}, received ${workerName}`,
    );
  }
  if (scanEnvironment !== environment) {
    throw new Error(
      `SCAN_ENVIRONMENT mismatch: expected ${environment}, received ${scanEnvironment}`,
    );
  }
  if (databaseName !== spec.databaseName) {
    throw new Error(
      `${environment} database_name must be ${spec.databaseName}`,
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      databaseId,
    )
  ) {
    throw new Error(`${environment} database_id must be a concrete D1 UUID`);
  }
  if (bucketName !== spec.bucketName) {
    throw new Error(`${environment} bucket_name must be ${spec.bucketName}`);
  }
  if (workflowName !== spec.workflowName) {
    throw new Error(
      `${environment} workflow name must be ${spec.workflowName}`,
    );
  }
  if (
    allowedOrigins.length !== expectedAllowedOrigins.length ||
    allowedOrigins.some(
      (origin, index) => origin !== expectedAllowedOrigins[index],
    )
  ) {
    throw new Error(
      `${environment} ALLOWED_ORIGINS must be ${expectedAllowedOrigins.join(",")}`,
    );
  }
  if (environment === "staging" && acceptingNewJobs) {
    throw new Error(
      "staging traffic activation is not supported by this deploy CLI",
    );
  }
  if (
    environment === "production" &&
    acceptingNewJobs &&
    !allowProductionTraffic
  ) {
    throw new Error(
      "production traffic is enabled; pass --allow-production-traffic only after smoke checks",
    );
  }

  return {
    acceptingNewJobs,
    allowedOrigins,
    bucketName,
    databaseId,
    databaseName,
    scanEnvironment,
    workerName,
    workflowName,
  };
}

function parseRemoteInfo(infoText, label) {
  let info;
  try {
    info = JSON.parse(infoText);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new Error(`${label} returned an invalid object`);
  }
  return info;
}

export function validateRemoteD1Info({ environment, databaseId, infoText }) {
  const spec = environmentSpec(environment);
  const info = parseRemoteInfo(infoText, "D1 info");
  if (info.name !== spec.databaseName || info.uuid !== databaseId) {
    throw new Error(
      `${environment} D1 binding does not match remote ${spec.databaseName}`,
    );
  }
  return { name: info.name, uuid: info.uuid };
}

export function validateRemoteR2Info({ environment, infoText }) {
  const spec = environmentSpec(environment);
  const info = parseRemoteInfo(infoText, "R2 info");
  if (info.name !== spec.bucketName) {
    throw new Error(
      `${environment} R2 binding does not match remote ${spec.bucketName}`,
    );
  }
  return { name: info.name };
}

function assertHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be an HTTPS origin without credentials or a path`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function assertScanApiUrl(value, environment) {
  const origin = assertHttpsUrl(value, "--api-base-url");
  if (environment !== "staging") return origin;

  const spec = environmentSpec(environment);
  if (origin !== spec.expectedApiOrigin) {
    throw new Error(
      `--api-base-url must match the staging Worker URL ${spec.expectedApiOrigin}`,
    );
  }
  return origin;
}

export function createScanDeployPlan({
  action,
  environment,
  apiBaseUrl,
  turnstileSiteKey,
  allowProduction = false,
}) {
  const spec = environmentSpec(environment);
  if (
    environment === "production" &&
    productionMutations.has(action) &&
    !allowProduction
  ) {
    throw new Error(
      `${action} production requires the explicit --allow-production flag`,
    );
  }
  if (environment === "production" && productionHttpDeployments.has(action)) {
    throw new Error(
      "production HTTP deployment is blocked until a custom Worker route is configured",
    );
  }

  if (action === "check") return [];
  if (action === "remote-check" || action === "smoke") return [];
  if (action === "migrate") {
    return [
      {
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          spec.config,
        ],
      },
    ];
  }
  if (action === "worker-dry-run" || action === "worker-deploy") {
    const deployArgs = ["exec", "wrangler", "deploy"];
    if (action === "worker-dry-run") deployArgs.push("--dry-run");
    deployArgs.push("--config", spec.config);
    return [
      { command: "pnpm", args: ["build:scan:dependencies"] },
      { command: "pnpm", args: deployArgs },
    ];
  }
  if (action === "web-build" || action === "web-deploy") {
    const normalizedApiBaseUrl = assertScanApiUrl(apiBaseUrl, environment);
    if (spec.turnstileRequired && !turnstileSiteKey?.trim()) {
      throw new Error("production web deploy requires a Turnstile site key");
    }
    const buildEnvironment = {
      VITE_EDITOR_BASE_URL: `${spec.editorOrigin}/editor`,
      VITE_SCAN_API_BASE_URL: normalizedApiBaseUrl,
      VITE_SCAN_TURNSTILE_REQUIRED: String(spec.turnstileRequired),
      ...(turnstileSiteKey?.trim()
        ? { VITE_SCAN_TURNSTILE_SITE_KEY: turnstileSiteKey.trim() }
        : {}),
    };
    const plan = [
      {
        command: "pnpm",
        args: ["build:scan"],
        env: buildEnvironment,
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
          "apps/scan-web/dist",
          "--project-name",
          spec.pagesProject,
          "--branch",
          spec.pagesBranch,
        ],
      });
    }
    return plan;
  }
  throw new Error(`unsupported action: ${action}`);
}

function parseArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.includes("--help") || normalized.length === 0) {
    return { help: true };
  }
  const [action, environment, ...rest] = normalized;
  const result = {
    action,
    environment,
    allowProduction: false,
    allowProductionTraffic: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--allow-production") {
      result.allowProduction = true;
      continue;
    }
    if (argument === "--allow-production-traffic") {
      result.allowProductionTraffic = true;
      continue;
    }
    if (argument === "--api-base-url") {
      result.apiBaseUrl = rest[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--turnstile-site-key") {
      result.turnstileSiteKey = rest[index + 1];
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

function runCapturedStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...step.env },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${step.command} ${step.args.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function verifyRemoteD1(environment, validated) {
  const spec = environmentSpec(environment);
  const infoText = runCapturedStep({
    command: "pnpm",
    args: ["exec", "wrangler", "d1", "info", spec.databaseName, "--json"],
  });
  validateRemoteD1Info({
    environment,
    databaseId: validated.databaseId,
    infoText,
  });
}

function verifyRemoteR2(environment) {
  const spec = environmentSpec(environment);
  const infoText = runCapturedStep({
    command: "pnpm",
    args: [
      "exec",
      "wrangler",
      "r2",
      "bucket",
      "info",
      spec.bucketName,
      "--json",
    ],
  });
  validateRemoteR2Info({ environment, infoText });
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(
      `${label} returned HTTP ${response.status}, expected ${expected}`,
    );
  }
}

function expectContentType(response, expectedTypes, label) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!contentType || !expectedTypes.includes(contentType)) {
    throw new Error(
      `${label} returned unexpected content type ${contentType ?? "(missing)"}`,
    );
  }
}

export async function runScanSmokeChecks({
  environment,
  apiBaseUrl,
  fetchImpl = fetch,
}) {
  const spec = environmentSpec(environment);
  const api = assertScanApiUrl(apiBaseUrl, environment);
  const requestOptions = (overrides = {}) => ({
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...overrides,
  });

  const health = await fetchImpl(
    `${api}/api/v1/health`,
    requestOptions({
      headers: { origin: spec.pagesOrigin },
    }),
  );
  expectStatus(health, 200, "health check");
  if (health.headers.get("access-control-allow-origin") !== spec.pagesOrigin) {
    throw new Error(
      "health check did not return the exact allowed CORS origin",
    );
  }
  const healthBody = await health.json();
  if (
    healthBody?.ok !== true ||
    healthBody?.service !== "grimodex-scan" ||
    healthBody?.acceptingNewJobs !== false
  ) {
    throw new Error(
      "health check did not report a paused grimodex-scan Worker",
    );
  }

  const preflightHeaders = {
    origin: spec.pagesOrigin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  };
  const allowedPreflight = await fetchImpl(
    `${api}/api/v1/upload-intents`,
    requestOptions({
      method: "OPTIONS",
      headers: preflightHeaders,
    }),
  );
  expectStatus(allowedPreflight, 204, "allowed CORS preflight");
  if (
    allowedPreflight.headers.get("access-control-allow-origin") !==
    spec.pagesOrigin
  ) {
    throw new Error("allowed CORS preflight did not return the exact origin");
  }

  const editorPreflight = await fetchImpl(
    `${api}/api/v1/editor-ai`,
    requestOptions({
      method: "OPTIONS",
      headers: { ...preflightHeaders, origin: spec.editorOrigin },
    }),
  );
  expectStatus(editorPreflight, 204, "Editor CORS preflight");
  if (
    editorPreflight.headers.get("access-control-allow-origin") !==
    spec.editorOrigin
  ) {
    throw new Error("Editor CORS preflight did not return the exact origin");
  }

  const hostilePreflight = await fetchImpl(
    `${api}/api/v1/upload-intents`,
    requestOptions({
      method: "OPTIONS",
      headers: { ...preflightHeaders, origin: "https://hostile.invalid" },
    }),
  );
  expectStatus(hostilePreflight, 204, "hostile CORS preflight");
  if (hostilePreflight.headers.has("access-control-allow-origin")) {
    throw new Error("hostile CORS preflight was granted an allowed origin");
  }

  const pausedUpload = await fetchImpl(
    `${api}/api/v1/upload-intents`,
    requestOptions({
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: spec.pagesOrigin,
      },
      body: JSON.stringify({
        filename: "smoke-test.txt",
        contentType: "text/plain",
        size: 1,
      }),
    }),
  );
  expectStatus(pausedUpload, 503, "paused upload check");
  if (
    pausedUpload.headers.get("access-control-allow-origin") !== spec.pagesOrigin
  ) {
    throw new Error("paused upload check did not return the exact CORS origin");
  }
  const pausedBody = await pausedUpload.json();
  if (pausedBody?.error?.code !== "scan_paused") {
    throw new Error("paused upload check did not return scan_paused");
  }

  const index = await fetchImpl(`${spec.pagesOrigin}/`, requestOptions());
  expectStatus(index, 200, "Pages index");
  expectContentType(index, ["text/html"], "Pages index");
  const indexHtml = await index.text();
  if (
    !/<title>\s*Grimodex Scan\s*<\/title>/iu.test(indexHtml) ||
    !/<div[^>]+\bid=["']root["'][^>]*>/iu.test(indexHtml)
  ) {
    throw new Error("Pages index is not the Grimodex Scan app shell");
  }

  const manifest = await fetchImpl(
    `${spec.pagesOrigin}/manifest.webmanifest`,
    requestOptions(),
  );
  expectStatus(manifest, 200, "Pages manifest");
  expectContentType(
    manifest,
    ["application/manifest+json", "application/json"],
    "Pages manifest",
  );
  let manifestBody;
  try {
    manifestBody = await manifest.json();
  } catch {
    throw new Error("Pages manifest did not contain valid JSON");
  }
  if (
    manifestBody?.name !== "Grimodex Scan" ||
    manifestBody?.short_name !== "Grimodex" ||
    manifestBody?.start_url !== "." ||
    manifestBody?.display !== "standalone"
  ) {
    throw new Error("Pages manifest does not match Grimodex Scan");
  }

  const serviceWorkerResponse = await fetchImpl(
    `${spec.pagesOrigin}/sw.js`,
    requestOptions(),
  );
  expectStatus(serviceWorkerResponse, 200, "Pages service worker");
  expectContentType(
    serviceWorkerResponse,
    ["application/javascript", "text/javascript"],
    "Pages service worker",
  );
  const serviceWorker = await serviceWorkerResponse.text();
  if (
    serviceWorker.includes("__GRIMODEX_SCAN_BUILD__") ||
    !serviceWorker.includes('CACHE_PREFIX = "grimodex-scan-shell-"') ||
    !serviceWorker.includes('self.addEventListener("fetch"')
  ) {
    throw new Error("deployed service worker is not a stamped Scan worker");
  }

  return {
    acceptingNewJobs: false,
    apiBaseUrl: api,
    editorOrigin: spec.editorOrigin,
    pagesOrigin: spec.pagesOrigin,
  };
}

function printHelp() {
  console.log(`Usage:
  pnpm scan:cloudflare -- check <staging|production>
  pnpm scan:cloudflare -- remote-check <staging|production>
  pnpm scan:cloudflare -- migrate <staging|production> [--allow-production]
  pnpm scan:cloudflare -- worker-dry-run <staging|production>
  pnpm scan:cloudflare -- worker-deploy <staging|production> [--allow-production] [--allow-production-traffic]
  pnpm scan:cloudflare -- web-build <staging|production> --api-base-url <url>
  pnpm scan:cloudflare -- web-deploy <staging|production> --api-base-url <url> [--turnstile-site-key <key>] [--allow-production]
  pnpm scan:cloudflare -- smoke <staging|production> --api-base-url <url>

Production worker/web HTTP deploys are blocked until a custom Worker route is configured.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const spec = environmentSpec(args.environment);
  const configText = await readFile(
    path.join(repositoryRoot, spec.config),
    "utf8",
  );
  const validated = validateScanDeployConfig({
    environment: args.environment,
    configText,
    allowProductionTraffic: args.allowProductionTraffic,
  });
  console.log(JSON.stringify({ environment: args.environment, ...validated }));
  if (["remote-check", "migrate", "worker-deploy"].includes(args.action)) {
    verifyRemoteD1(args.environment, validated);
  }
  if (["remote-check", "worker-deploy"].includes(args.action)) {
    verifyRemoteR2(args.environment);
  }
  if (args.action === "smoke") {
    console.log(
      JSON.stringify(
        await runScanSmokeChecks({
          environment: args.environment,
          apiBaseUrl: args.apiBaseUrl,
        }),
      ),
    );
    return;
  }
  const plan = createScanDeployPlan(args);
  for (const step of plan) runStep(step);
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
