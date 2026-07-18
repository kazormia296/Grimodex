#!/usr/bin/env node

/* global AbortController, AbortSignal, clearTimeout, console, fetch, setTimeout */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const localHost = "127.0.0.1";
const localWebPort = 4173;
const localWorkerPort = 8787;
const localConfig = "apps/scan-web/wrangler.jsonc";
const localEnvironmentFile = "apps/scan-web/local-only.env";
const defaultPersistDirectory = ".wrangler/scan-local";
const isolatedWranglerEnvironment = {
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
};

function sleepFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveLocalCommand(command, args, platform, environment) {
  if (platform === "win32" && command === "pnpm") {
    return {
      args: ["/d", "/s", "/c", command, ...args],
      command: environment.ComSpec ?? "cmd.exe",
    };
  }
  return { args, command };
}

export function createScanLocalPlan({
  persistDirectory = defaultPersistDirectory,
} = {}) {
  if (typeof persistDirectory !== "string" || !persistDirectory.trim()) {
    throw new Error("persistDirectory must be a non-empty path");
  }
  const webOrigin = `http://${localHost}:${localWebPort}`;
  const workerOrigin = `http://${localHost}:${localWorkerPort}`;
  const webBuildEnvironment = {
    VITE_SCAN_API_BASE_URL: workerOrigin,
    VITE_SCAN_TURNSTILE_REQUIRED: "false",
  };
  return {
    persistDirectory,
    webOrigin,
    workerOrigin,
    setup: [
      {
        command: "pnpm",
        args: ["build:scan"],
        env: webBuildEnvironment,
      },
      {
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--config",
          localConfig,
          "--env-file",
          localEnvironmentFile,
          "--persist-to",
          persistDirectory,
        ],
        env: { CI: "true", ...isolatedWranglerEnvironment },
      },
    ],
    services: [
      {
        name: "worker",
        command: "pnpm",
        args: [
          "exec",
          "wrangler",
          "dev",
          "--local",
          "--ip",
          localHost,
          "--port",
          String(localWorkerPort),
          "--config",
          localConfig,
          "--env-file",
          localEnvironmentFile,
          "--persist-to",
          persistDirectory,
          "--show-interactive-dev-session=false",
        ],
        env: isolatedWranglerEnvironment,
      },
      {
        name: "web",
        command: "pnpm",
        args: [
          "--dir",
          "apps/scan-web",
          "exec",
          "vite",
          "preview",
          "--host",
          localHost,
          "--port",
          String(localWebPort),
          "--strictPort",
        ],
      },
    ],
  };
}

export function parseScanLocalArgs(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const result = { help: false, smoke: false };
  for (const argument of normalized) {
    if (argument === "--help") result.help = true;
    else if (argument === "--smoke") result.smoke = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

async function expectJson(
  fetchImpl,
  url,
  init,
  expectedStatus,
  label,
  timeoutMs = 10_000,
) {
  const { body: responseText, response } = await fetchBodyWithTimeout(
    fetchImpl,
    url,
    init,
    timeoutMs,
    label,
    (value) => value.text(),
  );
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} returned HTTP ${response.status}, expected ${expectedStatus}${responseText ? `: ${responseText}` : ""}`,
    );
  }
  try {
    return { body: JSON.parse(responseText), response };
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function fetchBodyWithTimeout(
  fetchImpl,
  url,
  init,
  timeoutMs,
  label,
  readBody,
) {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let onCallerAbort;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const request = (async () => {
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const response = await fetchImpl(url, {
      ...(init ?? {}),
      signal: requestSignal,
    });
    return { body: await readBody(response), response };
  })();
  const pending = [request, timeout];
  if (callerSignal) {
    pending.push(
      new Promise((_, reject) => {
        onCallerAbort = () => {
          const error = abortReason(callerSignal, `${label} cancelled`);
          controller.abort(error);
          reject(error);
        };
        if (callerSignal.aborted) onCallerAbort();
        else
          callerSignal.addEventListener("abort", onCallerAbort, {
            once: true,
          });
      }),
    );
  }
  try {
    return await Promise.race(pending);
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
    controller.abort();
  }
}

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid object`);
  }
  return value;
}

export async function validateLocalScanReport(value) {
  const { parseScanBundle } = await import("@grimodex/scan-contract");
  const parsed = parseScanBundle(value);
  if (!parsed.ok) {
    throw new Error("local Quick Scan report failed its public contract");
  }
  if (parsed.value.entities.length === 0 || parsed.value.events.length === 0) {
    throw new Error("local Quick Scan report has no deterministic evidence");
  }
  return parsed.value;
}

