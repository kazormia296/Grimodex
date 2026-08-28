import { execFile as execFileCallback } from "node:child_process";
import { copyFile, cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { _electron } from "playwright";

import { closeElectronAppWithDiagnostics } from "./close-electron-app.mjs";

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCallback);
const PRODUCT_JOURNEY_AI_ENV = "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI";
const PRODUCT_JOURNEY_AI_VERSION = "deterministic-v1";
const PRODUCT_JOURNEY_FIXTURE_DML_OWNER = "ci-product-journey-harness-v1";
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4_000;
const LIFECYCLE_TRACE_OPT_IN_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_TRACE__";
const LIFECYCLE_TRACE_EVENT_NAME = "grimodex:lifecycle-trace";
const LIFECYCLE_TRACE_BUFFER_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_EVENTS__";
const LIFECYCLE_TRACE_LISTENER_KEY =
  "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_LISTENER__";
const MAX_LIFECYCLE_TRACE_EVENTS = 256;
const MAIN_PROCESS_DRAIN_TIMEOUT_MS = 2_000;

function fixtureSqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects non-finite numeric params`,
      );
    }
    return String(value);
  }

  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = value;
  } else if (value instanceof Uint8Array || value instanceof DataView) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value);
  }
  if (bytes) return `X'${Buffer.from(bytes).toString("hex")}'`;

  throw new Error(
    `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects unsupported SQL param type: ${typeof value}`,
  );
}

function literalizeFixtureSql(sql, params, statementIndex) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires non-empty SQL at statement ${statementIndex}`,
    );
  }
  if (!Array.isArray(params)) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires params[] at statement ${statementIndex}`,
    );
  }
  if (
    !/^\s*(?:INSERT(?:\s+OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))?|UPDATE|DELETE|REPLACE)\b/i.test(
      sql,
    )
  ) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} accepts only one INSERT/UPDATE/DELETE/REPLACE statement at ${statementIndex}`,
    );
  }

  let result = "";
  let parameterIndex = 0;
  let state = "code";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "single" || state === "double" || state === "backtick") {
      result += character;
      const quoteCharacter =
        state === "single" ? "'" : state === "double" ? '"' : "`";
      if (character === quoteCharacter) {
        if (next === character) {
          result += next;
          index += 1;
        } else {
          state = "code";
        }
      }
      continue;
    }
    if (state === "bracket") {
      result += character;
      if (character === "]") state = "code";
      continue;
    }
    if (state === "line-comment") {
      result += character;
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      result += character;
      if (character === "*" && next === "/") {
        result += next;
        index += 1;
        state = "code";
      }
      continue;
    }

    if (character === "'") {
      result += character;
      state = "single";
    } else if (character === '"') {
      result += character;
      state = "double";
    } else if (character === "`") {
      result += character;
      state = "backtick";
    } else if (character === "[") {
      result += character;
      state = "bracket";
    } else if (character === "-" && next === "-") {
      result += "--";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "/*";
      index += 1;
      state = "block-comment";
    } else if (character === ";") {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects multiple SQL statements at ${statementIndex}`,
      );
    } else if (character === "?") {
      if (/\d/.test(next ?? "")) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects numbered SQL params at ${statementIndex}`,
        );
      }
      if (parameterIndex >= params.length) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} has an unbound SQL param at ${statementIndex}`,
        );
      }
      result += fixtureSqlLiteral(params[parameterIndex]);
      parameterIndex += 1;
    } else if (
      [":", "$", "@"].includes(character) &&
      /[A-Za-z_]/.test(next ?? "")
    ) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects named SQL params at ${statementIndex}`,
      );
    } else {
      result += character;
    }
  }

  if (state !== "code" && state !== "line-comment") {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects unterminated SQL quoting at ${statementIndex}`,
    );
  }
  if (parameterIndex !== params.length) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} has ${params.length - parameterIndex} unused SQL param(s) at ${statementIndex}`,
    );
  }
  return result;
}

/**
 * Renderer failures are never allowlisted. This schema exists only for
 * unavoidable main-process/Chromium stderr noise and deliberately requires a
 * phase, an owner-readable reason, and a short expiry.
 */
