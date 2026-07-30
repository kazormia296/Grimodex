import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { _electron } from "playwright";

import { closeElectronAppWithDiagnostics } from "./close-electron-app.mjs";

const require = createRequire(import.meta.url);
const PRODUCT_JOURNEY_AI_ENV = "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI";
const PRODUCT_JOURNEY_AI_VERSION = "deterministic-v1";
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4_000;
const LIFECYCLE_TRACE_OPT_IN_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_TRACE__";
const LIFECYCLE_TRACE_EVENT_NAME = "grimodex:lifecycle-trace";
const LIFECYCLE_TRACE_BUFFER_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_EVENTS__";
const LIFECYCLE_TRACE_LISTENER_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_LISTENER__";
const MAX_LIFECYCLE_TRACE_EVENTS = 256;

/**
 * Renderer failures are never allowlisted. This schema exists only for
 * unavoidable main-process/Chromium stderr noise and deliberately requires a
 * phase, an owner-readable reason, and a short expiry.
 */
export const MAIN_PROCESS_NOISE_ALLOWLIST = Object.freeze([]);

function boundedDiagnosticText(value) {
  const text = String(value ?? "");
  return text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}…`;
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return undefined;
  const normalized = {
    url: boundedDiagnosticText(location.url ?? ""),
    lineNumber: Number(location.lineNumber ?? 0),
    columnNumber: Number(location.columnNumber ?? 0),
  };
  return normalized.url ||
    normalized.lineNumber !== 0 ||
    normalized.columnNumber !== 0
    ? normalized
    : undefined;
}

function validateMainProcessNoiseAllowlist(allowlist) {
  for (const allowance of allowlist) {
    if (
      !allowance ||
      typeof allowance.id !== "string" ||
      !Array.isArray(allowance.phases) ||
      allowance.phases.length === 0 ||
      allowance.phases.some(
        (phase) => typeof phase !== "string" || phase.trim() === "",
      ) ||
      typeof allowance.reason !== "string" ||
      allowance.reason.trim() === "" ||
      typeof allowance.expiresOn !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(allowance.expiresOn) ||
      !(allowance.pattern instanceof RegExp)
    ) {
      throw new Error(
        "main-process noise allowances require id, phases, reason, expiresOn, and pattern",
      );
    }
  }
}

function resolveMainProcessNoiseAllowance(
  phase,
  message,
  allowlist,
  today = new Date().toISOString().slice(0, 10),
) {
  return allowlist.find((allowance) => {
    allowance.pattern.lastIndex = 0;
    return (
      allowance.expiresOn >= today &&
      allowance.phases.includes(phase) &&
      allowance.pattern.test(message)
    );
  });
}

export class RendererDiagnosticsError extends Error {
  constructor(diagnostics, rendererErrors) {
    const summaries = [
      ...rendererErrors.map(
        (issue) => `[${issue.phase}] console.error: ${issue.message}`,
      ),
      ...diagnostics.pageErrors.map(
        (issue) => `[${issue.phase}] pageerror: ${issue.message}`,
      ),
    ];
    super(
      `Renderer diagnostics failed (${diagnostics.rendererErrorCount} console error(s), ` +
        `${diagnostics.pageErrors.length} page error(s))${
          summaries.length > 0 ? `: ${summaries.slice(0, 4).join(" | ")}` : ""
        }`,
    );
    this.name = "RendererDiagnosticsError";
    this.diagnostics = diagnostics;
  }
}

function installLifecycleTraceCapture({
  optInKey,
  eventName,
  bufferKey,
  listenerKey,
  maxEvents,
}) {
  globalThis[optInKey] = true;
  if (!Array.isArray(globalThis[bufferKey])) globalThis[bufferKey] = [];
  if (globalThis[listenerKey] === true) return;
  globalThis[listenerKey] = true;
  globalThis.addEventListener(eventName, (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== "object") return;
    const buffer = globalThis[bufferKey];
    buffer.push(detail);
    if (buffer.length > maxEvents) {
      buffer.splice(0, buffer.length - maxEvents);
    }
  });
}

const lifecycleTraceCaptureConfig = Object.freeze({
  optInKey: LIFECYCLE_TRACE_OPT_IN_KEY,
  eventName: LIFECYCLE_TRACE_EVENT_NAME,
  bufferKey: LIFECYCLE_TRACE_BUFFER_KEY,
  listenerKey: LIFECYCLE_TRACE_LISTENER_KEY,
  maxEvents: MAX_LIFECYCLE_TRACE_EVENTS,
});

/** Typed renderer bridge invocation shared by product and performance journeys. */
export async function invokeOk(page, command, args = {}) {
  const envelope = await page.evaluate(
    ([name, input]) => globalThis.grimodex.invoke(name, input),
    [command, args],
  );
  if (!envelope.ok) {
    throw new Error(`${command} rejected: ${envelope.error}`);
  }
  return envelope.value;
}

/** Poll a boundary assertion while keeping the last transport error. */
export async function waitUntil(
  fn,
  label,
  timeoutMs = 30_000,
  intervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${label}${
          lastError ? `: ${lastError.message ?? lastError}` : ""
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function createProductJourneyHarness({
  mainCjs,
  electronBin = require("electron"),
  launchTimeoutMs = 60_000,
  artifactRoot = process.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ?? null,
  electronLauncher = _electron,
  closeApp = closeElectronAppWithDiagnostics,
  mainProcessNoiseAllowlist = MAIN_PROCESS_NOISE_ALLOWLIST,
} = {}) {
  if (!mainCjs) throw new Error("product journey harness requires mainCjs");
  validateMainProcessNoiseAllowlist(mainProcessNoiseAllowlist);

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "grimodex-product-"));
  const userDataDir = path.join(tmpRoot, "user-data");
  const retainedRendererPath = path.join(tmpRoot, "last-renderer.png");
  const mainLog = [];
  const rendererLog = [];
  const mainDiagnostics = [];
  const rendererWarnings = [];
  const rendererErrors = [];
  const pageErrors = [];
  const pendingDiagnosticWork = new Set();
  const authorityTimeline = [];
  const recordedLifecycleEvents = new Set();
  const lastResources = {
    app: null,
    page: null,
    phase: null,
  };

  function recordTimeline(event, details = {}) {
    authorityTimeline.push({
      at: new Date().toISOString(),
      phase: lastResources.phase,
      event,
      ...details,
    });
  }

  function enqueueDiagnosticWork(operation) {
    const task = Promise.resolve().then(operation);
    pendingDiagnosticWork.add(task);
    const cleanup = () => pendingDiagnosticWork.delete(task);
    void task.then(cleanup, cleanup);
  }

  async function drainDiagnosticWork() {
    // Playwright can deliver the final console/pageerror event on the event-loop
    // turn immediately after Electron has closed. Require two consecutive idle
    // turns so a nested delivery is serialized before a clean result is issued.
    let consecutiveIdleTurns = 0;
    while (consecutiveIdleTurns < 2) {
      if (pendingDiagnosticWork.size > 0) {
        await Promise.allSettled([...pendingDiagnosticWork]);
        consecutiveIdleTurns = 0;
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingDiagnosticWork.size === 0) {
        consecutiveIdleTurns += 1;
      } else {
        consecutiveIdleTurns = 0;
      }
    }
  }

  function diagnostics() {
    return {
      rendererErrorCount: rendererErrors.length,
      pageErrors: pageErrors.map((issue) => ({ ...issue })),
      cleanPass: rendererErrors.length === 0 && pageErrors.length === 0,
    };
  }

  async function finalizeDiagnostics() {
    await drainDiagnosticWork();
    const summary = diagnostics();
    if (!summary.cleanPass) {
      throw new RendererDiagnosticsError(summary, rendererErrors);
    }
    return summary;
  }

  function workspacePath(name) {
    if (!name || name.includes("/") || name.includes("\\")) {
      throw new Error(`invalid product journey workspace name: ${name}`);
    }
    return path.join(tmpRoot, name);
  }

  function mergeLifecycleTraceEvents(events) {
    for (const event of events) {
      const key = `${event.transitionId}:${event.sequence}`;
      if (recordedLifecycleEvents.has(key)) continue;
      recordedLifecycleEvents.add(key);
      authorityTimeline.push({
        at: new Date(event.timestampMs).toISOString(),
        phase: lastResources.phase,
        event: "application-lifecycle",
        lifecycle: event,
      });
    }
  }

  async function readLifecycleTrace(page = lastResources.page) {
    if (!page || page.isClosed?.() || typeof page.evaluate !== "function") {
      return [];
    }
    const events = await page.evaluate((bufferKey) => {
      const value = globalThis[bufferKey];
      return Array.isArray(value) ? value : [];
    }, LIFECYCLE_TRACE_BUFFER_KEY);
    const normalized = Array.isArray(events) ? events : [];
    mergeLifecycleTraceEvents(normalized);
    return normalized;
  }

  async function launch(phase) {
    await rm(retainedRendererPath, { force: true });
    recordTimeline("launch-requested", { phase });
    const env = { ...process.env };
    delete env.ELECTRON_RENDERER_URL;
    env.GRIMODEX_USER_DATA_DIR = userDataDir;
    env[PRODUCT_JOURNEY_AI_ENV] = PRODUCT_JOURNEY_AI_VERSION;
    const app = await electronLauncher.launch({
      executablePath: electronBin,
      args: [mainCjs],
      env,
      timeout: launchTimeoutMs,
    });
    const browserContext =
      typeof app.context === "function" ? app.context() : null;
    if (typeof browserContext?.addInitScript === "function") {
      await browserContext.addInitScript(
        installLifecycleTraceCapture,
        lifecycleTraceCaptureConfig,
      );
    }
    lastResources.app = app;
    lastResources.page = null;
    lastResources.phase = phase;
    const appProcess = typeof app.process === "function" ? app.process() : null;
    appProcess?.stdout?.on("data", (data) => {
      const line = `  [product:${phase}:main] ${String(data)}`;
      mainLog.push(line);
      process.stdout.write(line);
    });
    appProcess?.stderr?.on("data", (data) => {
      const message = String(data);
      const line = `  [product:${phase}:main] ${message}`;
      mainLog.push(line);
      const allowance = resolveMainProcessNoiseAllowance(
        phase,
        message,
        mainProcessNoiseAllowlist,
      );
      mainDiagnostics.push({
        at: new Date().toISOString(),
        phase,
        message: boundedDiagnosticText(message),
        allowance: allowance
          ? {
              id: allowance.id,
              reason: allowance.reason,
              expiresOn: allowance.expiresOn,
            }
          : null,
      });
      process.stderr.write(line);
    });
    const page = await app.firstWindow({ timeout: launchTimeoutMs });
    lastResources.page = page;
    if (typeof page.evaluate === "function") {
      await page.evaluate(
        installLifecycleTraceCapture,
        lifecycleTraceCaptureConfig,
      );
    }
    recordTimeline("renderer-window-ready");

    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type())) return;
      const line = `  [product:${phase}:renderer:${message.type()}] ${message.text()}\n`;
      rendererLog.push(line);
      process.stderr.write(line);
      enqueueDiagnosticWork(() => {
        const issue = {
          at: new Date().toISOString(),
          phase,
          message: boundedDiagnosticText(message.text()),
          location: normalizeLocation(message.location?.()),
        };
        if (message.type() === "error") rendererErrors.push(issue);
        else rendererWarnings.push(issue);
      });
    });
    page.on("pageerror", (error) => {
      const line = `  [product:${phase}:renderer:pageerror] ${error.message}\n`;
      rendererLog.push(line);
      process.stderr.write(line);
      enqueueDiagnosticWork(() => {
        pageErrors.push({
          phase,
          name: boundedDiagnosticText(error.name || "Error"),
          message: boundedDiagnosticText(error.message),
          ...(error.stack ? { stack: boundedDiagnosticText(error.stack) } : {}),
        });
      });
    });
    await page.waitForFunction(
      () => globalThis.grimodex?.shell === "electron",
      undefined,
      { timeout: launchTimeoutMs },
    );
    recordTimeline("renderer-bridge-ready");
    return { app, page };
  }

  async function retainRendererScreenshot(page) {
    if (!artifactRoot || !page || page.isClosed()) return;
    await page
      .screenshot({
        path: retainedRendererPath,
        fullPage: true,
      })
      .catch(() => undefined);
  }

  async function close(app, page, phase) {
    recordTimeline("close-requested", { phase });
    await readLifecycleTrace(page).catch(() => undefined);
    await retainRendererScreenshot(page);
    await closeApp(app, page, phase);
    // Renderer failures frequently arrive while lifecycle shutdown is
    // cancelling reads. Do not clear phase authority until every event already
    // delivered by Playwright has been serialized.
    await drainDiagnosticWork();
    recordTimeline("closed", { phase });
    if (lastResources.app === app) {
      lastResources.app = null;
      lastResources.page = null;
      lastResources.phase = null;
    }
  }

  async function captureFailureArtifact(name) {
    if (!artifactRoot) return;
    await drainDiagnosticWork();
    const destination = path.join(artifactRoot, name);
    const diagnosticsDir = path.join(tmpRoot, "diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(diagnosticsDir, "main.log"),
        mainLog.join(""),
        "utf8",
      ),
      writeFile(
        path.join(diagnosticsDir, "renderer.log"),
        rendererLog.join(""),
        "utf8",
      ),
      writeFile(
        path.join(diagnosticsDir, "authority-timeline.json"),
        `${JSON.stringify(
          [...authorityTimeline].sort((left, right) => {
            const timestampDelta =
              Date.parse(left.at ?? "") - Date.parse(right.at ?? "");
            if (timestampDelta !== 0) return timestampDelta;
            if (
              left.lifecycle?.transitionId === right.lifecycle?.transitionId
            ) {
              return (
                Number(left.lifecycle?.sequence ?? 0) -
                Number(right.lifecycle?.sequence ?? 0)
              );
            }
            return 0;
          }),
          null,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(
        path.join(diagnosticsDir, "renderer-diagnostics.json"),
        `${JSON.stringify(
          {
            ...diagnostics(),
            rendererErrors,
            rendererWarnings,
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(
        path.join(diagnosticsDir, "main-diagnostics.json"),
        `${JSON.stringify(mainDiagnostics, null, 2)}\n`,
        "utf8",
      ),
    ]);
    await mkdir(destination, { recursive: true });
    await retainRendererScreenshot(lastResources.page);
    await copyFile(
      retainedRendererPath,
      path.join(destination, "renderer.png"),
    ).catch(() => undefined);
    await cp(tmpRoot, path.join(destination, "runtime"), {
      recursive: true,
      force: true,
    });
  }

  async function dispose({ success, name }) {
    if (!success) {
      if (lastResources.app) {
        await readLifecycleTrace(lastResources.page).catch(() => undefined);
        await retainRendererScreenshot(lastResources.page);
        await closeApp(
          lastResources.app,
          lastResources.page,
          `failure:${name}`,
        ).catch(() => undefined);
        await drainDiagnosticWork();
        lastResources.app = null;
        lastResources.page = null;
        lastResources.phase = null;
      }
      await captureFailureArtifact(name).catch((error) => {
        console.error(
          `[electron:product] failed to retain artifacts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      console.error(`[electron:product] retained temporary root: ${tmpRoot}`);
      return;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }

  return {
    tmpRoot,
    userDataDir,
    workspacePath,
    launch,
    close,
    invokeOk,
    waitUntil,
    recordTimeline,
    readLifecycleTrace,
    diagnostics,
    finalizeDiagnostics,
    dispose,
  };
}