/** Runs a disposable upload -> Workflow -> report request against local services. */
export async function runLocalQuickScanSmoke({
  fetchImpl = fetch,
  scanId = randomUUID(),
  scanToken = randomBytes(32).toString("base64url"),
  requestTimeoutMs = 10_000,
  signal,
  sleep = sleepFor,
  timeoutMs = 60_000,
  webOrigin = `http://${localHost}:${localWebPort}`,
  workerOrigin = `http://${localHost}:${localWorkerPort}`,
} = {}) {
  throwIfAborted(signal);
  const originHeaders = { origin: webOrigin };
  const { body: healthBody, response: healthResponse } = await expectJson(
    fetchImpl,
    `${workerOrigin}/api/v1/health`,
    { headers: originHeaders, signal },
    200,
    "local Worker health",
    requestTimeoutMs,
  );
  const health = assertObject(healthBody, "local Worker health");
  if (
    health.ok !== true ||
    health.service !== "grimodex-scan" ||
    health.acceptingNewJobs !== true
  ) {
    throw new Error("local Worker is not accepting Quick Scan jobs");
  }
  if (healthResponse.headers.get("access-control-allow-origin") !== webOrigin) {
    throw new Error(
      "local Worker CORS origin does not match the local web app",
    );
  }

  const { body: webHtml, response: webResponse } = await fetchBodyWithTimeout(
    fetchImpl,
    `${webOrigin}/`,
    { signal },
    requestTimeoutMs,
    "local web app",
    (value) => value.text(),
  );
  if (webResponse.status !== 200) {
    throw new Error(`local web app returned HTTP ${webResponse.status}`);
  }
  if (
    !/<title>\s*Grimodex Scan\s*<\/title>/iu.test(webHtml) ||
    !/<div[^>]+\bid=["']root["'][^>]*>/iu.test(webHtml)
  ) {
    throw new Error("local web app is not the built Grimodex Scan shell");
  }

  const source = new TextEncoder().encode(
    "ユキは夜明け前に北の塔へ向かった。塔の番人レンは古い鍵を手渡した。",
  );
  const { body: intentBody } = await expectJson(
    fetchImpl,
    `${workerOrigin}/api/v1/upload-intents`,
    {
      method: "POST",
      signal,
      headers: {
        ...originHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "local-smoke.txt",
        contentType: "text/plain",
        size: source.byteLength,
      }),
    },
    201,
    "local upload intent",
    requestTimeoutMs,
  );
  const intent = assertObject(intentBody, "local upload intent");
  if (
    typeof intent.uploadId !== "string" ||
    typeof intent.uploadToken !== "string" ||
    typeof intent.uploadUrl !== "string"
  ) {
    throw new Error("local upload intent is missing credentials");
  }
  const uploadUrl = new URL(intent.uploadUrl);
  if (uploadUrl.origin !== workerOrigin) {
    throw new Error("local upload intent points outside the local Worker");
  }

  await expectJson(
    fetchImpl,
    uploadUrl,
    {
      method: "PUT",
      signal,
      headers: {
        ...originHeaders,
        "content-type": "text/plain",
        "x-upload-token": intent.uploadToken,
      },
      body: source,
    },
    200,
    "local source upload",
    requestTimeoutMs,
  );
  await expectJson(
    fetchImpl,
    `${workerOrigin}/api/v1/uploads/${encodeURIComponent(intent.uploadId)}/complete`,
    {
      method: "POST",
      signal,
      headers: { ...originHeaders, "x-upload-token": intent.uploadToken },
    },
    200,
    "local upload completion",
    requestTimeoutMs,
  );

  let scanCreated = false;
  let primaryFailure;
  try {
    const { body: createBody } = await expectJson(
      fetchImpl,
      `${workerOrigin}/api/v1/scans`,
      {
        method: "POST",
        signal,
        headers: {
          ...originHeaders,
          "content-type": "application/json",
          "x-upload-token": intent.uploadToken,
        },
        body: JSON.stringify({
          uploadId: intent.uploadId,
          scanId,
          scanToken,
          mode: "quick",
        }),
      },
      202,
      "local Quick Scan creation",
      requestTimeoutMs,
    );
    const created = assertObject(createBody, "local Quick Scan creation");
    if (
      created.scanId !== scanId ||
      created.scanToken !== scanToken ||
      created.mode !== "quick"
    ) {
      throw new Error("local Quick Scan creation returned the wrong handle");
    }
    scanCreated = true;

    const deadline = Date.now() + timeoutMs;
    let completed = false;
    while (Date.now() <= deadline) {
      const { body: statusBody } = await expectJson(
        fetchImpl,
        `${workerOrigin}/api/v1/scans/${encodeURIComponent(scanId)}`,
        {
          headers: { ...originHeaders, "x-scan-token": scanToken },
          signal,
        },
        200,
        "local Quick Scan status",
        Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())),
      );
      const status = assertObject(statusBody, "local Quick Scan status");
      if (status.status === "completed") {
        completed = true;
        break;
      }
      if (
        ["failed", "cancelled", "expired", "deleted"].includes(status.status)
      ) {
        throw new Error(`local Quick Scan ended with ${String(status.status)}`);
      }
      await sleepWithSignal(250, signal, sleep);
    }
    if (!completed) throw new Error("local Quick Scan timed out");

    const { body: reportBody } = await expectJson(
      fetchImpl,
      `${workerOrigin}/api/v1/scans/${encodeURIComponent(scanId)}/report`,
      {
        headers: { ...originHeaders, "x-scan-token": scanToken },
        signal,
      },
      200,
      "local Quick Scan report",
      requestTimeoutMs,
    );
    const report = await validateLocalScanReport(reportBody);
    return {
      entityCount: report.entities.length,
      eventCount: report.events.length,
      findingCount: report.findings.length,
      scanId,
      status: "completed",
    };
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    if (scanCreated) {
      try {
        await expectJson(
          fetchImpl,
          `${workerOrigin}/api/v1/scans/${encodeURIComponent(scanId)}`,
          {
            method: "DELETE",
            signal,
            headers: { ...originHeaders, "x-scan-token": scanToken },
          },
          200,
          "local Quick Scan cleanup",
          requestTimeoutMs,
        );
      } catch (cleanupFailure) {
        if (!primaryFailure) throw cleanupFailure;
      }
    }
  }
}