export const PRODUCT_JOURNEY_ELECTRON_PHASES = Object.freeze([
  "configure",
  "editor-persistence/write",
  "editor-persistence/restart",
  "chat-authority-isolation",
  "workspace-switch/prepare-workspaces",
  "workspace-switch/pending-save",
  "external-write-conflict",
  "cross-feature-authoring/prepare",
  "cross-feature-authoring/write",
  "cross-feature-authoring/restart",
  "chat-stream-project-switch/prepare-projects",
  "chat-stream-project-switch",
  "chat-stream-workspace-switch/prepare-workspaces",
  "chat-stream-workspace-switch",
  "editor-pending-project-switch/prepare-projects",
  "editor-pending-project-switch",
  "mcp-external-write-conflict/prepare-settings",
  "mcp-external-write-conflict",
  "chronicle-native-roundtrip/write",
  "chronicle-native-roundtrip/restart",
  "lint-native-roundtrip/write",
  "lint-native-roundtrip/restart",
  "map-native-roundtrip/write",
  "map-native-roundtrip/restart",
  "snapshot-native-roundtrip/write",
  "snapshot-native-roundtrip/restart",
  "c2-5b-schema-backfill-verify/open",
  "c2-5b-restore-verify-rebuild-verify/restore-fixture",
  "c2-5b-restore-verify-rebuild-verify/open",
  "c2-5b-graph-digest-no-skip/baseline",
  "c2-5b-graph-digest-no-skip/changed",
  "c2-5b-rule-digest-no-skip/baseline",
  "c2-5b-rule-digest-no-skip/changed",
  "c2-5b-producer-generation-no-skip/baseline",
  "c2-5b-producer-generation-no-skip/changed",
  "c2-5b-transient-bounded-retry/open",
  "c2-5b-terminal-failure-inbox/open",
  "c2-5b-terminal-failure-inbox/reopened",
  "c2-5b-interrupted-run-recovery/interrupted",
  "c2-5b-interrupted-run-recovery/recovered",
  "c2-5b-no-automatic-repair/restore-fixture",
  "c2-5b-no-automatic-repair/open",
  "c2-5b-foreground-write-workspace-wake/settle-primary",
  "c2-5b-foreground-write-workspace-wake/authoring",
  "c2-5b-incremental-liveness/before-restart",
  "c2-5b-incremental-liveness/after-restart",
  "c2-zc-canonical-authority-cutover/restore-fixture",
  "c2-zc-canonical-authority-cutover/restore",
  "c2-zc-canonical-authority-cutover/open",
  "c2-zc-canonical-authority-cutover/restart",
  "c2-zc-canonical-authority-cutover/new-project",
]);

export const MAIN_PROCESS_NOISE_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "ubuntu-xvfb-dbus-address",
    phases: PRODUCT_JOURNEY_ELECTRON_PHASES,
    reason:
      "GitHub-hosted Ubuntu Xvfb has no desktop D-Bus address; product journeys do not exercise desktop bus integration.",
    expiresOn: "2026-09-30",
    pattern:
      /^\[\d+:\d+\/\d+\.\d+:ERROR:dbus\/bus\.cc:\d+\] Failed to connect to the bus: Could not parse server address: Unknown address type \(examples of valid types are "tcp" and on UNIX "unix"\)\r?\n?$/,
  }),
  Object.freeze({
    id: "ubuntu-xvfb-dbus-owner",
    phases: PRODUCT_JOURNEY_ELECTRON_PHASES,
    reason:
      "GitHub-hosted Ubuntu Xvfb has no desktop D-Bus owner service; product journeys do not exercise desktop bus integration.",
    expiresOn: "2026-09-30",
    pattern:
      /^\[\d+:\d+\/\d+\.\d+:ERROR:dbus\/object_proxy\.cc:\d+\] Failed to call method: org\.freedesktop\.DBus\.NameHasOwner: object_path= \/org\/freedesktop\/DBus: unknown error type: ?\r?\n?$/,
  }),
  Object.freeze({
    id: "ubuntu-xvfb-webgl2-blocklist",
    phases: PRODUCT_JOURNEY_ELECTRON_PHASES,
    reason:
      "GitHub-hosted Ubuntu Xvfb blocklists WebGL2; these journeys assert persistence and lifecycle behavior outside WebGL rendering.",
    expiresOn: "2026-09-30",
    pattern:
      /^\[\d+:\d+\/\d+\.\d+:ERROR:gpu\/command_buffer\/service\/context_group\.cc:\d+\] ContextResult::kFatalFailure: WebGL2 blocklisted\r?\n?$/,
  }),
  Object.freeze({
    id: "ubuntu-xvfb-shared-image-mailbox",
    phases: Object.freeze(["configure"]),
    reason:
      "Observed on GitHub-hosted Ubuntu Xvfb only as an isolated configure-process teardown burst after setup completed; all journey assertion phases remain gated.",
    expiresOn: "2026-09-30",
    pattern:
      /^\[\d+:\d+\/\d+\.\d+:ERROR:gpu\/command_buffer\/service\/shared_image\/shared_image_manager\.cc:\d+\] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox\.\r?\n?$/,
  }),
  Object.freeze({
    id: "ubuntu-xvfb-restore-reload-shared-image-skia",
    phases: Object.freeze([
      "c2-5b-restore-verify-rebuild-verify/open",
      "c2-zc-canonical-authority-cutover/restore",
    ]),
    reason:
      "Observed on Ubuntu Xvfb during the trusted production renderer reload after Settings backup restore; only the exact C2-5B open or C2-ZC restore phase is allowed.",
    expiresOn: "2026-09-30",
    pattern:
      /^\[\d+:\d+\/\d+\.\d+:ERROR:gpu\/command_buffer\/service\/shared_image\/shared_image_manager\.cc:\d+\] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox\.\r?\n?$/,
  }),
]);

const MAIN_PROCESS_ERROR_PATTERNS = Object.freeze([
  /\b(?:errors?|exceptions?|failed|failure|fatal|panic(?:ked)?|uncaught|unhandled|crash(?:ed)?)\b/i,
  /\b(?:UnhandledPromiseRejection(?:Warning)?|unhandledRejection|uncaughtException)\b/i,
  /\b(?:Assertion failed|Segmentation fault|core dumped)\b/i,
  /\b(?:AggregateError|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)\b/,
  /\b(?:EACCES|EADDRINUSE|ECONNREFUSED|ENOENT|ENOMEM|EPERM|ETIMEDOUT)\b/,
]);