function runSetupStep(step) {
  const environment = { ...process.env, ...step.env };
  const command = resolveLocalCommand(
    step.command,
    step.args,
    process.platform,
    environment,
  );
  const result = spawnSync(command.command, command.args, {
    cwd: repositoryRoot,
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${step.command} ${step.args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

export function startLocalServices(
  services,
  {
    forceShutdownMs = 1_000,
    gracefulShutdownMs = 2_000,
    environment = process.env,
    killProcess = process.kill.bind(process),
    platform = process.platform,
    sleep = sleepFor,
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  let stopping = false;
  const children = services.map((service) => {
    const command = resolveLocalCommand(
      service.command,
      service.args,
      platform,
      environment,
    );
    const child = spawnImpl(command.command, command.args, {
      cwd: repositoryRoot,
      detached: platform !== "win32",
      env: { ...environment, ...service.env },
      shell: false,
      stdio: "inherit",
    });
    return { child, name: service.name };
  });
  const unexpectedExit = Promise.race(
    children.map(
      ({ child, name }) =>
        new Promise((_, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            if (!stopping) {
              reject(
                new Error(
                  `${name} exited before shutdown (${signal ?? `code ${code ?? "unknown"}`})`,
                ),
              );
            }
          });
        }),
    ),
  );
  const terminate = (child, signal) => {
    try {
      if (platform === "win32" && child.pid) {
        const result = spawnSyncImpl(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            shell: false,
            stdio: "ignore",
            windowsHide: true,
          },
        );
        if (result.error || result.status !== 0) child.kill("SIGKILL");
      } else if (child.pid) {
        killProcess(-child.pid, signal);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  };
  const isRunning = (child) => {
    if (platform === "win32" || !child.pid) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      killProcess(-child.pid, 0);
      return true;
    } catch (cause) {
      if (cause?.code === "ESRCH") return false;
      throw cause;
    }
  };
  const waitUntilStopped = async (child, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isRunning(child) && Date.now() < deadline) {
      await sleep(50);
    }
    return !isRunning(child);
  };
  return {
    unexpectedExit,
    async stop() {
      stopping = true;
      for (const { child } of children) terminate(child, "SIGTERM");
      await Promise.all(
        children.map(async ({ child, name }) => {
          if (await waitUntilStopped(child, gracefulShutdownMs)) return;
          terminate(child, "SIGKILL");
          if (await waitUntilStopped(child, forceShutdownMs)) return;
          throw new Error(`${name} process group did not stop`);
        }),
      );
    },
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw abortReason(signal, "local operation cancelled");
}

function sleepWithSignal(milliseconds, signal, sleep = sleepFor) {
  if (sleep !== sleepFor) {
    const delay = Promise.resolve().then(() => sleep(milliseconds));
    if (!signal) return delay;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(abortReason(signal, "local operation cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      delay.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
  if (!signal) return sleepFor(milliseconds);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, "local operation cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForEndpoint(
  url,
  label,
  { fetchImpl = fetch, signal, timeoutMs = 45_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    try {
      const requestTimeout = AbortSignal.timeout(2_000);
      const response = await fetchImpl(url, {
        signal: signal
          ? AbortSignal.any([signal, requestTimeout])
          : requestTimeout,
      });
      if (response.ok) return;
      lastFailure = new Error(`${label} returned HTTP ${response.status}`);
    } catch (cause) {
      throwIfAborted(signal);
      lastFailure = cause;
    }
    await sleepWithSignal(250, signal);
  }
  throw new Error(
    `${label} did not become ready${lastFailure instanceof Error ? `: ${lastFailure.message}` : ""}`,
  );
}

function createShutdownSignal() {
  let onInterrupt;
  let onTerminate;
  const promise = new Promise((resolve) => {
    onInterrupt = () => resolve("SIGINT");
    onTerminate = () => resolve("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  });
  return {
    promise,
    dispose() {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}

function printHelp() {
  console.log(`Usage:
  pnpm scan:local
  pnpm scan:local:smoke

scan:local builds the production web assets, migrates a persistent local D1,
and starts local Worker/Workflow/R2 plus the Vite preview. scan:local:smoke
uses fresh temporary state, runs one deterministic Quick Scan, and exits.`);
}

async function main() {
  const args = parseScanLocalArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  let temporaryPersistDirectory;
  if (args.smoke) {
    temporaryPersistDirectory = await mkdtemp(
      path.join(tmpdir(), "grimodex-scan-local-"),
    );
  }
  const plan = createScanLocalPlan({
    persistDirectory: temporaryPersistDirectory ?? defaultPersistDirectory,
  });
  let stack;
  let shutdownSignal;
  try {
    for (const step of plan.setup) runSetupStep(step);
    shutdownSignal = createShutdownSignal();
    stack = startLocalServices(plan.services);
    const startupController = new AbortController();
    const readiness = Promise.all([
      waitForEndpoint(`${plan.workerOrigin}/api/v1/health`, "local Worker", {
        signal: startupController.signal,
      }),
      waitForEndpoint(`${plan.webOrigin}/`, "local web app", {
        signal: startupController.signal,
      }),
    ]);
    let startup;
    try {
      startup = await Promise.race([
        readiness.then(() => ({ kind: "ready" })),
        shutdownSignal.promise.then((signal) => ({ kind: "signal", signal })),
        stack.unexpectedExit,
      ]);
    } finally {
      startupController.abort(new Error("local startup probe cancelled"));
      await readiness.catch(() => undefined);
    }
    if (startup.kind === "signal") {
      return;
    }
    console.log(`Local Grimodex Scan is ready: ${plan.webOrigin}`);
    console.log(`Local Worker API: ${plan.workerOrigin}`);
    if (args.smoke) {
      const smokeController = new AbortController();
      const smoke = runLocalQuickScanSmoke({
        signal: smokeController.signal,
        webOrigin: plan.webOrigin,
        workerOrigin: plan.workerOrigin,
      });
      try {
        const outcome = await Promise.race([
          smoke.then((result) => ({ kind: "result", result })),
          shutdownSignal.promise.then((signal) => ({ kind: "signal", signal })),
          stack.unexpectedExit,
        ]);
        if (outcome.kind === "signal") {
          smokeController.abort(
            new Error(`local smoke interrupted by ${outcome.signal}`),
          );
          return;
        }
        console.log(
          JSON.stringify({ localSmoke: "passed", ...outcome.result }),
        );
      } finally {
        smokeController.abort(new Error("local smoke finished"));
        await smoke.catch(() => undefined);
      }
      return;
    }
    await Promise.race([shutdownSignal.promise, stack.unexpectedExit]);
  } finally {
    try {
      if (stack) await stack.stop();
    } finally {
      shutdownSignal?.dispose();
      if (temporaryPersistDirectory) {
        await rm(temporaryPersistDirectory, { recursive: true, force: true });
      }
    }
  }
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