export function isMainProcessErrorMessage(message) {
  const text = String(message ?? "");
  return MAIN_PROCESS_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

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

export class MainProcessDiagnosticsError extends Error {
  constructor(diagnostics) {
    const summaries = diagnostics.unallowedMainErrors.map(
      (issue) => `[${issue.phase}] main stderr: ${issue.message}`,
    );
    super(
      `Main-process diagnostics failed (${diagnostics.mainErrorCount} error-class stderr message(s), ` +
        `${diagnostics.unallowedMainErrors.length} unallowed)${
          summaries.length > 0 ? `: ${summaries.slice(0, 4).join(" | ")}` : ""
        }`,
    );
    this.name = "MainProcessDiagnosticsError";
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
  mainProcessDrainTimeoutMs = MAIN_PROCESS_DRAIN_TIMEOUT_MS,
  artifactRoot = process.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ?? null,
  electronLauncher = _electron,
  closeApp = closeElectronAppWithDiagnostics,
  mainProcessNoiseAllowlist = MAIN_PROCESS_NOISE_ALLOWLIST,
} = {}) {
  if (!mainCjs) throw new Error("product journey harness requires mainCjs");
  if (
    !Number.isFinite(mainProcessDrainTimeoutMs) ||
    mainProcessDrainTimeoutMs <= 0
  ) {
    throw new Error(
      "product journey harness requires a positive mainProcessDrainTimeoutMs",
    );
  }
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
  const mainDiagnosticTrackers = new Map();
  const authorityTimeline = [];
  const recordedLifecycleEvents = new Set();
  const ownedWorkspaces = new Set();
  let fixtureDmlInFlight = false;
  let launchInFlight = false;
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

  function recordMainProcessDiagnostic(
    phase,
    message,
    { forceError = false, allowAllowance = true } = {},
  ) {
    const isError = forceError || isMainProcessErrorMessage(message);
    const allowance =
      isError && allowAllowance
        ? resolveMainProcessNoiseAllowance(
            phase,
            message,
            mainProcessNoiseAllowlist,
          )
        : undefined;
    mainDiagnostics.push({
      at: new Date().toISOString(),
      phase,
      message: boundedDiagnosticText(message),
      classification: isError ? "error" : "noise",
      allowance: allowance
        ? {
            id: allowance.id,
            phases: [...allowance.phases],
            reason: allowance.reason,
            expiresOn: allowance.expiresOn,
            pattern: allowance.pattern.toString(),
          }
        : null,
    });
  }

  function attachMainDiagnosticStream(app, stream, phase) {
    if (!stream || typeof stream.on !== "function") return;

    const decoder = new StringDecoder("utf8");
    let bufferedText = "";
    let settled = false;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const recordCompleteLines = () => {
      for (;;) {
        const newlineIndex = bufferedText.indexOf("\n");
        if (newlineIndex < 0) return;
        const message = bufferedText.slice(0, newlineIndex + 1);
        bufferedText = bufferedText.slice(newlineIndex + 1);
        recordMainProcessDiagnostic(phase, message);
      }
    };

    const onData = (data) => {
      const message =
        typeof data === "string" ? data : decoder.write(Buffer.from(data));
      if (!message) return;
      const line = `  [product:${phase}:main] ${message}`;
      mainLog.push(line);
      process.stderr.write(line);
      bufferedText += message;
      recordCompleteLines();
    };

    let onEnd;
    let onClose;
    let onError;
    const removeListeners = () => {
      const remove =
        typeof stream.off === "function"
          ? stream.off.bind(stream)
          : stream.removeListener?.bind(stream);
      if (!remove) return;
      remove("data", onData);
      remove("end", onEnd);
      remove("close", onClose);
      remove("error", onError);
    };
    const finish = (failureMessage) => {
      if (settled) return;
      settled = true;
      const decoderTail = decoder.end();
      if (decoderTail) bufferedText += decoderTail;
      if (bufferedText) {
        recordMainProcessDiagnostic(phase, bufferedText);
        bufferedText = "";
      }
      if (failureMessage) {
        recordMainProcessDiagnostic(phase, failureMessage, {
          forceError: true,
          allowAllowance: false,
        });
      }
      removeListeners();
      resolveDone();
    };
    onEnd = () => finish();
    onClose = () => finish();
    onError = (error) =>
      finish(
        `Main stderr stream error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);

    const tracker = {
      phase,
      done,
      get settled() {
        return settled;
      },
      failDrain() {
        finish(
          `Main stderr stream did not end or close within ${mainProcessDrainTimeoutMs}ms after application close.`,
        );
      },
    };
    mainDiagnosticTrackers.set(app, tracker);

    if (stream.readableEnded === true || stream.closed === true) {
      finish();
    }
  }

  async function awaitMainDiagnosticTracker(tracker) {
    if (!tracker || tracker.settled) return;
    let timeoutId;
    const outcome = await Promise.race([
      tracker.done.then(() => "drained"),
      new Promise((resolve) => {
        timeoutId = globalThis.setTimeout(
          () => resolve("timeout"),
          mainProcessDrainTimeoutMs,
        );
      }),
    ]);
    if (timeoutId) globalThis.clearTimeout(timeoutId);
    if (outcome === "timeout") tracker.failDrain();
    await tracker.done;
  }

  async function drainMainDiagnosticStream(app) {
    await awaitMainDiagnosticTracker(mainDiagnosticTrackers.get(app));
  }

  async function drainMainDiagnosticStreams() {
    await Promise.all(
      [...mainDiagnosticTrackers.values()].map(awaitMainDiagnosticTracker),
    );
  }

  function diagnostics() {
    const mainErrors = mainDiagnostics.filter(
      (issue) => issue.classification === "error",
    );
    const unallowedMainErrors = mainErrors
      .filter((issue) => issue.allowance === null)
      .map(({ at, phase, message }) => ({ at, phase, message }));
    const rendererCleanPass =
      rendererErrors.length === 0 && pageErrors.length === 0;
    const mainCleanPass = unallowedMainErrors.length === 0;
    return {
      rendererErrorCount: rendererErrors.length,
      pageErrors: pageErrors.map((issue) => ({ ...issue })),
      mainErrorCount: mainErrors.length,
      unallowedMainErrors,
      mainCleanPass,
      cleanPass: rendererCleanPass && mainCleanPass,
    };
  }

  async function finalizeDiagnostics() {
    await drainMainDiagnosticStreams();
    await drainDiagnosticWork();
    const summary = diagnostics();
    if (summary.rendererErrorCount > 0 || summary.pageErrors.length > 0) {
      throw new RendererDiagnosticsError(summary, rendererErrors);
    }
    if (!summary.mainCleanPass) {
      throw new MainProcessDiagnosticsError(summary);
    }
    return summary;
  }

  function workspacePath(name) {
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\u0000")
    ) {
      throw new Error(`invalid product journey workspace name: ${name}`);
    }
    const workspace = path.join(tmpRoot, name);
    if (path.dirname(workspace) !== tmpRoot) {
      throw new Error(`invalid product journey workspace name: ${name}`);
    }
    ownedWorkspaces.add(workspace);
    return workspace;
  }

  async function executeFixtureDml(workspace, statements) {
    if (fixtureDmlInFlight) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} serializes fixture DML operations`,
      );
    }
    fixtureDmlInFlight = true;
    try {
      if (
        typeof workspace !== "string" ||
        path.resolve(workspace) !== workspace ||
        !ownedWorkspaces.has(workspace)
      ) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires an exact harness-owned workspace path`,
        );
      }
      if (lastResources.app || launchInFlight) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires the renderer to be closed and no renderer launch to be in progress before fixture DML`,
        );
      }
      if (!Array.isArray(statements) || statements.length === 0) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires a non-empty statements[]`,
        );
      }
      const databasePath = path.join(workspace, "grimodex.db");
      let workspaceStat;
      let databaseStat;
      try {
        workspaceStat = await lstat(workspace);
        databaseStat = await lstat(databasePath);
      } catch (error) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires an existing workspace directory and database file`,
          { cause: error },
        );
      }
      if (!workspaceStat.isDirectory() || !databaseStat.isFile()) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects non-directory workspace or non-regular database`,
        );
      }
      const renderedStatements = statements.map((statement, index) => {
        if (
          !statement ||
          typeof statement !== "object" ||
          Array.isArray(statement)
        ) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires statement objects at ${index}`,
          );
        }
        return literalizeFixtureSql(statement.sql, statement.params, index);
      });
      const script = [
        "PRAGMA busy_timeout = 5000;",
        "BEGIN IMMEDIATE;",
        ...renderedStatements.map((statement) => `${statement};`),
        "COMMIT;",
      ].join("\n");
      await execFile("sqlite3", ["-bail", databasePath, script]);
      return { statementCount: renderedStatements.length };
    } finally {
      fixtureDmlInFlight = false;
    }
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
    if (fixtureDmlInFlight) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} blocks renderer launch while fixture DML is running`,
      );
    }
    if (launchInFlight) {
      throw new Error("product journey renderer launch is already in progress");
    }
    launchInFlight = true;
    try {
      return await launchRenderer(phase);
    } finally {
      launchInFlight = false;
    }
  }

  async function launchRenderer(phase) {
    await rm(retainedRendererPath, { force: true });
    recordTimeline("launch-requested", { phase });
    const env = { ...process.env };
    delete env.ELECTRON_RENDERER_URL;
    env.GRIMODEX_USER_DATA_DIR = userDataDir;
    env[PRODUCT_JOURNEY_AI_ENV] = PRODUCT_JOURNEY_AI_VERSION;
    const electronArgs =
      env.ELECTRON_DISABLE_SANDBOX === "1"
        ? ["--no-sandbox", mainCjs]
        : [mainCjs];
    const app = await electronLauncher.launch({
      executablePath: electronBin,
      args: electronArgs,
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
    attachMainDiagnosticStream(app, appProcess?.stderr, phase);
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
    await drainMainDiagnosticStream(app);
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
    await drainMainDiagnosticStreams();
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
        await drainMainDiagnosticStream(lastResources.app);
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
    executeFixtureDml,
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
