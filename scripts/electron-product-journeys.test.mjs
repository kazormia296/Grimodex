import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { closeElectronAppWithDiagnostics } from "../electron/scripts/close-electron-app.mjs";
import { PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";
import {
  createProductJourneyJournal,
  createProductJourneyHarness,
  invokeOk,
  isMainProcessErrorMessage,
  killProcessTree,
  NARRATIVE_MAINTENANCE_NONCE_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
  NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
  NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES,
  NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
  NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_MAX_BYTES,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE,
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE,
  PRODUCT_JOURNEY_PROCESS_EXIT_EVIDENCE,
  assertNarrativeMaintenanceCiReceipt,
  assertNarrativeMaintenanceCiHeldFreshnessReceipt,
  expectedNarrativeMaintenanceCiReceipt,
  readNarrativeMaintenanceCiHeldFreshness,
  narrativeMaintenanceReceiptRoot,
  MAIN_PROCESS_NOISE_ALLOWLIST,
  runWithLaneWatchdog,
  waitUntil,
  withOperationTimeout,
} from "../electron/scripts/product-journey-harness.mjs";
import {
  configureWorkspace,
  PRODUCT_JOURNEYS,
  selectPersistedFolderScopeAnchor,
} from "../electron/scripts/product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_FAULT_ENV,
  waitForProcessExit,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const execFile = promisify(execFileCallback);

test("folder scope anchor waits for the new folder's persisted rename", () => {
  const existing = new Set(["older-folder"]);
  const title = "Product Journey Folder";
  const rows = [
    { id: "older-folder", title },
    { id: "new-folder", title: "Part.1" },
  ];
  assert.equal(selectPersistedFolderScopeAnchor(rows, existing, title), null);
  rows[1].title = title;
  assert.deepEqual(selectPersistedFolderScopeAnchor(rows, existing, title), {
    id: "new-folder",
    title,
  });
});

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function runCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

test("Native lifecycle evidence preserves existing stderr classifications", () => {
  // Native records use E/P/J for returned-error/panic/non-panic JoinError.
  // Metadata cannot turn an already allowed retry into an extra CI failure.
  for (const cause of ["E", "P", "J"]) {
    const record = `[workspace-lifecycle-diag] ${JSON.stringify({
      version: 1,
      pid: 1,
      timestampMs: 1,
      producer: "freshness",
      cause,
      boundary: "handoff",
      site: null,
      revision: 3,
      state: "recovery-required",
      shutdownRequested: false,
      descriptorId: 1,
      owner: "Maintenance",
      rootOperationId: 1,
    })}`;
    assert.equal(isMainProcessErrorMessage(record), false);
    assert.equal(
      isMainProcessErrorMessage(`${record}\nactual worker failed`),
      true,
    );
  }
});

test("package.json exposes the runner and canonical product journey contracts", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["electron:product-journeys"],
    "node electron/scripts/product-journeys.mjs",
  );
  assert.ok(
    packageJson.scripts["test:product-journey-contracts"]
      .split(/\s+/)
      .includes("scripts/product-journey-mcp-client.test.mjs"),
    "canonical product journey contracts must include the MCP client tests",
  );
  assert.ok(
    packageJson.scripts["test:product-journey-contracts"]
      .split(/\s+/)
      .includes("scripts/codex-entity-relation-product-journey.test.mjs"),
    "canonical product journey contracts must include the NIR-1 Entity/Relation journey",
  );
});

const RECEIPT_NONCE = "00000000-0000-4000-8000-000000000001";
const RECEIPT_STALE_NONCE = "00000000-0000-4000-8000-000000000002";
const HELD_FRESHNESS_REQUEST_NONCE = "00000000-0000-4000-8000-000000000003";
const HELD_FRESHNESS_INITIAL_REQUEST_NONCE =
  "00000000-0000-4000-8000-000000000006";
const INTERRUPTED_RECEIPT_NONCE = "00000000-0000-4000-8000-000000000011";

function canonicalReceiptText(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function boundProcessExitEvidence(child, exitCode, signalCode) {
  const evidence = { exitCode, signalCode };
  Object.defineProperty(evidence, PRODUCT_JOURNEY_PROCESS_EXIT_EVIDENCE, {
    configurable: false,
    enumerable: false,
    value: child,
    writable: false,
  });
  return Object.freeze(evidence);
}

function childProcessStub({ stdout = null, stderr = null, pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

async function seedActiveLaneReceipt(env) {
  const expected = expectedNarrativeMaintenanceCiReceipt(env);
  if (!expected) return;
  const nonceDir = path.join(
    env.GRIMODEX_USER_DATA_DIR,
    NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
    expected.nonce,
  );
  await mkdir(nonceDir, { recursive: true });
  await writeFile(
    path.join(nonceDir, "receipt.json"),
    canonicalReceiptText(expected),
    { mode: 0o600 },
  );
}

function createActiveLaneHarness({
  artifactRoot,
  childProcess,
  closeApp,
  page: suppliedPage,
}) {
  const page = suppliedPage ?? {
    isClosed: () => false,
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcess,
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    launchTimeoutMs: 1_000,
    operationTimeoutMs: 1_000,
    electronLauncher: {
      launch: async ({ env }) => {
        await seedActiveLaneReceipt(env);
        return app;
      },
    },
    closeApp,
  });
  return { app, harness, page };
}

async function readRetainedDiagnostics(artifactRoot, artifactName) {
  return JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
}

function canonicalValueText(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValueText(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValueText(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createPromiseBarrier() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function awaitPromiseBarrierBeforeOperationSettles(barrier, operation, label) {
  return new Promise((resolve, reject) => {
    barrier.promise.then(resolve);
    operation.then(
      () =>
        reject(new Error(`${label} settled before its launcher-start barrier`)),
      (error) =>
        reject(
          new Error(`${label} settled before its launcher-start barrier`, {
            cause: error,
          }),
        ),
    );
  });
}

async function awaitPromiseBarrier(barrier, label, timeoutMs) {
  let timerId;
  try {
    await Promise.race([
      barrier.promise,
      new Promise((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

function heldFreshnessReceipt(
  sequence = 1,
  nonce = RECEIPT_NONCE,
  requestNonce = HELD_FRESHNESS_REQUEST_NONCE,
  phase = "held-freshness-file",
  requestedAt = "1970-01-01T00:00:00.000Z",
  observedAt = requestedAt,
  freshnessHoldProjectId = "project-hold",
) {
  const state = {
    authorityId: "authority-1",
    generation: 1,
    freshnessHoldProjectId,
    heldProjectId: freshnessHoldProjectId,
    projects: [],
    marker: null,
  };
  const stateDigest = `sha256:${createHash("sha256")
    .update(canonicalValueText(state), "utf8")
    .digest("hex")}`;
  return {
    version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
    type: NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE,
    nonce,
    requestNonce,
    phase,
    requestedAt,
    sequence,
    observedAt,
    monotonicObservedAtMs: sequence,
    workspaceBinding: { authorityId: "authority-1", generation: 1 },
    freshness: {
      cycleGeneration: sequence + 1,
      requestBarrierCycleGeneration: sequence,
      requestPublishedAtMs: Math.max(0, Date.parse(requestedAt) + sequence),
      cycleStartedAtMs: Math.max(1, Date.parse(requestedAt) + sequence + 1),
      observedAtMs: Math.max(1, Date.parse(requestedAt) + sequence + 1),
      inFlight: false,
      hasMore: false,
      noWrite: true,
      heldProjectId: freshnessHoldProjectId,
      cutoverNotReady: freshnessHoldProjectId !== null,
      wakePending: false,
      timerScheduled: false,
      nextCycleGuardStateDigest: null,
    },
    state: { ...state, stateDigest },
    stateDigest,
  };
}

const HELD_FRESHNESS_STUCK_LAUNCH_TIMEOUT_MS = 3_000;
const HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_TIMEOUT_MS = 2_500;
const HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_ITERATION_TIMEOUT_MS = 250;
const HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_POLL_INTERVAL_MS = 10;
const HUNG_SCREENSHOT_CAPTURE_TIMEOUT_MS = 5_000;
const HUNG_SCREENSHOT_STUB_TIMEOUT_MS = 1_000;
const HUNG_SCREENSHOT_ATTEMPT_TIMEOUT_MS =
  HUNG_SCREENSHOT_CAPTURE_TIMEOUT_MS - HUNG_SCREENSHOT_STUB_TIMEOUT_MS;
const HUNG_SCREENSHOT_CAPTURE_COMPLETION_TIMEOUT_MS = 2_000;
// The Electron contract worker runs alongside many independent test workers
// in the full acceptance command. Keep these test-only budgets above the
// journal/receipt setup cost without changing the product watchdogs.
const LOADED_ELECTRON_LANE_TIMEOUT_MS = 1_000;
const LOADED_ELECTRON_OPERATION_TIMEOUT_MS = 3_000;
const LOADED_ELECTRON_BARRIER_TIMEOUT_MS = 5_000;
const HANGING_CLEANUP_TIMEOUT_MS = 500;

async function awaitHeldFreshnessBeforeRequestBarrier(
  harness,
  {
    phase,
    requestNonce,
    workspaceBinding,
    timeoutMs = HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_TIMEOUT_MS,
  },
) {
  const requestPath = path.join(
    harness.receiptRoot,
    RECEIPT_NONCE,
    NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
  );
  const nonceDir = path.dirname(requestPath);
  const journalPhase = `${phase}/before-request`;
  let lastObservation = `root=${harness.receiptRoot}; request=unobserved`;

  try {
    await waitUntil(
      async () => {
        let request;
        try {
          request = JSON.parse(await readFile(requestPath, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") {
            lastObservation = `root=${harness.receiptRoot}; request=missing`;
            return false;
          }
          throw error;
        }
        const requestMatches =
          request?.nonce === RECEIPT_NONCE &&
          request?.requestNonce === requestNonce &&
          request?.phase === phase &&
          canonicalValueText(request?.workspaceBinding) ===
            canonicalValueText(workspaceBinding);

        let journalEntries;
        try {
          journalEntries = (await readFile(harness.journalPath, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch (error) {
          if (error?.code === "ENOENT") {
            lastObservation = `root=${harness.receiptRoot}; request=${requestMatches}; journal=missing`;
            return false;
          }
          throw error;
        }
        const reverifyCompleted = journalEntries.some(
          (entry) =>
            entry.operation === "receipt-revalidate" &&
            entry.phase === journalPhase &&
            entry.status === "completed",
        );
        const temporaryEntries = (await readdir(nonceDir)).filter((name) =>
          name.endsWith(".tmp"),
        );
        lastObservation =
          `root=${harness.receiptRoot}; request=${requestMatches}; ` +
          `reverify=${reverifyCompleted}; temporary=${temporaryEntries.join(",") || "none"}`;
        return (
          requestMatches && reverifyCompleted && temporaryEntries.length === 0
        );
      },
      `held-Freshness before-request barrier for ${phase}`,
      timeoutMs,
      HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_POLL_INTERVAL_MS,
      {
        iterationTimeoutMs: Math.min(
          HELD_FRESHNESS_BEFORE_REQUEST_BARRIER_ITERATION_TIMEOUT_MS,
          timeoutMs,
        ),
      },
    );
  } catch (error) {
    throw new Error(
      `held-Freshness before-request barrier failed for ${phase}: ${lastObservation}`,
      { cause: error },
    );
  }

  // Let the completed journal write and the reverify continuation settle
  // before publishing the deliberately stuck temp artifact.
  await new Promise((resolve) => setImmediate(resolve));
}

test("maintenance receipt contract is nonce-bound and exact", () => {
  const env = {
    CI: "true",
    [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    [NARRATIVE_MAINTENANCE_NONCE_ENV]: RECEIPT_NONCE,
  };
  const expected = expectedNarrativeMaintenanceCiReceipt(env);
  assert.deepEqual(expected, {
    version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
    type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
    nonce: RECEIPT_NONCE,
    active: true,
    setup: null,
    freshness: null,
    freshnessHoldProjectId: null,
    fault: null,
    trigger: null,
    isPackaged: false,
    nativeAck: true,
  });
  assert.deepEqual(
    assertNarrativeMaintenanceCiReceipt(expected, expected),
    expected,
  );
  const heldExpected = expectedNarrativeMaintenanceCiReceipt({
    ...env,
    [NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV]: "project-hold",
  });
  assert.equal(heldExpected.freshnessHoldProjectId, "project-hold");
  assert.equal(Object.hasOwn(heldExpected, "ownerToken"), false);

  for (const [label, candidate] of [
    ["missing", null],
    ["wrong nonce", { ...expected, nonce: RECEIPT_STALE_NONCE }],
    ["mismatch", { ...expected, trigger: "dependency-gap" }],
    ["owner token leak", { ...expected, ownerToken: "secret" }],
  ]) {
    assert.throws(
      () => assertNarrativeMaintenanceCiReceipt(candidate, expected),
      new RegExp(
        label === "missing"
          ? "receipt"
          : label === "wrong nonce"
            ? "nonce"
            : label === "owner token leak"
              ? "owner.*token"
              : label.replace(" ", ".*"),
        "i",
      ),
    );
  }
});

test("production env does not require an active maintenance receipt", () => {
  const expected = expectedNarrativeMaintenanceCiReceipt({ CI: "true" });
  assert.equal(expected, null);
  assert.throws(
    () =>
      assertNarrativeMaintenanceCiReceipt(
        {
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
          nonce: RECEIPT_NONCE,
          active: true,
          setup: null,
          freshness: null,
          fault: null,
          trigger: null,
          isPackaged: false,
          nativeAck: true,
        },
        expected,
      ),
    /unexpected/i,
  );
});

test("held-Freshness receipt is exact, digest-bound, nonce-bound, and size-bounded", () => {
  const receipt = heldFreshnessReceipt();
  assert.deepEqual(
    assertNarrativeMaintenanceCiHeldFreshnessReceipt(receipt, RECEIPT_NONCE, 1),
    receipt,
  );
  assert.ok(
    Buffer.byteLength(canonicalValueText(receipt), "utf8") <=
      NARRATIVE_MAINTENANCE_HELD_FRESHNESS_MAX_BYTES,
  );
  for (const [label, candidate] of [
    ["wrong nonce", { ...receipt, nonce: RECEIPT_STALE_NONCE }],
    ["sequence gap", { ...receipt, sequence: 2 }],
    ["extra field", { ...receipt, path: "/tmp/secret" }],
    [
      "unguarded timer",
      {
        ...receipt,
        freshness: { ...receipt.freshness, timerScheduled: true },
      },
    ],
  ]) {
    assert.throws(
      () =>
        assertNarrativeMaintenanceCiHeldFreshnessReceipt(
          candidate,
          RECEIPT_NONCE,
          1,
        ),
      label === "wrong nonce"
        ? /header|nonce/i
        : label === "sequence gap"
          ? /sequence.*contiguous|gap/i
          : label === "extra field"
            ? /unexpected|extra/i
            : label === "unguarded timer"
              ? /freshness|timer|unguarded/i
              : new RegExp(label.replace(" ", ".*"), "i"),
    );
  }
  const heldReceipt = heldFreshnessReceipt(
    1,
    RECEIPT_NONCE,
    HELD_FRESHNESS_REQUEST_NONCE,
    "held-freshness-held",
    "1970-01-01T00:00:00.000Z",
    "1970-01-01T00:00:00.000Z",
    "project-hold",
  );
  assert.equal(
    assertNarrativeMaintenanceCiHeldFreshnessReceipt(
      heldReceipt,
      RECEIPT_NONCE,
      1,
    ).freshness.heldProjectId,
    "project-hold",
  );
  assert.throws(
    () =>
      assertNarrativeMaintenanceCiHeldFreshnessReceipt(
        {
          ...heldReceipt,
          freshness: { ...heldReceipt.freshness, cutoverNotReady: false },
        },
        RECEIPT_NONCE,
        1,
      ),
    /freshness/i,
  );
});

test("harness accepts a file held-Freshness sequence independently of stdout", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => false,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcessStub({ stdout: new EventEmitter() }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    launchTimeoutMs: 100,
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        await writeFile(
          path.join(
            nonceDir,
            NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
          ),
          canonicalValueText({
            version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
            type: NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE,
            nonce: expected.nonce,
            requestNonce: HELD_FRESHNESS_INITIAL_REQUEST_NONCE,
            phase: "held-freshness-file",
            workspaceBinding: { authorityId: "authority-1", generation: 1 },
            requestedAt: "1970-01-01T00:00:00.000Z",
          }),
          { mode: 0o600 },
        );
        await writeFile(
          path.join(nonceDir, "held-freshness-0000000001.json"),
          canonicalValueText(
            heldFreshnessReceipt(
              1,
              RECEIPT_NONCE,
              HELD_FRESHNESS_INITIAL_REQUEST_NONCE,
            ),
          ),
          { mode: 0o600 },
        );
        return app;
      },
    },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await harness.dispose({ success: true, name: "held-freshness-file" });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
    }
  });
  const launched = await harness.launch("held-freshness-file");
  assert.equal(launched.heldFreshnessArtifact.receipt.sequence, 1);
  const firstHeldFreshnessPath = path.join(
    harness.receiptRoot,
    RECEIPT_NONCE,
    "held-freshness-0000000001.json",
  );
  const firstHeldFreshness = JSON.parse(
    await readFile(firstHeldFreshnessPath, "utf8"),
  );
  const initialRequest = JSON.parse(
    await readFile(
      path.join(
        harness.receiptRoot,
        RECEIPT_NONCE,
        NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
      ),
      "utf8",
    ),
  );
  await writeFile(
    firstHeldFreshnessPath,
    canonicalValueText({
      ...firstHeldFreshness,
      observedAt: "1970-01-01T00:00:00.003Z",
      freshness: {
        ...firstHeldFreshness.freshness,
        observedAtMs: firstHeldFreshness.freshness.observedAtMs + 1,
      },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    harness.awaitHeldFreshness(
      launched.app,
      "held-freshness-file/mutated-history",
      {
        previousSequence: 1,
        requestNonce: "00000000-0000-4000-8000-000000000007",
        authorityId: "authority-1",
        generation: 1,
        workspaceBinding: { authorityId: "authority-1", generation: 1 },
      },
    ),
    /changed|immutable|digest|sha/i,
  );
  await writeFile(
    firstHeldFreshnessPath,
    canonicalValueText(firstHeldFreshness),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(
      harness.receiptRoot,
      RECEIPT_NONCE,
      NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
    ),
    canonicalValueText(initialRequest),
    { mode: 0o600 },
  );
  await assert.rejects(
    harness.awaitHeldFreshness(
      launched.app,
      "held-freshness-file/missing-request-nonce",
      {
        previousSequence: 1,
        authorityId: "authority-1",
        generation: 1,
      },
    ),
    /caller-generated request nonce/i,
  );
  await assert.rejects(
    harness.awaitHeldFreshness(
      launched.app,
      "held-freshness-file/missing-previous-sequence",
      {
        requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
        authorityId: "authority-1",
        generation: 1,
        workspaceBinding: { authorityId: "authority-1", generation: 1 },
      },
    ),
    /previousSequence/i,
  );
  const secondReceipt = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const request = JSON.parse(
      await readFile(
        path.join(
          harness.receiptRoot,
          RECEIPT_NONCE,
          NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
        ),
        "utf8",
      ),
    );
    await writeFile(
      path.join(
        harness.receiptRoot,
        RECEIPT_NONCE,
        "held-freshness-0000000002.json",
      ),
      canonicalValueText(
        heldFreshnessReceipt(
          2,
          RECEIPT_NONCE,
          request.requestNonce,
          request.phase,
          request.requestedAt,
          new Date().toISOString(),
        ),
      ),
      { mode: 0o600 },
    );
  })();
  const fresh = await harness.awaitHeldFreshness(
    launched.app,
    "held-freshness-file/fresh",
    {
      previousSequence: 1,
      requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
      authorityId: "authority-1",
      generation: 1,
      workspaceBinding: { authorityId: "authority-1", generation: 1 },
    },
  );
  await secondReceipt;
  assert.equal(fresh.receipt.sequence, 2);
  assert.equal(
    (
      await harness.readHeldFreshness(
        launched.app,
        "held-freshness-file/fresh",
        {
          previousSequence: 1,
          requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
          authorityId: "authority-1",
          generation: 1,
          workspaceBinding: { authorityId: "authority-1", generation: 1 },
        },
      )
    ).receipt.sequence,
    2,
  );
  assert.equal(
    (
      await readNarrativeMaintenanceCiHeldFreshness(
        harness.receiptRoot,
        expectedNarrativeMaintenanceCiReceipt(process.env),
        "held-freshness-file/fresh",
        {
          previousSequence: 1,
          requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
          authorityId: "authority-1",
          generation: 1,
          workspaceBinding: { authorityId: "authority-1", generation: 1 },
        },
      )
    ).receipt.sequence,
    2,
  );
  const requestPath = path.join(
    harness.receiptRoot,
    RECEIPT_NONCE,
    NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
  );
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  await writeFile(
    requestPath,
    canonicalValueText({
      ...request,
      requestedAt: "1970-01-01T00:00:01.000Z",
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    readNarrativeMaintenanceCiHeldFreshness(
      harness.receiptRoot,
      expectedNarrativeMaintenanceCiReceipt(process.env),
      "held-freshness-file/fresh",
      {
        previousSequence: 1,
        requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
        authorityId: "authority-1",
        generation: 1,
        workspaceBinding: { authorityId: "authority-1", generation: 1 },
      },
    ),
    /stale request|binding/i,
  );
  await harness.close(launched.app, launched.page, "held-freshness-file");
  assert.deepEqual(await readdir(harness.receiptRoot), []);
});

test("harness tolerates the current held-Freshness temp until atomic rename", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => false,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcessStub({ stdout: new EventEmitter() }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    launchTimeoutMs: 120,
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        const request = {
          version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
          type: NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE,
          nonce: expected.nonce,
          requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
          phase: "held-freshness-temp",
          requestedAt: "1970-01-01T00:00:00.000Z",
          workspaceBinding: { authorityId: "authority-1", generation: 1 },
        };
        await writeFile(
          path.join(
            nonceDir,
            NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
          ),
          canonicalValueText(request),
          { mode: 0o600 },
        );
        const temporaryPath = path.join(
          nonceDir,
          "held-freshness-0000000001.json.tmp",
        );
        const finalPath = temporaryPath.slice(0, -4);
        await writeFile(
          temporaryPath,
          canonicalValueText(
            heldFreshnessReceipt(
              1,
              expected.nonce,
              request.requestNonce,
              request.phase,
              request.requestedAt,
            ),
          ),
          { mode: 0o600 },
        );
        setTimeout(() => {
          void rename(temporaryPath, finalPath);
        }, 25);
        return app;
      },
    },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await harness.dispose({ success: true, name: "held-freshness-temp" });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
    }
  });

  const launched = await harness.launch("held-freshness-temp");
  assert.equal(launched.heldFreshnessArtifact.receipt.sequence, 1);
  await harness.close(launched.app, launched.page, "held-freshness-temp");
});

test("harness retries only the current held-Freshness temp and reports a stuck temp", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => false,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcessStub({ stdout: new EventEmitter() }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    launchTimeoutMs: HELD_FRESHNESS_STUCK_LAUNCH_TIMEOUT_MS,
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        await writeFile(
          path.join(
            nonceDir,
            NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
          ),
          canonicalValueText({
            version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
            type: NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE,
            nonce: expected.nonce,
            requestNonce: HELD_FRESHNESS_REQUEST_NONCE,
            phase: "held-freshness-retry",
            requestedAt: "1970-01-01T00:00:00.000Z",
            workspaceBinding: { authorityId: "authority-1", generation: 1 },
          }),
          { mode: 0o600 },
        );
        await writeFile(
          path.join(nonceDir, "held-freshness-0000000001.json"),
          canonicalValueText(heldFreshnessReceipt()),
          { mode: 0o600 },
        );
        return app;
      },
    },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await harness.dispose({ success: true, name: "held-freshness-retry" });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
    }
  });

  const launched = await harness.launch("held-freshness-retry");
  const nextRequestNonce = "00000000-0000-4000-8000-000000000004";
  const transientWrite = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const nonceDir = path.join(harness.receiptRoot, RECEIPT_NONCE);
    const request = JSON.parse(
      await readFile(
        path.join(nonceDir, NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE),
        "utf8",
      ),
    );
    const temporaryPath = path.join(
      nonceDir,
      "held-freshness-0000000002.json.tmp",
    );
    await writeFile(
      temporaryPath,
      canonicalValueText(
        heldFreshnessReceipt(
          2,
          RECEIPT_NONCE,
          nextRequestNonce,
          request.phase,
          request.requestedAt,
          request.requestedAt,
        ),
      ),
      { mode: 0o600 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rename(temporaryPath, temporaryPath.slice(0, -4));
  })();
  const fresh = await harness.awaitHeldFreshness(
    launched.app,
    "held-freshness-retry",
    {
      previousSequence: 1,
      requestNonce: nextRequestNonce,
      authorityId: "authority-1",
      generation: 1,
      workspaceBinding: { authorityId: "authority-1", generation: 1 },
    },
  );
  await transientWrite;
  assert.equal(fresh.receipt.sequence, 2);

  const stuckRequestNonce = "00000000-0000-4000-8000-000000000005";
  const stuckTempPath = path.join(
    harness.receiptRoot,
    RECEIPT_NONCE,
    "held-freshness-0000000003.json.tmp",
  );
  const stuckWait = harness.awaitHeldFreshness(
    launched.app,
    "held-freshness-retry/stuck",
    {
      previousSequence: 2,
      requestNonce: stuckRequestNonce,
      authorityId: "authority-1",
      generation: 1,
      workspaceBinding: { authorityId: "authority-1", generation: 1 },
    },
  );
  try {
    await awaitHeldFreshnessBeforeRequestBarrier(harness, {
      phase: "held-freshness-retry/stuck",
      requestNonce: stuckRequestNonce,
      workspaceBinding: { authorityId: "authority-1", generation: 1 },
    });
  } catch (error) {
    await stuckWait.catch(() => undefined);
    throw error;
  }
  const stuckWrite = (async () => {
    const nonceDir = path.dirname(stuckTempPath);
    const request = JSON.parse(
      await readFile(
        path.join(nonceDir, NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE),
        "utf8",
      ),
    );
    await writeFile(
      stuckTempPath,
      canonicalValueText(
        heldFreshnessReceipt(
          3,
          RECEIPT_NONCE,
          stuckRequestNonce,
          request.phase,
          request.requestedAt,
          request.requestedAt,
        ),
      ),
      { mode: 0o600 },
    );
  })();
  await assert.rejects(stuckWait, /partial\/stuck/i);
  await stuckWrite;
  await rm(stuckTempPath, { force: true });
  await harness.close(launched.app, launched.page, "held-freshness-retry");
  assert.deepEqual(await readdir(harness.receiptRoot), []);
});

test("file receipt is accepted even when Playwright consumed stdout before launch resolved", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  try {
    const expected = expectedNarrativeMaintenanceCiReceipt(process.env);
    const stdout = new EventEmitter();
    const page = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => false,
    };
    const app = {
      context: () => null,
      firstWindow: async () => page,
      process: () => childProcessStub({ stdout }),
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      launchTimeoutMs: 100,
      electronLauncher: {
        launch: async ({ env }) => {
          // Simulate Playwright consuming the old stdout event before launch
          // returns.  The file artifact remains independently observable.
          stdout.emit("data", `${canonicalReceiptText(expected)}\n`);
          const nonceDir = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
          );
          await mkdir(nonceDir, { recursive: true });
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
            { mode: 0o600 },
          );
          return app;
        },
      },
      closeApp: async () => undefined,
    });
    t.after(() => harness.dispose({ success: true, name: "file-receipt" }));
    const launched = await harness.launch("file-receipt");
    assert.match(launched.launchId, /^launch-[0-9a-f-]{36}$/u);
    assert.equal(launched.launchReceipt.launchId, launched.launchId);
    assert.equal(launched.launchReceipt.receipt.nonce, RECEIPT_NONCE);
    assert.equal(
      launched.launchReceipt.sha256,
      launched.receiptArtifact.sha256,
    );
    assert.equal(launched.receiptArtifact.receipt.nonce, RECEIPT_NONCE);
    assert.match(launched.receiptArtifact.sha256, /^sha256:[0-9a-f]{64}$/);
    await harness.close(launched.app, launched.page, "file-receipt");
    assert.deepEqual(await readdir(harness.receiptRoot), []);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  }
});

test("receipt root rejects stale, wrong, partial, symlink, and duplicate artifacts", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  try {
    const expected = expectedNarrativeMaintenanceCiReceipt(process.env);
    const cases = [
      {
        name: "wrong-nonce",
        write: async (root) => {
          const nonceDir = path.join(root, RECEIPT_STALE_NONCE);
          await mkdir(nonceDir);
        },
        pattern: /nonce|root entries|clean/i,
      },
      {
        name: "mismatch",
        writeAfterLaunch: true,
        write: async (root) => {
          const nonceDir = path.join(root, expected.nonce);
          await mkdir(nonceDir);
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText({ ...expected, trigger: "dependency-gap" }),
          );
        },
        pattern: /mismatch|trigger/i,
      },
      {
        name: "missing",
        writeAfterLaunch: true,
        write: async () => undefined,
        pattern: /missing|receipt/i,
      },
      {
        name: "partial",
        writeAfterLaunch: true,
        write: async (root) => {
          const nonceDir = path.join(root, expected.nonce);
          await mkdir(nonceDir);
          await writeFile(path.join(nonceDir, "receipt.tmp"), "partial");
        },
        pattern: /partial|missing|receipt/i,
      },
      {
        name: "extra-file",
        writeAfterLaunch: true,
        write: async (root) => {
          const nonceDir = path.join(root, expected.nonce);
          await mkdir(nonceDir);
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
          );
          await writeFile(path.join(nonceDir, "unexpected"), "x");
        },
        pattern: /unexpected|entries/i,
      },
      {
        name: "duplicate-existing-dir",
        write: async (root) => {
          await mkdir(path.join(root, expected.nonce));
        },
        pattern: /clean/i,
      },
      {
        name: "symlink",
        writeAfterLaunch: true,
        write: async (root, harness) => {
          const target = path.join(
            harness?.tmpRoot ?? path.dirname(path.dirname(root)),
            "receipt-target",
          );
          await mkdir(target);
          await symlink(target, path.join(root, expected.nonce));
        },
        pattern: /symlink|entries|regular/i,
      },
      {
        name: "duplicate-same-content",
        writeAfterLaunch: true,
        write: async (root) => {
          const nonceDir = path.join(root, expected.nonce);
          await mkdir(nonceDir);
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
          );
          await writeFile(
            path.join(nonceDir, "receipt-copy.json"),
            canonicalReceiptText(expected),
          );
        },
        pattern: /unexpected|entries|duplicate/i,
      },
      {
        name: "duplicate-different-content",
        writeAfterLaunch: true,
        write: async (root) => {
          const nonceDir = path.join(root, expected.nonce);
          await mkdir(nonceDir);
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
          );
          await mkdir(path.join(root, RECEIPT_STALE_NONCE));
        },
        pattern: /entries|nonce|duplicate/i,
      },
    ];
    for (const testCase of cases) {
      const harness = createProductJourneyHarness({
        mainCjs: "/tmp/fake-main.cjs",
        electronBin: "/tmp/fake-electron",
        launchTimeoutMs: 20,
        electronLauncher: {
          launch: async ({ env }) => {
            if (testCase.writeAfterLaunch) {
              await testCase.write(
                path.join(
                  env.GRIMODEX_USER_DATA_DIR,
                  NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
                ),
              );
            }
            return {
              context: () => null,
              firstWindow: async () => ({
                on: () => undefined,
                evaluate: async () => [],
                waitForFunction: async () => undefined,
                isClosed: () => false,
              }),
              process: () => childProcessStub({ stdout: new EventEmitter() }),
            };
          },
        },
        closeApp: async () => undefined,
      });
      await mkdir(harness.receiptRoot, { recursive: true });
      if (!testCase.writeAfterLaunch) {
        await testCase.write(harness.receiptRoot, harness);
      }
      await assert.rejects(harness.launch(testCase.name), testCase.pattern);
      await harness.dispose({ success: false, name: testCase.name });
    }
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  }
});

test("interrupted process-exit cleanup consumes the exact receipt after close failure", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const childProcess = childProcessStub();
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => true,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcess,
  };
  let closeCalls = 0;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        return app;
      },
    },
    closeApp: async () => {
      closeCalls += 1;
      throw new Error("Target page, context or browser has been closed");
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "interrupted-close-failure",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const launched = await harness.launch("interrupted/close-failure");
  await assert.rejects(
    harness.close(launched.app, launched.page, "interrupted/close-failure"),
    /Target page, context or browser has been closed/,
  );
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      { exitCode: null, signalCode: null },
    ),
    /bound process exit evidence/,
  );
  assert.deepEqual(await readdir(harness.receiptRoot), [
    INTERRUPTED_RECEIPT_NONCE,
  ]);

  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(childProcess, 86, null),
    ),
    /before the bound process exits/,
  );

  childProcess.exitCode = 0;
  childProcess.signalCode = null;
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(childProcess, 0, null),
    ),
    /code 86/,
  );

  childProcess.exitCode = null;
  childProcess.signalCode = "SIGTERM";
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(childProcess, null, "SIGTERM"),
    ),
    /code 86|no signal/,
  );

  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(childProcess, 0, null),
    ),
    /mismatched process exit evidence/,
  );
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(childProcess, "86", null),
    ),
    /mismatched process exit evidence/,
  );

  const otherChildProcess = new EventEmitter();
  otherChildProcess.exitCode = 86;
  otherChildProcess.signalCode = null;
  await assert.rejects(
    harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
      launched.app,
      "interrupted/close-failure",
      boundProcessExitEvidence(otherChildProcess, 86, null),
    ),
    /bound app child process/,
  );

  await harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
    launched.app,
    "interrupted/close-failure",
    boundProcessExitEvidence(childProcess, 86, null),
  );

  assert.equal(closeCalls, 1);
  assert.deepEqual(await readdir(harness.receiptRoot), []);
});

test("process-interruption launch returns without touching a disappearing renderer", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const previousFault = process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;
  process.env[NARRATIVE_MAINTENANCE_FAULT_ENV] = "process-interruption";

  const childProcess = childProcessStub();
  let contextCalls = 0;
  let firstWindowCalls = 0;
  const app = {
    context: () => {
      contextCalls += 1;
      throw new Error("context must not run for process interruption");
    },
    firstWindow: async () => {
      firstWindowCalls += 1;
      throw new Error("firstWindow must not run for process interruption");
    },
    process: () => childProcess,
    close: async () => undefined,
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async ({ env }) => {
        await seedActiveLaneReceipt(env);
        return app;
      },
    },
  });
  t.after(async () => {
    if (childProcess.exitCode === null) {
      childProcess.exitCode = 86;
      childProcess.signalCode = null;
      childProcess.emit("exit", 86, null);
    }
    await harness
      .dispose({
        success: false,
        name: "process-interruption-launch-no-renderer",
      })
      .catch(() => undefined);
    await rm(harness.tmpRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
    if (previousFault === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
    else process.env[NARRATIVE_MAINTENANCE_FAULT_ENV] = previousFault;
  });

  const launched = await harness.launchForProcessInterruption(
    "interrupted/launch-no-renderer",
  );
  assert.equal(launched.page, null);
  assert.equal(launched.appProcess, childProcess);
  assert.equal(contextCalls, 0);
  assert.equal(firstWindowCalls, 0);

  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  await harness.close(
    launched.app,
    launched.page,
    "interrupted/launch-no-renderer",
    {
      expectedExitEvidence: boundProcessExitEvidence(childProcess, 86, null),
    },
  );
  assert.deepEqual(await readdir(harness.receiptRoot), []);
});

test("process-exit observation uses the launch-captured child after app disposal", async () => {
  const childProcess = childProcessStub();
  let processCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      if (processCalls > 1) throw new TypeError("disposed app.process");
      return childProcess;
    },
  };
  const capturedChild = app.process();
  const exitEvidence = waitForProcessExit(
    capturedChild,
    "captured child process",
    500,
  );
  setImmediate(() => {
    childProcess.exitCode = 86;
    childProcess.signalCode = null;
    childProcess.emit("exit", 86, null);
  });

  const observed = await exitEvidence;
  assert.equal(observed.exitCode, 86);
  assert.equal(observed.signalCode, null);
  assert.equal(observed[PRODUCT_JOURNEY_PROCESS_EXIT_EVIDENCE], childProcess);
  assert.equal(processCalls, 1);
});

test("post-exit close cleanup requires proof and retains disposed-close diagnostics", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const harnesses = [];
  function createDisposedCloseHarness({
    useDefaultClose = false,
    forgedClose = false,
    sameAppClose = false,
  } = {}) {
    const childProcess = childProcessStub();
    let disposed = false;
    let processCalls = 0;
    let closeCalls = 0;
    let realCloseCalls = 0;
    const page = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => true,
    };
    const app = {
      context: () => null,
      firstWindow: async () => page,
      process: () => {
        processCalls += 1;
        if (disposed) {
          throw new TypeError(
            "Cannot read properties of undefined (reading '_object')",
          );
        }
        return childProcess;
      },
      close: async () => {
        realCloseCalls += 1;
        closeCalls += 1;
        disposed = true;
        throw new TypeError(
          "Cannot read properties of undefined (reading '_object')",
        );
      },
    };
    const injectedCloseApp = useDefaultClose
      ? undefined
      : async (originalApp, _page, _phase, options) => {
          closeCalls += 1;
          disposed = true;
          if (sameAppClose) {
            originalApp.close = async () => {
              realCloseCalls += 1;
              throw new TypeError(
                "Cannot read properties of undefined (reading '_object')",
              );
            };
            return closeElectronAppWithDiagnostics(originalApp, null, _phase, {
              ...options,
              childProcess: options?.childProcess,
              skipProcessLookup: true,
              throwOnPostExitCloseError: true,
            });
          }
          if (forgedClose) {
            const fakeApp = {
              close: async () => {
                throw new TypeError(
                  "Cannot read properties of undefined (reading '_object')",
                );
              },
            };
            return closeElectronAppWithDiagnostics(fakeApp, null, _phase, {
              ...options,
              childProcess: options?.childProcess,
              skipProcessLookup: true,
              throwOnPostExitCloseError: true,
            });
          }
          void originalApp;
          throw new TypeError(
            "Cannot read properties of undefined (reading '_object')",
          );
        };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      electronLauncher: {
        launch: async ({ env }) => {
          const expected = expectedNarrativeMaintenanceCiReceipt(env);
          const nonceDir = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
          );
          await mkdir(nonceDir, { recursive: true });
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
            { mode: 0o600 },
          );
          return app;
        },
      },
      ...(injectedCloseApp ? { closeApp: injectedCloseApp } : {}),
    });
    harnesses.push(harness);
    return {
      app,
      childProcess,
      harness,
      get closeCalls() {
        return closeCalls;
      },
      get processCalls() {
        return processCalls;
      },
      get realCloseCalls() {
        return realCloseCalls;
      },
      page,
    };
  }

  t.after(async () => {
    await Promise.all(
      harnesses.map(async (harness) => {
        await harness.dispose({
          success: false,
          name: "post-exit-close-proof",
        });
        await rm(harness.tmpRoot, { recursive: true, force: true });
      }),
    );
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const valid = createDisposedCloseHarness({ useDefaultClose: true });
  const validLaunch = await valid.harness.launch("interrupted/disposed-valid");
  valid.childProcess.exitCode = 86;
  valid.childProcess.signalCode = null;
  await valid.harness.close(
    validLaunch.app,
    validLaunch.page,
    "interrupted/disposed-valid",
    {
      expectedExitEvidence: boundProcessExitEvidence(
        valid.childProcess,
        86,
        null,
      ),
    },
  );
  assert.equal(valid.processCalls, 1);
  assert.equal(valid.closeCalls, 1);
  assert.deepEqual(await readdir(valid.harness.receiptRoot), []);
  const validDiagnostics = valid.harness.finalizeDiagnostics
    ? await valid.harness.finalizeDiagnostics()
    : null;
  assert.equal(validDiagnostics.closeDiagnostics.length, 1);
  assert.deepEqual(validDiagnostics.closeDiagnostics[0], {
    at: validDiagnostics.closeDiagnostics[0].at,
    phase: "interrupted/disposed-valid",
    errorName: "TypeError",
    message: "Cannot read properties of undefined (reading '_object')",
  });
  assert.equal(validDiagnostics.cleanPass, true);
  const journalEntries = (await readFile(valid.harness.journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    journalEntries.some(
      (entry) =>
        entry.operation === "electron-close" && entry.status === "failed",
    ),
  );

  const noProof = createDisposedCloseHarness();
  const noProofLaunch = await noProof.harness.launch(
    "interrupted/disposed-without-proof",
  );
  noProof.childProcess.exitCode = 86;
  noProof.childProcess.signalCode = null;
  await assert.rejects(
    noProof.harness.close(
      noProofLaunch.app,
      noProofLaunch.page,
      "interrupted/disposed-without-proof",
    ),
    /Cannot read properties of undefined \(reading '_object'\)/,
  );
  assert.equal(noProof.closeCalls, 1);
  assert.equal(noProof.realCloseCalls, 0);
  assert.deepEqual(await readdir(noProof.harness.receiptRoot), [
    INTERRUPTED_RECEIPT_NONCE,
  ]);

  const mismatch = createDisposedCloseHarness();
  const mismatchLaunch = await mismatch.harness.launch(
    "interrupted/disposed-mismatch",
  );
  mismatch.childProcess.exitCode = 86;
  mismatch.childProcess.signalCode = null;
  const otherChildProcess = new EventEmitter();
  otherChildProcess.exitCode = 86;
  otherChildProcess.signalCode = null;
  await assert.rejects(
    mismatch.harness.close(
      mismatchLaunch.app,
      mismatchLaunch.page,
      "interrupted/disposed-mismatch",
      {
        expectedExitEvidence: boundProcessExitEvidence(
          otherChildProcess,
          86,
          null,
        ),
      },
    ),
    /bound app child process/,
  );
  assert.equal(mismatch.closeCalls, 0);
  assert.deepEqual(await readdir(mismatch.harness.receiptRoot), [
    INTERRUPTED_RECEIPT_NONCE,
  ]);

  const forged = createDisposedCloseHarness({ forgedClose: true });
  const forgedLaunch = await forged.harness.launch(
    "interrupted/disposed-forged",
  );
  forged.childProcess.exitCode = 86;
  forged.childProcess.signalCode = null;
  await assert.rejects(
    forged.harness.close(
      forgedLaunch.app,
      forgedLaunch.page,
      "interrupted/disposed-forged",
      {
        expectedExitEvidence: boundProcessExitEvidence(
          forged.childProcess,
          86,
          null,
        ),
      },
    ),
    /trusted default close helper/,
  );
  assert.equal(forged.closeCalls, 0);
  assert.equal(forged.realCloseCalls, 0);
  assert.equal(forged.harness.diagnostics().cleanPass, false);
  assert.equal(
    forged.harness.diagnostics().closeDiagnostics.at(-1).fatal,
    true,
  );
  assert.deepEqual(await readdir(forged.harness.receiptRoot), [
    INTERRUPTED_RECEIPT_NONCE,
  ]);

  const sameApp = createDisposedCloseHarness({ sameAppClose: true });
  const sameAppLaunch = await sameApp.harness.launch(
    "interrupted/disposed-same-app",
  );
  sameApp.childProcess.exitCode = 86;
  sameApp.childProcess.signalCode = null;
  await assert.rejects(
    sameApp.harness.close(
      sameAppLaunch.app,
      sameAppLaunch.page,
      "interrupted/disposed-same-app",
      {
        expectedExitEvidence: boundProcessExitEvidence(
          sameApp.childProcess,
          86,
          null,
        ),
      },
    ),
    /trusted default close helper/,
  );
  assert.equal(sameApp.closeCalls, 0);
  assert.equal(sameApp.realCloseCalls, 0);
  assert.equal(sameApp.harness.diagnostics().cleanPass, false);
  assert.equal(
    sameApp.harness.diagnostics().closeDiagnostics.at(-1).fatal,
    true,
  );
  assert.deepEqual(await readdir(sameApp.harness.receiptRoot), [
    INTERRUPTED_RECEIPT_NONCE,
  ]);
});

test("post-exit proof does not widen journal or unexpected-close failures", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const cases = ["journal-start", "journal-finalize", "unexpected-close"];
  const harnesses = [];
  const journalRoots = [];
  async function createCaseHarness(testCase) {
    const journalRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-post-exit-journal-"),
    );
    journalRoots.push(journalRoot);
    const journalPath = path.join(journalRoot, "operations.jsonl");
    const childProcess = childProcessStub();
    const page = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => true,
    };
    const app = {
      context: () => null,
      firstWindow: async () => page,
      process: () => childProcess,
    };
    let receiptPath;
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      journalPath,
      electronLauncher: {
        launch: async ({ env }) => {
          const expected = expectedNarrativeMaintenanceCiReceipt(env);
          receiptPath = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
            "receipt.json",
          );
          await mkdir(path.dirname(receiptPath), { recursive: true });
          await writeFile(receiptPath, canonicalReceiptText(expected), {
            mode: 0o600,
          });
          return app;
        },
      },
      closeApp: async (_app, _page, phase, options) => {
        if (testCase === "journal-finalize") {
          await rm(journalPath, { force: true });
          await mkdir(journalPath);
        }
        if (testCase === "unexpected-close") {
          throw new Error("unexpected close I/O failure");
        }
        throw new TypeError(
          "Cannot read properties of undefined (reading '_object')",
        );
      },
    });
    harnesses.push({
      harness,
      childProcess,
      journalPath,
      receiptPathRef: () => receiptPath,
    });
    return {
      harness,
      childProcess,
      journalPath,
      get receiptPath() {
        return receiptPath;
      },
    };
  }

  t.after(async () => {
    await Promise.all(
      harnesses.map(({ harness }) =>
        harness.dispose({
          success: false,
          name: "post-exit-journal-boundary",
        }),
      ),
    );
    await Promise.all(
      journalRoots.map((root) => rm(root, { recursive: true, force: true })),
    );
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  for (const testCase of cases) {
    const current = await createCaseHarness(testCase);
    const phase = `interrupted/${testCase}`;
    const launched = await current.harness.launch(phase);
    current.childProcess.exitCode = 86;
    current.childProcess.signalCode = null;
    if (testCase === "journal-start") {
      await rm(current.journalPath, { force: true });
      await mkdir(current.journalPath);
    }

    await assert.rejects(
      current.harness.close(launched.app, launched.page, phase, {
        expectedExitEvidence: boundProcessExitEvidence(
          current.childProcess,
          86,
          null,
        ),
      }),
    );
    const diagnostics = current.harness.diagnostics();
    assert.equal(diagnostics.cleanPass, false);
    assert.equal(diagnostics.closeDiagnostics.at(-1).fatal, true);
    assert.deepEqual(await readdir(current.harness.receiptRoot), [
      INTERRUPTED_RECEIPT_NONCE,
    ]);
  }
});

test("harness forwards the launch-captured child to the default close helper after disposal", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const childProcess = childProcessStub();
  let disposed = false;
  let processCalls = 0;
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => true,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => {
      processCalls += 1;
      if (disposed) throw new TypeError("disposed app.process");
      return childProcess;
    },
    close: async () => {
      disposed = true;
      throw new TypeError(
        "Cannot read properties of undefined (reading '_object')",
      );
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        return app;
      },
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "default-close-forwarding",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const launched = await harness.launch("interrupted/default-close-forwarding");
  childProcess.exitCode = 86;
  childProcess.signalCode = null;
  await harness.close(
    launched.app,
    launched.page,
    "interrupted/default-close-forwarding",
    {
      expectedExitEvidence: boundProcessExitEvidence(childProcess, 86, null),
    },
  );

  assert.equal(launched.appProcess, childProcess);
  assert.equal(processCalls, 1);
  assert.deepEqual(await readdir(harness.receiptRoot), []);
  const diagnostics = await harness.finalizeDiagnostics();
  assert.equal(diagnostics.cleanPass, true);
  assert.equal(diagnostics.closeDiagnostics.length, 1);
});

test("renderer launch fails closed when the initial child cannot be captured", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  let processCalls = 0;
  const closeOptions = [];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-initial-capture-"),
  );
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => true,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => {
      processCalls += 1;
      throw new TypeError("child process is unavailable");
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        const nonceDir = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
        );
        await mkdir(nonceDir, { recursive: true });
        await writeFile(
          path.join(nonceDir, "receipt.json"),
          canonicalReceiptText(expected),
          { mode: 0o600 },
        );
        return app;
      },
    },
    artifactRoot,
    closeApp: async (_app, _page, _phase, options) => {
      closeOptions.push(options);
      throw new Error("initial cleanup failed");
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "initial-child-capture-failure",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  await assert.rejects(
    harness.launch("initial-child-capture-failure"),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /child process is unavailable/);
      assert.match(error.errors[1].message, /initial cleanup failed/);
      return true;
    },
  );
  assert.equal(processCalls, 1);

  await harness.dispose({
    success: false,
    name: "initial-child-capture-failure",
  });
  assert.equal(processCalls, 1);
  assert.equal(closeOptions.length, 1);
  assert.equal(closeOptions[0].childProcess, undefined);
  assert.equal(closeOptions[0].skipProcessLookup, true);
  const diagnostics = harness.diagnostics();
  assert.equal(diagnostics.cleanPass, false);
  assert.equal(diagnostics.closeDiagnostics?.length, 2);
  assert.ok(
    diagnostics.closeDiagnostics.some(
      (issue) =>
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.fatal === true,
    ),
  );
  assert.ok(
    diagnostics.closeDiagnostics.some(
      (issue) =>
        issue.errorName === "Error" &&
        issue.fatal === true &&
        issue.message.endsWith("initial cleanup failed"),
    ),
  );
  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "initial-child-capture-failure",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.equal(retainedDiagnostics.closeDiagnostics?.length, 2);
  assert.ok(
    retainedDiagnostics.closeDiagnostics.some(
      (issue) => issue.errorName === "ElectronChildProcessCaptureError",
    ),
  );
  assert.ok(
    retainedDiagnostics.closeDiagnostics.some((issue) =>
      issue.message.endsWith("initial cleanup failed"),
    ),
  );
});

test("late launch without a child fails closed without a second process lookup", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-late-child-capture-"),
  );
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  let resolveLaunch;
  const launchPromise = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  let processCalls = 0;
  let closeCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      throw new TypeError("late child process is unavailable");
    },
    close: async () => {
      closeCalls += 1;
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    launchTimeoutMs: 10,
    operationTimeoutMs: 10,
    electronLauncher: {
      launch: () => {
        electronLaunchStarted.resolve();
        return launchPromise;
      },
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "late-child-capture-failure",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const launch = harness.launch("late-child-capture-failure");
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    launch,
    "late-child-capture-failure",
  );
  await assert.rejects(launch, /timed out/);
  resolveLaunch(app);
  await harness.dispose({
    success: false,
    name: "late-child-capture-failure",
  });

  assert.equal(processCalls, 1);
  assert.equal(closeCalls, 1);
  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "late-child-capture-failure",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.message.includes("cannot verify process termination"),
    ),
    JSON.stringify(retainedDiagnostics),
  );
  const diagnostics = harness.diagnostics();
  assert.equal(diagnostics.cleanPass, false);
  assert.ok(
    diagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.message.includes("cannot verify process termination"),
    ),
  );
});

test("launch timeout fallback records unverified cleanup when no app resolves", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-no-late-launch-"),
  );
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const launchPromise = new Promise(() => {});
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
    launchTimeoutMs: 10,
    operationTimeoutMs: 10,
    electronLauncher: {
      launch: () => launchPromise,
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "no-late-launch-resolution",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  await assert.rejects(
    harness.launch("no-late-launch-resolution"),
    /timed out/,
  );
  await harness.dispose({
    success: false,
    name: "no-late-launch-resolution",
  });

  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "no-late-launch-resolution",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.message.includes("cannot verify process termination"),
    ),
    JSON.stringify(retainedDiagnostics),
  );
});

test("late cleanup owns the capture when it starts before the fallback deadline", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-late-cleanup-deadline-"),
  );
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  let resolveLaunch;
  const launchPromise = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  let resolveClose;
  let resolveCloseStarted;
  const closeStarted = new Promise((resolve) => {
    resolveCloseStarted = resolve;
  });
  const closeCompletion = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const app = {
    process: () => {
      throw new TypeError("late child process is unavailable");
    },
    close: () => {
      resolveCloseStarted();
      return closeCompletion;
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
    launchTimeoutMs: 10,
    operationTimeoutMs: 10,
    electronLauncher: {
      launch: () => launchPromise,
    },
  });
  t.after(async () => {
    resolveClose?.();
    resolveLaunch?.(app);
    await harness.dispose({
      success: false,
      name: "late-cleanup-deadline",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  await assert.rejects(harness.launch("late-cleanup-deadline"), /timed out/);
  setTimeout(() => resolveLaunch(app), HANGING_CLEANUP_TIMEOUT_MS / 2);
  await closeStarted;
  await harness.dispose({ success: false, name: "late-cleanup-deadline" });

  const diagnostics = harness.diagnostics();
  assert.equal(diagnostics.cleanPass, false);
  assert.ok(
    diagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyOperationTimeoutError",
    ),
    JSON.stringify(diagnostics),
  );
  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "late-cleanup-deadline",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError",
    ),
    JSON.stringify(retainedDiagnostics),
  );
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyOperationTimeoutError",
    ),
    JSON.stringify(retainedDiagnostics),
  );
  resolveClose();
});

test("lane watchdog waits for late Electron cleanup before publishing evidence", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-lane-late-finalizer-"),
  );
  let resolveLaunch;
  const launchPromise = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  const childProcess = childProcessStub({ pid: 424300 });
  childProcess.killSignals = [];
  childProcess.kill = (signal) => {
    childProcess.killSignals.push(signal);
    childProcess.exitCode = 0;
    return true;
  };
  let closeCalls = 0;
  const app = {
    process: () => childProcess,
    close: async () => {
      closeCalls += 1;
      childProcess.exitCode = 0;
    },
  };
  const phase = "probe/lane-late-finalizer";
  const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    launchTimeoutMs: LOADED_ELECTRON_LANE_TIMEOUT_MS + 500,
    operationTimeoutMs: 1_000,
    electronLauncher: {
      launch: () => {
        electronLaunchStarted.resolve();
        setTimeout(() => resolveLaunch(app), laneTimeoutMs + 50);
        return launchPromise;
      },
    },
    closeApp: async (value, page, reason, options) =>
      app.close(value, page, reason, options),
  });
  t.after(async () => {
    resolveLaunch?.(app);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.dispose({ success: false, name: "lane-late-finalizer" });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const running = harness.withLaneWatchdog(() => harness.launch(phase), {
    phase,
    timeoutMs: laneTimeoutMs,
  });
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    running,
    phase,
  );
  await assert.rejects(running, /watchdog|aborted|timed out/i);

  assert.equal(closeCalls, 1);
  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "probe-lane-late-finalizer",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(retainedDiagnostics),
  );
  const journal = (await readFile(harness.journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    journal.some(
      (entry) =>
        entry.operation === "electron-close" && entry.status === "completed",
    ),
    JSON.stringify(journal),
  );
});

test("active lane cleanup publishes close rejection and unverified child termination", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-active-close-reject-"),
  );
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const childProcess = childProcessStub({ pid: 424302 });
  childProcess.killSignals = [];
  childProcess.kill = (signal) => {
    childProcess.killSignals.push(signal);
    return false;
  };
  const phase = "probe/active-close-reject";
  const artifactName = "probe-active-close-reject";
  const { harness } = createActiveLaneHarness({
    artifactRoot,
    childProcess,
    closeApp: async () => {
      throw new Error("active close rejected");
    },
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  await harness.launch(phase);
  const running = harness.withLaneWatchdog(() => new Promise(() => {}), {
    phase,
    timeoutMs: 15,
  });
  await assert.rejects(running, /watchdog.*active-close-reject/i);

  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "Error" &&
        issue.message.endsWith("active close rejected"),
    ),
    JSON.stringify(retainedDiagnostics),
  );
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessTerminationError" &&
        issue.message.includes("child.kill(SIGTERM) returned false"),
    ),
    JSON.stringify(retainedDiagnostics),
  );
  assert.ok(
    retainedDiagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(retainedDiagnostics),
  );
  assert.deepEqual(
    await readdir(artifactRoot),
    [artifactName],
    "lane failure must publish exactly one artifact",
  );
  const journal = await readFile(
    path.join(artifactRoot, artifactName, "runtime", "operations.jsonl"),
    "utf8",
  );
  assert.match(journal, /"operation":"electron-close"/u);
  assert.match(journal, /"status":"failed"/u);

  const signalsAfterLaneCleanup = [...childProcess.killSignals];
  await harness.dispose({ success: false, name: artifactName });
  assert.deepEqual(
    childProcess.killSignals,
    signalsAfterLaneCleanup,
    "dispose must reuse the completed lane cleanup",
  );
});

test("active lane ignores a false kill result when the child exit is verified", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-active-kill-verified-"),
  );
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const childProcess = childProcessStub({ pid: 424303 });
  childProcess.killSignals = [];
  childProcess.kill = (signal) => {
    childProcess.killSignals.push(signal);
    if (signal === "SIGTERM") {
      setImmediate(() => {
        childProcess.exitCode = 0;
        childProcess.signalCode = null;
        childProcess.emit("exit", 0, null);
        childProcess.emit("close", 0, null);
      });
    }
    return false;
  };
  const phase = "probe/active-kill-verified";
  const artifactName = "probe-active-kill-verified";
  const { harness } = createActiveLaneHarness({
    artifactRoot,
    childProcess,
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  await harness.launch(phase);
  await assert.rejects(
    harness.withLaneWatchdog(() => new Promise(() => {}), {
      phase,
      timeoutMs: 15,
    }),
    /watchdog.*active-kill-verified/i,
  );

  const retainedDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(retainedDiagnostics.cleanPass, false);
  assert.deepEqual(
    retainedDiagnostics.closeDiagnostics?.map((issue) => issue.errorName),
    ["ProductJourneyLaneWatchdogError"],
    JSON.stringify(retainedDiagnostics),
  );
  assert.deepEqual(childProcess.killSignals, ["SIGTERM"]);
  const signalsAfterLaneCleanup = [...childProcess.killSignals];
  await harness.dispose({ success: false, name: artifactName });
  assert.deepEqual(childProcess.killSignals, signalsAfterLaneCleanup);
});

test("late valid launches persist close and termination failures before capture", async (t) => {
  const scenarios = [
    {
      name: "late-valid-close-reject",
      close: () => Promise.reject(new Error("late default close failed")),
      kill: () => false,
      closeErrorName: "Error",
    },
    {
      name: "late-valid-close-hang",
      closeErrorName: "ProductJourneyOperationTimeoutError",
      kill: () => {
        throw new Error("late child kill failed");
      },
    },
  ];
  for (const scenario of scenarios) {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), `grimodex-product-${scenario.name}-`),
    );
    let resolveLaunch;
    const launchPromise = new Promise((resolve) => {
      resolveLaunch = resolve;
    });
    let resolveClose;
    const childProcess = childProcessStub({ pid: 424301 });
    childProcess.killSignals = [];
    childProcess.kill = (signal) => {
      childProcess.killSignals.push(signal);
      if (scenario.kill) return scenario.kill(signal);
      return false;
    };
    const app = {
      process: () => childProcess,
      close:
        scenario.close ??
        (() =>
          new Promise((resolve) => {
            resolveClose = resolve;
          })),
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      artifactRoot,
      failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
      launchTimeoutMs: 10,
      operationTimeoutMs: 10,
      electronLauncher: {
        launch: () => launchPromise,
      },
    });
    try {
      await assert.rejects(harness.launch(scenario.name), /timed out/);
      resolveLaunch(app);
      await harness.dispose({ success: false, name: scenario.name });
      const retainedDiagnostics = JSON.parse(
        await readFile(
          path.join(
            artifactRoot,
            scenario.name,
            "runtime",
            "diagnostics",
            "renderer-diagnostics.json",
          ),
          "utf8",
        ),
      );
      assert.equal(retainedDiagnostics.cleanPass, false);
      assert.ok(
        retainedDiagnostics.closeDiagnostics?.some(
          (issue) =>
            issue.fatal === true && issue.errorName === scenario.closeErrorName,
        ),
        JSON.stringify(retainedDiagnostics),
      );
      assert.ok(
        retainedDiagnostics.closeDiagnostics?.some(
          (issue) =>
            issue.fatal === true &&
            issue.errorName === "ElectronChildProcessTerminationError" &&
            issue.message.includes("termination"),
        ),
        JSON.stringify(retainedDiagnostics),
      );
      if (resolveClose) resolveClose();
    } finally {
      await harness.dispose({ success: false, name: scenario.name });
      await rm(harness.tmpRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("late close timeout treats a concurrent verified exit as authoritative", async (t) => {
  for (const [label, killBehavior] of [
    ["false", () => false],
    [
      "throw",
      () => {
        throw new Error("late verified kill threw");
      },
    ],
  ]) {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), `grimodex-product-late-verified-${label}-`),
    );
    let resolveLaunch;
    const launchPromise = new Promise((resolve) => {
      resolveLaunch = resolve;
    });
    const childProcess = childProcessStub({
      pid: label === "false" ? 424307 : 424308,
    });
    childProcess.killSignals = [];
    childProcess.kill = (signal) => {
      childProcess.killSignals.push(signal);
      queueMicrotask(() => {
        childProcess.exitCode = 0;
        childProcess.signalCode = null;
        childProcess.emit("exit", 0, null);
        childProcess.emit("close", 0, null);
      });
      return killBehavior();
    };
    const app = {
      process: () => childProcess,
      close: () => new Promise(() => {}),
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      artifactRoot,
      failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
      launchTimeoutMs: 10,
      operationTimeoutMs: 10,
      electronLauncher: {
        launch: () => launchPromise,
      },
    });
    const phase = `observability/late-verified-${label}`;
    const artifactName = phase.replaceAll("/", "-");
    try {
      await assert.rejects(harness.launch(phase), /timed out/);
      resolveLaunch(app);
      await harness.dispose({ success: false, name: artifactName });

      const retainedDiagnostics = await readRetainedDiagnostics(
        artifactRoot,
        artifactName,
      );
      assert.equal(retainedDiagnostics.cleanPass, false);
      assert.ok(
        retainedDiagnostics.closeDiagnostics?.some(
          (issue) =>
            issue.fatal === true &&
            issue.errorName === "ProductJourneyOperationTimeoutError",
        ),
        JSON.stringify(retainedDiagnostics),
      );
      assert.equal(
        retainedDiagnostics.closeDiagnostics?.some(
          (issue) =>
            issue.fatal === true &&
            issue.errorName === "ElectronChildProcessTerminationError",
        ),
        false,
        JSON.stringify(retainedDiagnostics),
      );
      assert.deepEqual(childProcess.killSignals, ["SIGTERM"]);
      assert.deepEqual(await readdir(artifactRoot), [artifactName]);
    } finally {
      await harness.dispose({ success: false, name: artifactName });
      await rm(harness.tmpRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("late launch without a child aggregates Playwright cleanup failure", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  let resolveLaunch;
  const launchPromise = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  let processCalls = 0;
  let closeCalls = 0;
  const app = {
    process: () => {
      processCalls += 1;
      throw new TypeError("late child process is unavailable");
    },
    close: async () => {
      closeCalls += 1;
      throw new Error("late Playwright cleanup failed");
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    launchTimeoutMs: 10,
    operationTimeoutMs: 10,
    electronLauncher: {
      launch: () => {
        electronLaunchStarted.resolve();
        return launchPromise;
      },
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "late-child-capture-close-failure",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const launch = harness.launch("late-child-capture-close-failure");
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    launch,
    "late-child-capture-close-failure",
  );
  await assert.rejects(launch, /timed out/);
  resolveLaunch(app);
  await harness.dispose({
    success: false,
    name: "late-child-capture-close-failure",
  });

  assert.equal(processCalls, 1);
  assert.equal(closeCalls, 1);
  const diagnostics = harness.diagnostics();
  assert.equal(diagnostics.cleanPass, false);
  assert.ok(
    diagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.message.includes("cannot verify process termination"),
    ),
  );
  assert.ok(
    diagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "Error" &&
        issue.message.endsWith("late Playwright cleanup failed"),
    ),
    JSON.stringify(diagnostics.closeDiagnostics),
  );
});

test("receipt consumption failure retains the child for final cleanup", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const childProcess = childProcessStub();
  childProcess.killSignals = [];
  childProcess.kill = (signal) => childProcess.killSignals.push(signal);
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => true,
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcess,
  };
  const closeCalls = [];
  let receiptPath;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async ({ env }) => {
        const expected = expectedNarrativeMaintenanceCiReceipt(env);
        receiptPath = path.join(
          env.GRIMODEX_USER_DATA_DIR,
          NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
          expected.nonce,
          "receipt.json",
        );
        await mkdir(path.dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, canonicalReceiptText(expected), {
          mode: 0o600,
        });
        return app;
      },
    },
    closeApp: async (closedApp, closedPage, phase, options) => {
      closeCalls.push({ closedApp, closedPage, phase, options });
    },
  });
  t.after(async () => {
    await harness.dispose({
      success: false,
      name: "receipt-consumption-failure",
    });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  const launched = await harness.launch("receipt-consumption-failure");
  const expected = expectedNarrativeMaintenanceCiReceipt(process.env);
  await writeFile(
    receiptPath,
    canonicalReceiptText({ ...expected, trigger: "dependency-gap" }),
  );
  await assert.rejects(
    harness.close(launched.app, launched.page, "receipt-consumption-failure"),
    /trigger|mismatch|receipt/i,
  );

  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].options.childProcess, childProcess);

  await harness.dispose({
    success: false,
    name: "receipt-consumption-failure",
  });
  assert.equal(closeCalls.length, 2);
  assert.equal(closeCalls[1].options.childProcess, childProcess);
  assert.deepEqual(childProcess.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("interrupted process-exit cleanup keeps wrong, foreign, and partial receipts", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = INTERRUPTED_RECEIPT_NONCE;

  const cases = ["wrong", "foreign", "partial"];
  const harnesses = [];
  t.after(async () => {
    await Promise.all(
      harnesses.map(async (harness) => {
        await harness.dispose({
          success: false,
          name: "interrupted-receipt-boundary",
        });
        await rm(harness.tmpRoot, { recursive: true, force: true });
      }),
    );
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  });

  for (const testCase of cases) {
    const childProcess = childProcessStub();
    const page = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => true,
    };
    const app = {
      context: () => null,
      firstWindow: async () => page,
      process: () => childProcess,
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      electronLauncher: {
        launch: async ({ env }) => {
          const expected = expectedNarrativeMaintenanceCiReceipt(env);
          const nonceDir = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
          );
          await mkdir(nonceDir, { recursive: true });
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText(expected),
            { mode: 0o600 },
          );
          return app;
        },
      },
      closeApp: async () => {
        throw new Error("close failed after process exit");
      },
    });
    harnesses.push(harness);
    const phase = `interrupted/receipt-${testCase}`;
    const launched = await harness.launch(phase);
    await assert.rejects(harness.close(launched.app, launched.page, phase));
    childProcess.exitCode = 86;
    childProcess.signalCode = null;
    const expectedDir = path.join(
      harness.receiptRoot,
      INTERRUPTED_RECEIPT_NONCE,
    );
    if (testCase === "wrong") {
      await rm(expectedDir, { recursive: true, force: true });
      await mkdir(path.join(harness.receiptRoot, RECEIPT_STALE_NONCE));
    } else if (testCase === "foreign") {
      await mkdir(path.join(harness.receiptRoot, RECEIPT_STALE_NONCE));
    } else {
      await writeFile(path.join(expectedDir, "receipt.tmp"), "partial", {
        mode: 0o600,
      });
    }
    await assert.rejects(
      harness.consumeNarrativeMaintenanceReceiptAfterProcessExit(
        launched.app,
        phase,
        boundProcessExitEvidence(childProcess, 86, null),
      ),
      /mismatch|partial|entries|clean/i,
    );
    const entries = await readdir(harness.receiptRoot);
    assert.ok(entries.length > 0, `${testCase} receipt evidence was deleted`);
  }
});

test("production launch ignores consumed stdout but rejects any receipt file", async (t) => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  delete process.env.CI;
  try {
    const stdout = new EventEmitter();
    const page = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => false,
    };
    const app = {
      context: () => null,
      firstWindow: async () => page,
      process: () => childProcessStub({ stdout }),
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      launchTimeoutMs: 30,
      electronLauncher: {
        launch: async () => {
          stdout.emit(
            "data",
            `${canonicalReceiptText({
              version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
              type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
              nonce: RECEIPT_NONCE,
              active: true,
              setup: null,
              freshness: null,
              fault: null,
              trigger: null,
              isPackaged: false,
              nativeAck: true,
            })}\n`,
          );
          return app;
        },
      },
      closeApp: async () => undefined,
    });
    t.after(() => harness.dispose({ success: true, name: "production-file" }));
    const launched = await harness.launch("production-file");
    await harness.close(launched.app, launched.page, "production-file");

    const failingHarness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      launchTimeoutMs: 30,
      electronLauncher: {
        launch: async ({ env }) => {
          const nonceDir = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            RECEIPT_NONCE,
          );
          await mkdir(nonceDir, { recursive: true });
          await writeFile(
            path.join(nonceDir, "receipt.json"),
            canonicalReceiptText({
              version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
              type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
              nonce: RECEIPT_NONCE,
              active: true,
              setup: null,
              freshness: null,
              fault: null,
              trigger: null,
              isPackaged: false,
              nativeAck: true,
            }),
          );
          return app;
        },
      },
      closeApp: async () => undefined,
    });
    await assert.rejects(
      failingHarness.launch("production-unexpected-file"),
      /unexpected|receipt/i,
    );
    await failingHarness.dispose({
      success: false,
      name: "production-unexpected-file",
    });
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  }
});

test("CI has a dedicated product-journeys gate with native Electron and SQLite", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const job = workflow.jobs["electron-product-journeys"];
  const electronJob = workflow.jobs.electron;

  assert.ok(job, "electron-product-journeys job is required");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const commands = runCommands(job);
  assert.match(commands, /pnpm exec playwright install-deps chromium/);
  assert.match(commands, /pnpm napi:build/);
  assert.match(commands, /pnpm electron:build/);
  assert.match(
    commands,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:product-journeys/,
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, "product journey failures must upload artifacts");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, ".artifacts/product-journeys");
  assert.equal(upload.with["retention-days"], 14);
  assert.match(
    runCommands(electronJob),
    /scripts\/product-journey-mcp-client\.test\.mjs/,
  );
});

test("CI pauses automatic triggers while preserving manual and reusable controls", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const input = workflow.on.workflow_call.inputs.product_journey_mode;
  const manualInput = workflow.on.workflow_dispatch.inputs.product_journey_mode;
  const job = workflow.jobs["electron-product-journeys"];
  const checkoutIndex = job.steps.findIndex((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  const selectorIndex = job.steps.findIndex(
    (step) => step.id === "product-journey-impact",
  );
  const nativeDependenciesIndex = job.steps.findIndex(
    (step) => step.name === "Native build dependencies",
  );

  assert.deepEqual(input, {
    description: "Product journey selection mode",
    required: false,
    type: "string",
    default: "all",
  });
  assert.deepEqual(manualInput, {
    description: "Product journey selection mode",
    required: true,
    type: "choice",
    default: "all",
    options: ["all", "shadow"],
  });
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(checkoutIndex >= 0, "product journey checkout is required");
  assert.equal(job.steps[checkoutIndex].with["fetch-depth"], 0);
  assert.equal(
    selectorIndex,
    checkoutIndex + 1,
    "selector must run immediately after checkout",
  );
  assert.ok(
    selectorIndex < nativeDependenciesIndex,
    "selector must run before native dependency setup",
  );

  const selector = job.steps[selectorIndex];
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /inputs\.product_journey_mode/,
  );
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /github\.event_name == 'pull_request' && 'shadow'/,
  );
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /refs\/heads\/master' && 'shadow'/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /schedule/);
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /all/);
  assert.match(
    selector.env.PRODUCT_JOURNEY_BASE_SHA,
    /github\.event\.pull_request\.base\.sha/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_BASE_SHA, /github\.event\.before/);
  assert.match(
    selector.env.PRODUCT_JOURNEY_HEAD_SHA,
    /github\.event\.pull_request\.head\.sha/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_HEAD_SHA, /github\.sha/);
  assert.match(
    selector.run,
    /node electron\/scripts\/product-journey-impact\.mjs/,
  );
  assert.match(selector.run, /--mode "\$PRODUCT_JOURNEY_MODE"/);
  assert.match(selector.run, /--base "\$PRODUCT_JOURNEY_BASE_SHA"/);
  assert.match(selector.run, /--head "\$PRODUCT_JOURNEY_HEAD_SHA"/);
  assert.match(
    selector.run,
    /--report "\$GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR\/impact\.json"/,
  );

  const gate = job.steps.find((step) => step.name === "Product journey gate");
  const shouldRunCondition =
    "steps.product-journey-impact.outputs.should_run == 'true'";
  const gateIndex = job.steps.indexOf(gate);
  for (const step of job.steps.slice(nativeDependenciesIndex, gateIndex + 1)) {
    if (step.name === "Build selected MCP journey dependency") continue;
    assert.equal(
      step.if,
      shouldRunCondition,
      `${step.name ?? step.uses ?? step.run} must skip expensive setup when no journey is selected`,
    );
  }
  assert.equal(gate.if, shouldRunCondition);
  assert.equal(gate.env.GRIMODEX_PRODUCT_JOURNEY_IDS, undefined);
  assert.equal(gate.env.GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL, "true");
  assert.match(
    gate.env.GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST,
    /steps\.product-journey-impact\.outputs\.catalog_digest/,
  );
  assert.match(gate.run, /GRIMODEX_PRODUCT_JOURNEY_IDS/);
  assert.match(gate.run, /GRIMODEX_PRODUCT_JOURNEY_SET/);
  assert.match(
    gate.run,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:product-journeys/,
  );

  const mcpBuild = job.steps.find(
    (step) => step.name === "Build selected MCP journey dependency",
  );
  assert.ok(mcpBuild, "capability-gated MCP build is required");
  assert.equal(mcpBuild.run, "pnpm mcp:build");
  assert.match(mcpBuild.if, /should_run.*true/);
  assert.match(mcpBuild.if, /execution_capabilities.*mcp/);
});

test("Full CI product journey gate cannot receive a subset and binds the catalog", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const gate = workflow.jobs["electron-product-journeys"].steps.find(
    (step) => step.name === "Product journey gate",
  );

  assert.equal(gate.env.GRIMODEX_PRODUCT_JOURNEY_IDS, undefined);
  assert.equal(gate.env.GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL, "true");
  assert.match(
    gate.env.GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST,
    /steps\.product-journey-impact\.outputs\.catalog_digest/,
  );
  assert.match(gate.run, /GRIMODEX_PRODUCT_JOURNEY_IDS/);
  assert.match(gate.run, /subset|must not be set/i);
});

test("paused CI keeps every product journey job definition available", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const productJourneyJobId = "electron-product-journeys";
  const jobEntries = Object.entries(workflow.jobs);

  assert.ok(
    jobEntries.some(([jobId]) => jobId === productJourneyJobId),
    "electron-product-journeys job is required",
  );
  for (const [jobId, job] of jobEntries) {
    if (jobId === productJourneyJobId) continue;
    assert.equal(
      job.if,
      "github.event_name != 'schedule'",
      `${jobId} must retain its non-scheduled execution guard`,
    );
  }
});

test("catalog and runner implementation IDs match in deterministic order", () => {
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
});

test("receipt is reverified after bridge readiness and after process close", async () => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] =
    NARRATIVE_MAINTENANCE_OWNER_TOKEN;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = RECEIPT_NONCE;
  try {
    const expected = expectedNarrativeMaintenanceCiReceipt(process.env);
    let bridgeReceiptPath;
    const bridgePage = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => {
        await writeFile(
          bridgeReceiptPath,
          canonicalReceiptText({ ...expected, trigger: "dependency-gap" }),
        );
      },
      isClosed: () => false,
    };
    const bridgeApp = {
      context: () => null,
      firstWindow: async () => bridgePage,
      process: () => childProcessStub({ stdout: new EventEmitter() }),
    };
    const bridgeHarness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      launchTimeoutMs: 50,
      electronLauncher: {
        launch: async ({ env }) => {
          bridgeReceiptPath = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
            "receipt.json",
          );
          await mkdir(path.dirname(bridgeReceiptPath), { recursive: true });
          await writeFile(bridgeReceiptPath, canonicalReceiptText(expected));
          return bridgeApp;
        },
      },
      closeApp: async () => undefined,
    });
    await assert.rejects(
      bridgeHarness.launch("receipt-bridge-reverify"),
      /mismatch|trigger|receipt/i,
    );
    await bridgeHarness.dispose({
      success: false,
      name: "receipt-bridge-reverify",
    });

    let closeReceiptPath;
    const closePage = {
      on: () => undefined,
      evaluate: async () => [],
      waitForFunction: async () => undefined,
      isClosed: () => false,
    };
    const closeApp = {
      context: () => null,
      firstWindow: async () => closePage,
      process: () => childProcessStub({ stdout: new EventEmitter() }),
    };
    const closeHarness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      launchTimeoutMs: 50,
      electronLauncher: {
        launch: async ({ env }) => {
          closeReceiptPath = path.join(
            env.GRIMODEX_USER_DATA_DIR,
            NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
            expected.nonce,
            "receipt.json",
          );
          await mkdir(path.dirname(closeReceiptPath), { recursive: true });
          await writeFile(closeReceiptPath, canonicalReceiptText(expected));
          return closeApp;
        },
      },
      closeApp: async () => undefined,
    });
    const launched = await closeHarness.launch("receipt-close-reverify");
    await writeFile(
      closeReceiptPath,
      canonicalReceiptText({ ...expected, trigger: "dependency-gap" }),
    );
    await assert.rejects(
      closeHarness.close(launched.app, launched.page, "receipt-close-reverify"),
      /mismatch|trigger|changed|receipt/i,
    );
    await closeHarness.dispose({
      success: false,
      name: "receipt-close-reverify",
    });
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    else process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    if (previousNonce === undefined)
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    else process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
  }
});

test("workspace pairs wait for cold startup before Native preparation", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-workspace-pair-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const workspaceA = path.join(temporaryRoot, "workspace-a");
  const workspaceB = path.join(temporaryRoot, "workspace-b");
  const calls = [];
  const app = {};
  let finishStartup;
  const startup = new Promise((resolve) => {
    finishStartup = resolve;
  });
  let observeBoundary;
  const boundary = new Promise((resolve) => {
    observeBoundary = resolve;
  });
  const page = {
    getByRole(role, { name, includeHidden }) {
      assert.equal(role, "button");
      assert.ok(name.test("🇯🇵 日本語"));
      assert.equal(
        includeHidden,
        true,
        "EULA hides the welcome screen from accessibility",
      );
      return {
        async waitFor(options) {
          assert.deepEqual(options, { state: "attached" });
          calls.push({ kind: "startup-wait" });
          observeBoundary();
          await startup;
          calls.push({ kind: "startup-ready" });
        },
      };
    },
  };
  const harness = {
    async launch(phase) {
      calls.push({ kind: "launch", phase });
      return { app, page };
    },
    async invokeOk(_page, command, args) {
      calls.push({ kind: "invoke", command, args });
      if (command === "open_workspace") observeBoundary();
      if (command === "get_global_settings") {
        return {
          recentWorkspaces: [],
          trustedWorkspaces: [],
          showLauncherOnStartup: true,
        };
      }
      return undefined;
    },
    async close(closedApp, closedPage, phase) {
      calls.push({ kind: "close", closedApp, closedPage, phase });
    },
    async executeFixtureOperations(workspace, operations) {
      calls.push({ kind: "fixture-operations", workspace, operations });
    },
  };

  const configuring = configureWorkspace(harness, workspaceA, {
    appSettings: { "editor.autoSaveDelay": 60_000 },
    additionalWorkspaces: [workspaceB],
  });
  await boundary;
  const opensBeforeStartup = calls.filter(
    (call) => call.command === "open_workspace",
  ).length;
  finishStartup();
  await configuring;
  assert.equal(
    opensBeforeStartup,
    0,
    "Native Open must not change recents while the cold renderer is still initializing",
  );

  assert.deepEqual(
    calls
      .filter(
        (call) => call.kind === "invoke" && call.command === "open_workspace",
      )
      .map((call) => call.args.path),
    [workspaceA, workspaceB, workspaceA],
    "the secondary DB must be created and authority restored before the cold configure renderer closes",
  );
  assert.equal(
    calls.filter((call) => call.kind === "launch").length,
    1,
    "pair setup must not launch an auto-opening renderer between DB swaps",
  );
  const savedSettings = calls.find(
    (call) => call.kind === "invoke" && call.command === "save_global_settings",
  );
  assert.deepEqual(savedSettings.args.settings.trustedWorkspaces, [
    workspaceA,
    workspaceB,
  ]);
  assert.equal(savedSettings.args.settings.lastActiveWorkspace, workspaceA);
  assert.equal(savedSettings.args.settings.showLauncherOnStartup, false);
  const closeIndex = calls.findIndex((call) => call.kind === "close");
  const fixtureDmlIndex = calls.findIndex(
    (call) => call.kind === "fixture-operations",
  );
  assert.ok(closeIndex >= 0 && closeIndex < fixtureDmlIndex);
  assert.deepEqual(calls[fixtureDmlIndex], {
    kind: "fixture-operations",
    workspace: workspaceA,
    operations: [
      {
        kind: "app-settings-upsert",
        key: "editor.autoSaveDelay",
        value: "60000",
      },
    ],
  });
});

test("CI fixture operations are typed, exact-workspace, renderer-fenced, and fail-closed", async (t) => {
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => ({
        firstWindow: async () => ({
          on: () => undefined,
          waitForFunction: async () => undefined,
        }),
        process: () => childProcessStub(),
      }),
    },
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  assert.throws(
    () => harness.workspacePath("."),
    /invalid product journey workspace/,
  );
  assert.throws(
    () => harness.workspacePath(".."),
    /invalid product journey workspace/,
  );
  const workspace = harness.workspacePath("fixture-operations");
  await mkdir(workspace, { recursive: true });
  const databasePath = path.join(workspace, "grimodex.db");
  await execFile("sqlite3", [
    databasePath,
    `PRAGMA foreign_keys = ON;
     CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE projects (id TEXT PRIMARY KEY);
     CREATE TABLE project_settings (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key));
     CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
     CREATE TABLE content_versions (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, content TEXT NOT NULL, version_number INTEGER NOT NULL, snapshot_type TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE TABLE narrative_extraction_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
     CREATE TABLE narrative_dependency_edges (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, consumer_kind TEXT NOT NULL, consumer_key TEXT NOT NULL, source_object_identity TEXT NOT NULL, read_set_json TEXT NOT NULL, generated_by_transaction_id TEXT, created_at TEXT NOT NULL, owning_run_id TEXT);
     CREATE TABLE narrative_dependency_edge_states (edge_id TEXT NOT NULL, project_id TEXT NOT NULL);
     CREATE TABLE narrative_consumer_freshness (project_id TEXT NOT NULL, consumer_kind TEXT NOT NULL, consumer_key TEXT NOT NULL);
     INSERT INTO projects VALUES ('project-1');
     INSERT INTO tree_nodes VALUES ('scene-1', 'project-1');
     INSERT INTO narrative_extraction_runs VALUES ('run-1', 'project-1');`,
  ]);

  const launched = await harness.launch("fixture-operations-active");
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "app-settings-upsert",
        key: "blocked",
        value: "must-not-run",
      },
    ]),
    /requires the renderer to be closed/,
  );
  await harness.close(launched.app, launched.page, "fixture-operations-active");

  const launchPending = harness.launch("fixture-operations-launch-race");
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "app-settings-upsert",
        key: "blocked",
        value: "launch-race",
      },
    ]),
    /requires the renderer to be closed/,
  );
  const launchRace = await launchPending;
  await harness.close(
    launchRace.app,
    launchRace.page,
    "fixture-operations-launch-race",
  );

  const receipt = await harness.executeFixtureOperations(workspace, [
    {
      kind: "app-settings-upsert",
      key: "editor.autoSaveDelay",
      value: "O'Reilly'); DELETE FROM app_settings; --",
    },
    {
      kind: "project-settings-upsert",
      projectId: "project-1",
      key: "fixture.key",
      value: "fixture.value",
    },
    {
      kind: "content-version-insert",
      id: "version-1",
      entityId: "scene-1",
      content: "fixture content",
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ]);
  assert.equal(receipt.operationCount, 3);
  assert.match(receipt.operationDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(receipt.beforeCounts, [
    { rows: 0 },
    { rows: 0 },
    { rows: 0 },
  ]);
  assert.deepEqual(receipt.afterCounts, [
    { rows: 1 },
    { rows: 1 },
    { rows: 1 },
  ]);
  assert.deepEqual(
    receipt.operations.map(({ operation }) => operation),
    [
      {
        kind: "app-settings-upsert",
        key: "editor.autoSaveDelay",
        value: "O'Reilly'); DELETE FROM app_settings; --",
      },
      {
        kind: "project-settings-upsert",
        projectId: "project-1",
        key: "fixture.key",
        value: "fixture.value",
      },
      {
        kind: "content-version-insert",
        id: "version-1",
        entityId: "scene-1",
        content: "fixture content",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
  );
  const { stdout } = await execFile("sqlite3", [
    "-json",
    databasePath,
    "SELECT key, value FROM app_settings WHERE key = 'editor.autoSaveDelay';",
  ]);
  assert.deepEqual(JSON.parse(String(stdout)), [
    {
      key: "editor.autoSaveDelay",
      value: "O'Reilly'); DELETE FROM app_settings; --",
    },
  ]);

  const edgeReceipt = await harness.executeFixtureOperations(workspace, [
    {
      kind: "dependency-edge-insert",
      id: "edge-1",
      projectId: "project-1",
      consumerKind: "narrative-extraction-run",
      consumerKey: "run-1",
      sourceObjectIdentity: "project:scene:scene-1",
      readSetJson: '["v1@2026-08-28T00:00:00.000Z"]',
      generatedByTransactionId: null,
      createdAt: "2026-08-28T00:00:01.000Z",
      owningRunId: "run-1",
    },
  ]);
  assert.deepEqual(edgeReceipt.beforeCounts, [{ rows: 0 }]);
  assert.deepEqual(edgeReceipt.afterCounts, [{ rows: 1 }]);
  await execFile("sqlite3", [
    databasePath,
    "INSERT INTO narrative_dependency_edge_states VALUES ('edge-1', 'project-1'); INSERT INTO narrative_consumer_freshness VALUES ('project-1', 'narrative-extraction-run', 'run-1');",
  ]);
  const gapReceipt = await harness.executeFixtureOperations(workspace, [
    {
      kind: "dependency-derived-state-gap-delete",
      projectId: "project-1",
      edgeId: "edge-1",
      consumerKind: "narrative-extraction-run",
      consumerKey: "run-1",
    },
  ]);
  assert.deepEqual(gapReceipt.beforeCounts, [
    { edgeStateRows: 1, freshnessRows: 1 },
  ]);
  assert.deepEqual(gapReceipt.afterCounts, [
    { edgeStateRows: 0, freshnessRows: 0 },
  ]);

  await assert.rejects(
    harness.executeFixtureOperations(path.join(harness.tmpRoot, "other"), [
      {
        kind: "app-settings-upsert",
        key: "key",
        value: "value",
      },
    ]),
    /exact harness-owned workspace path/,
  );
  const symlinkWorkspace = harness.workspacePath("fixture-operations-symlink");
  await mkdir(symlinkWorkspace, { recursive: true });
  const symlinkTarget = path.join(symlinkWorkspace, "target.db");
  await execFile("sqlite3", [
    symlinkTarget,
    "CREATE TABLE fixture_values (text_value TEXT);",
  ]);
  await symlink(symlinkTarget, path.join(symlinkWorkspace, "grimodex.db"));
  await assert.rejects(
    harness.executeFixtureOperations(symlinkWorkspace, [
      {
        kind: "app-settings-upsert",
        key: "symlink",
        value: "rejected",
      },
    ]),
    /non-directory workspace or non-regular database/,
  );
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "arbitrary-sql",
        sql: "DELETE FROM narrative_extraction_runs",
      },
    ]),
    /unsupported fixture operation kind/,
  );
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "app-settings-upsert",
        key: "extra",
        value: "value",
        sql: "DELETE FROM app_settings",
      },
    ]),
    /extra or missing fields/,
  );
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "project-settings-upsert",
        projectId: "unowned-project",
        key: "key",
        value: "value",
      },
    ]),
    /unowned project ID/,
  );
  await assert.rejects(
    harness.executeFixtureOperations(workspace, [
      {
        kind: "dependency-derived-state-gap-delete",
        projectId: "project-1",
        edgeId: "unowned-edge",
        consumerKind: "narrative-extraction-run",
        consumerKey: "run-1",
      },
    ]),
    /unowned dependency gap/,
  );
});

test("fixture DML seam stays outside production bundle and preload entrypoints", async () => {
  const [
    harnessSource,
    buildSource,
    mainSource,
    preloadSource,
    contractSource,
  ] = await Promise.all([
    read("electron/scripts/product-journey-harness.mjs"),
    read("electron/scripts/build.mjs"),
    read("electron/main/index.ts"),
    read("electron/preload/index.ts"),
    read("electron/shared/ipcContract.ts"),
  ]);
  assert.match(harnessSource, /executeFixtureOperations/);
  assert.match(harnessSource, /ci-product-journey-harness-v1/);
  for (const source of [
    buildSource,
    mainSource,
    preloadSource,
    contractSource,
  ]) {
    assert.doesNotMatch(source, /executeFixtureOperations/);
    assert.doesNotMatch(source, /executeFixtureDml/);
  }
});

test("cleanup timeout stays production-safe and rejects non-positive overrides", async () => {
  const [harnessSource, runnerSource] = await Promise.all([
    read("electron/scripts/product-journey-harness.mjs"),
    read("electron/scripts/product-journeys.mjs"),
  ]);
  assert.match(
    harnessSource,
    /const PRODUCT_JOURNEY_LANE_CLEANUP_TIMEOUT_MS = 5_000;/,
  );
  assert.match(
    harnessSource,
    /failureCleanupTimeoutMs\s*=\s*PRODUCT_JOURNEY_LANE_CLEANUP_TIMEOUT_MS/,
  );
  assert.doesNotMatch(runnerSource, /failureCleanupTimeoutMs/);

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        createProductJourneyHarness({
          mainCjs: "/tmp/fake-main.cjs",
          failureCleanupTimeoutMs: timeoutMs,
        }),
      /positive failureCleanupTimeoutMs/,
    );
  }
});

test("fixture seam exposes only typed allowlisted operations", async () => {
  const source = await read("electron/scripts/product-journey-harness.mjs");
  assert.match(source, /executeFixtureOperations/);
  assert.doesNotMatch(source, /executeFixtureDml/);
  assert.match(source, /app-settings-upsert/);
  assert.match(source, /project-settings-upsert/);
  assert.match(source, /content-version-insert/);
  assert.match(source, /dependency-edge-insert/);
  assert.match(source, /dependency-derived-state-gap-delete/);
});

test("product runner keeps the real boundary assertions", async () => {
  const source = await read("electron/scripts/product-journeys.mjs");
  assert.match(source, /open_workspace/);
  assert.match(source, /db_execute/);
  assert.match(source, /workspace-menu-trigger/);
  assert.match(source, /PENDING_SAVE_AUTOSAVE_DELAY_MS\s*=\s*60_000/);
  assert.match(source, /pending-editor-draft/);
  assert.match(source, /workspaceOpenRevision/);
  assert.match(source, /persistedBeforeSwitch/);
  assert.match(source, /leakedIntoWorkspaceB/);
  assert.match(source, /persistedAfterReturn/);
  assert.match(source, /workspace B received workspace A pending editor text/);
  assert.match(source, /clean-external-write-reloaded/);
  assert.match(source, /dirty-external-write-conflict/);
  assert.match(source, /"tree_node_patch"/);
  assert.match(source, /requestId:\s*eventUid/);
  assert.match(source, /origin:\s*"human"/);
  assert.match(source, /originalTransactionId:\s*null/);
  assert.match(source, /undoJournalId:\s*null/);
  assert.match(source, /baseVersion/);
  assert.match(source, /changeEvent:\s*\{/);
  assert.match(source, /eventUid/);
  assert.match(source, /sessionId:\s*"external-product-journey"/);
  assert.match(source, /"codex_create"/);
  assert.doesNotMatch(source, /"agent_codex_create"/);
  assert.doesNotMatch(source, /INSERT INTO codex_entries/);
  assert.doesNotMatch(source, /UPDATE tree_nodes SET content/);
  assert.doesNotMatch(source, /INSERT INTO change_events/);
  assert.doesNotMatch(source, /`prev-\$\{eventUid\}`/);
  assert.doesNotMatch(source, /`hash-\$\{eventUid\}`/);
  assert.match(source, /undoHistoryInvalidated/);
  assert.match(source, /external-edit-reload/);
  assert.match(source, /chat-late-chunk-isolated/);
  assert.match(source, /staleChunkInNewScope:\s*false/);
  assert.match(source, /promptSnapshotInNewScope:\s*false/);
  assert.match(source, /sessionMutationInNewScope:\s*false/);
  assert.match(source, /cross-feature-authoring-persisted/);
  assert.match(source, /promptIncludedCodex:\s*true/);
  assert.match(source, /aiAttributionPersisted:\s*true/);
  assert.match(source, /cross-feature-authoring-restored/);
  assert.match(source, /project-chat-stream-drained/);
  assert.match(source, /runAgentStreamProjectSwitchJourney/);
  assert.match(source, /pathId:\s*"chat_agent_main"/);
  assert.match(source, /transport:\s*"send_agent_message"/);
  assert.match(source, /responseStillPending:\s*true/);
  assert.match(source, /agent-project-switch-drained/);
  assert.match(source, /runAgentStreamWorkspaceSwitchJourney/);
  assert.match(source, /AGENT_WORKSPACE_SWITCH_PROMPT/);
  assert.match(
    source,
    /workspace authority revision changed while Agent transport was pending/,
  );
  assert.match(source, /agent-workspace-switch-drained/);
  assert.match(source, /workspace-chat-stream-drained/);
  assert.match(source, /project-pending-editor-restored/);
  assert.match(source, /mcp-d2a-pre-dispatch-denial/);
  assert.match(source, /D2A_EGRESS_DENIED/);
  assert.match(source, /propose_scene_body/);
  assert.doesNotMatch(source, /prose_staging/);
  assert.doesNotMatch(source, /mcp-clean-external-write-reloaded/);
  assert.doesNotMatch(source, /mcp-dirty-external-write-conflict/);
  assert.match(source, /chronicle_bulk_mutate/);
  assert.match(source, /chronicle-native-roundtrip-restored/);
  assert.match(source, /lint_term_dictionary_insert/);
  assert.match(source, /lint_term_dictionary_list/);
  assert.match(source, /lint-native-roundtrip-restored/);
  assert.match(source, /map_write_bundle/);
  assert.match(source, /map-native-roundtrip-restored/);
  assert.match(source, /project_snapshot_create/);
  assert.match(source, /project_snapshot_restore_context/);
  assert.match(source, /snapshot-native-roundtrip-restored/);
});

test("native round-trip fixtures route protected narrative seeds through typed writers", async () => {
  const source = await read(
    "electron/scripts/product-journey-native-roundtrips.mjs",
  );
  const registry = JSON.parse(
    await read("policies/narrative/protected-writers.json"),
  );
  const protectedTables = new Set(
    registry
      .filter((entry) => entry.enforcement === "active")
      .map((entry) => entry.table.toLowerCase()),
  );
  const mutationTargets = [
    ...source.matchAll(
      /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi,
    ),
  ].map((match) => match[1].toLowerCase());

  assert.match(source, /"event_create"/);
  assert.match(source, /"tree_node_create"/);
  assert.deepEqual(
    mutationTargets.filter((table) => protectedTables.has(table)),
    [],
    "product fixtures must not seed active protected tables through generic SQL",
  );
});

test("product journey fixture mutations use the harness-owned non-renderer seam", async () => {
  const sources = await Promise.all([
    read("electron/scripts/product-journeys.mjs"),
    read("electron/scripts/product-journey-native-roundtrips.mjs"),
    read("electron/scripts/narrative-maintenance-product-journeys.mjs"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /["`]db_execute(?:_batch)?["`]\s*,\s*\{[\s\S]{0,300}\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i,
      "fixture DML must not cross the renderer db_execute boundary",
    );
  }
  assert.match(sources[0], /harness\.executeFixtureOperations/);
  assert.match(sources[1], /relaunchAfterFixtureOperations/);
  assert.match(sources[2], /harness\.executeFixtureOperations/);
});

test("native round-trip fixture relaunch waits for matching Project authority", async () => {
  const source = await read(
    "electron/scripts/product-journey-native-roundtrips.mjs",
  );
  const helperIndex = source.indexOf(
    "relaunchAfterFixtureOperations: async (operations) => {",
  );
  const relaunchIndex = source.indexOf(
    "writing = await harness.launch(`${id}/write`)",
    helperIndex,
  );
  const authorityIndex = source.indexOf(
    "await projectIdFor(harness, writing.page)",
    relaunchIndex,
  );
  const mismatchIndex = source.indexOf(
    "reopenedProjectId !== projectId",
    authorityIndex,
  );
  const returnIndex = source.indexOf("return writing.page", mismatchIndex);

  assert.ok(
    helperIndex >= 0 &&
      helperIndex < relaunchIndex &&
      relaunchIndex < authorityIndex &&
      authorityIndex < mismatchIndex &&
      mismatchIndex < returnIndex,
    "fixture relaunch must wait for and verify Project authority before returning the page",
  );
});

test("product harness enables only the deterministic main-boundary AI provider", async () => {
  const source = await read("electron/scripts/product-journey-harness.mjs");
  assert.match(source, /GRIMODEX_PRODUCT_JOURNEY_FAKE_AI/);
  assert.match(source, /deterministic-v1/);
  assert.match(source, /env\[PRODUCT_JOURNEY_AI_ENV\]/);
});

test("performance smoke reuses the product journey boundary helpers", async () => {
  const source = await read("electron/scripts/smoke.mjs");

  assert.match(
    source,
    /import \{ invokeOk, waitUntil \} from "\.\/product-journey-harness\.mjs";/,
  );
  assert.doesNotMatch(source, /async function invokeOk\(/);
  assert.doesNotMatch(source, /async function waitUntil\(/);
});

test("product journey harness closes Electron when firstWindow fails", async (t) => {
  const app = {
    process: () => childProcessStub(),
    firstWindow: async () => {
      throw new Error("window was never created");
    },
  };
  const closed = [];
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async (launchedApp, page, phase) => {
      closed.push({ launchedApp, page, phase });
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  await assert.rejects(harness.launch("startup"), /window was never created/);
  await harness.dispose({ success: false, name: "startup-failure" });

  assert.deepEqual(closed, [
    {
      launchedApp: app,
      page: null,
      phase: "failure:startup-failure",
    },
  ]);
});

test("product journey harness retains the renderer screenshot before close", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-artifacts-"),
  );
  let pageClosed = false;
  const events = [];
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => pageClosed,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async ({ path: screenshotPath }) => {
      events.push("screenshot");
      await writeFile(screenshotPath, "renderer-state");
    },
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "test-main-noise-only",
        phases: ["editor-persistence/write"],
        reason:
          "Proves a main-only allowance never suppresses renderer errors.",
        expiresOn: "2099-12-31",
        pattern: /lifecycle read failed/,
      },
    ],
    closeApp: async () => {
      events.push("close");
      pageClosed = true;
      mainStderr.emit("end");
    },
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const launched = await harness.launch("editor-persistence/write");
  mainStderr.emit("data", "Error: lifecycle read failed\n");
  harness.recordTimeline("test-authority", { workspace: "workspace-a" });
  await harness.close(launched.app, launched.page, "editor-persistence/write");
  await harness.dispose({
    success: false,
    name: "editor-persistence",
  });

  assert.deepEqual(events, ["screenshot", "close"]);
  assert.equal(
    await readFile(
      path.join(artifactRoot, "editor-persistence", "renderer.png"),
      "utf8",
    ),
    "renderer-state",
  );
  const timeline = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "authority-timeline.json",
      ),
      "utf8",
    ),
  );
  assert.ok(
    timeline.some(
      (event) =>
        event.event === "test-authority" && event.workspace === "workspace-a",
    ),
  );
  assert.equal(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "main.log",
      ),
      "utf8",
    ),
    "  [product:editor-persistence/write:main] Error: lifecycle read failed\n",
  );
  assert.equal(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "renderer.log",
      ),
      "utf8",
    ),
    "",
  );
  const rendererDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      rendererErrorCount: rendererDiagnostics.rendererErrorCount,
      pageErrors: rendererDiagnostics.pageErrors,
      mainErrorCount: rendererDiagnostics.mainErrorCount,
      unallowedMainErrors: rendererDiagnostics.unallowedMainErrors,
      mainCleanPass: rendererDiagnostics.mainCleanPass,
      cleanPass: rendererDiagnostics.cleanPass,
    },
    {
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 1,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
  );
  const mainDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "main-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    mainDiagnostics.map(({ phase, message, classification, allowance }) => ({
      phase,
      message,
      classification,
      allowance,
    })),
    [
      {
        phase: "editor-persistence/write",
        message: "Error: lifecycle read failed\n",
        classification: "error",
        allowance: {
          id: "test-main-noise-only",
          phases: ["editor-persistence/write"],
          reason:
            "Proves a main-only allowance never suppresses renderer errors.",
          expiresOn: "2099-12-31",
          pattern: "/lifecycle read failed/",
        },
      },
    ],
  );
});

test("lane failure retains one live renderer frame before final diagnostics", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-lane-screenshot-"),
  );
  const phase = "observability/lane-screenshot";
  const artifactName = "observability-lane-screenshot";
  const child = childProcessStub({ pid: 424306 });
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    child.signalCode = null;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return true;
  };
  let pageClosed = false;
  let screenshotCalls = 0;
  const page = {
    isClosed: () => pageClosed,
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    screenshot: async ({ path: screenshotPath }) => {
      assert.equal(pageClosed, false, "renderer frame must be captured live");
      screenshotCalls += 1;
      await writeFile(screenshotPath, "lane-renderer-frame");
    },
  };
  const events = [];
  const { harness } = createActiveLaneHarness({
    artifactRoot,
    childProcess: child,
    page,
    closeApp: async () => {
      events.push("close");
      pageClosed = true;
    },
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  await harness.launch(phase);
  await assert.rejects(
    harness.withLaneWatchdog(() => new Promise(() => {}), {
      phase,
      timeoutMs: 15,
    }),
    /watchdog.*lane-screenshot/i,
  );

  assert.equal(screenshotCalls, 1);
  assert.deepEqual(events, ["close"]);
  assert.equal(
    await readFile(
      path.join(artifactRoot, artifactName, "renderer.png"),
      "utf8",
    ),
    "lane-renderer-frame",
  );
  const diagnostics = await readRetainedDiagnostics(artifactRoot, artifactName);
  assert.equal(diagnostics.cleanPass, false);
  assert.ok(
    diagnostics.closeDiagnostics?.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(diagnostics),
  );
  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  await harness.dispose({ success: false, name: artifactName });
  assert.equal(screenshotCalls, 1);
});

test("lane cleanup survives a renderer screenshot availability failure", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-screenshot-guard-"),
  );
  const phase = "observability/screenshot-guard";
  const artifactName = "observability-screenshot-guard";
  const child = childProcessStub({ pid: 424309 });
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    child.signalCode = null;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return true;
  };
  const page = {
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    isClosed: () => {
      throw new Error("page state unavailable");
    },
    screenshot: async () => {
      throw new Error("screenshot must not be required for cleanup");
    },
  };
  let closeCalls = 0;
  const { harness } = createActiveLaneHarness({
    artifactRoot,
    childProcess: child,
    page,
    closeApp: async () => {
      closeCalls += 1;
    },
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  let unhandledRejections = 0;
  const onUnhandledRejection = () => {
    unhandledRejections += 1;
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await harness.launch(phase);
    await assert.rejects(
      harness.withLaneWatchdog(() => new Promise(() => {}), {
        phase,
        timeoutMs: 15,
      }),
      /watchdog.*screenshot-guard/i,
    );
    const diagnostics = await readRetainedDiagnostics(
      artifactRoot,
      artifactName,
    );
    assert.equal(closeCalls, 1);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(child.exitCode, 0);
    assert.equal(diagnostics.cleanPass, false);
    assert.ok(
      diagnostics.closeDiagnostics?.some(
        (issue) =>
          issue.fatal === true &&
          issue.errorName === "ProductJourneyLaneWatchdogError",
      ),
      JSON.stringify(diagnostics),
    );
    assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  assert.equal(unhandledRejections, 0);
});

test("product journey harness keeps warnings diagnostic but fails closed on close-time renderer errors", async (t) => {
  const listeners = new Map();
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "renderer-is-never-allowlisted",
        phases: ["project-switch"],
        reason: "This allowance applies only to matching main stderr.",
        expiresOn: "2099-12-31",
        pattern: /lifecycle read failed/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
      setImmediate(() => {
        listeners.get("console")?.({
          type: () => "error",
          text: () => "[Global] unhandled rejection: lifecycle read failed",
          location: () => ({
            url: "app://renderer/main.js",
            lineNumber: 42,
            columnNumber: 7,
          }),
        });
        setImmediate(() => {
          listeners.get("pageerror")?.(
            Object.assign(new Error("lifecycle read failed"), {
              stack: "Error: lifecycle read failed\n    at MessageBadge",
            }),
          );
        });
      });
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("project-switch");
  mainStderr.emit("data", "Error: lifecycle read failed\n");
  listeners.get("console")?.({
    type: () => "warning",
    text: () => "optional renderer warning",
    location: () => ({}),
  });
  await harness.close(launched.app, launched.page, "project-switch");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /renderer diagnostics failed/i);
  assert.deepEqual(error.diagnostics, {
    rendererErrorCount: 1,
    pageErrors: [
      {
        phase: "project-switch",
        name: "Error",
        message: "lifecycle read failed",
        stack: "Error: lifecycle read failed\n    at MessageBadge",
      },
    ],
    mainErrorCount: 1,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: false,
  });
});

test("product journey harness reports a clean pass when renderer output contains warnings only", async (t) => {
  const listeners = new Map();
  const page = {
    isClosed: () => false,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub(),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("warning-only");
  listeners.get("console")?.({
    type: () => "warning",
    text: () => "tokenizer heuristic fallback",
    location: () => ({}),
  });
  await harness.close(launched.app, launched.page, "warning-only");

  assert.deepEqual(await harness.finalizeDiagnostics(), {
    rendererErrorCount: 0,
    pageErrors: [],
    mainErrorCount: 0,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: true,
  });
  await harness.dispose({ success: true, name: "warning-only" });
});

test("product journey harness fails closed on unallowed error-class main stderr", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "known-current-phase",
        phases: ["main-gate"],
        reason: "Known bounded shutdown error in this exact phase.",
        expiresOn: "2099-12-31",
        pattern: /known shutdown error/,
      },
      {
        id: "wrong-phase",
        phases: ["another-phase"],
        reason: "Must not match outside the declared phase.",
        expiresOn: "2099-12-31",
        pattern: /phase mismatch/,
      },
      {
        id: "expired",
        phases: ["main-gate"],
        reason: "Must not match after its expiry.",
        expiresOn: "2000-01-01",
        pattern: /expired allowance/,
      },
      {
        id: "wrong-pattern",
        phases: ["main-gate"],
        reason: "Must not match a different stderr message.",
        expiresOn: "2099-12-31",
        pattern: /a different failure/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-gate");
  mainStderr.emit(
    "data",
    "Debugger ending on ws://127.0.0.1:9229/session\nFor help, see: https://nodejs.org/\n",
  );
  mainStderr.emit("data", "Error: known shutdown error\n");
  mainStderr.emit("data", "Error: phase mismatch\n");
  mainStderr.emit("data", "Error: expired allowance\n");
  mainStderr.emit("data", "Fatal: unmatched failure\n");
  mainStderr.emit("data", "UnhandledPromiseRejectionWarning: write rejected\n");
  await harness.close(launched.app, launched.page, "main-gate");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.match(error.message, /main-process diagnostics failed/i);
  const { unallowedMainErrors, ...summary } = error.diagnostics;
  assert.deepEqual(summary, {
    rendererErrorCount: 0,
    pageErrors: [],
    mainErrorCount: 5,
    mainCleanPass: false,
    cleanPass: false,
  });
  assert.deepEqual(
    unallowedMainErrors.map(({ phase, message }) => ({ phase, message })),
    [
      { phase: "main-gate", message: "Error: phase mismatch\n" },
      { phase: "main-gate", message: "Error: expired allowance\n" },
      { phase: "main-gate", message: "Fatal: unmatched failure\n" },
      {
        phase: "main-gate",
        message: "UnhandledPromiseRejectionWarning: write rejected\n",
      },
    ],
  );
});

test("expired default Ubuntu Xvfb allowances leave every error unallowed", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  assert.equal(MAIN_PROCESS_NOISE_ALLOWLIST.length, 5);
  const mainMessages = [
    '[6341:0730/134519.105645:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")\n',
    "[6341:0730/134519.106425:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: \n",
    "[6468:0730/134521.502865:ERROR:gpu/command_buffer/service/context_group.cc:148] ContextResult::kFatalFailure: WebGL2 blocklisted\n",
    "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
    "Fatal: database corruption\n",
  ];
  const launched = await harness.launch("configure");
  for (const message of mainMessages) mainStderr.emit("data", message);
  await harness.close(launched.app, launched.page, "configure");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, mainMessages.length);
  assert.equal(error.diagnostics.mainCleanPass, false);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    mainMessages.map((message) => ({ phase: "configure", message })),
  );
});

test("restore reload warning has no static phase-and-message allowance", async (t) => {
  const exact =
    "[146128:0824/022134.434622:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n";
  for (const { name, phase, message, allowed, now = "2026-10-03" } of [
    {
      name: "exact restore message",
      phase: "c2-5b-restore-verify-rebuild-verify/restore",
      message: exact,
      allowed: false,
    },
    {
      name: "old open phase is rejected",
      phase: "c2-5b-restore-verify-rebuild-verify/open",
      message: exact,
      allowed: false,
    },
    {
      name: "near match in restore is rejected",
      phase: "c2-5b-restore-verify-rebuild-verify/restore",
      message: exact.replace("ProduceSkia:", "ProduceSkiaNearMatch:"),
      allowed: false,
    },
    {
      name: "other GPU error in restore is rejected",
      phase: "c2-5b-restore-verify-rebuild-verify/restore",
      message: exact.replace("ProduceSkia:", "ProduceMemory:"),
      allowed: false,
    },
    {
      name: "expired exact restore message is rejected",
      phase: "c2-5b-restore-verify-rebuild-verify/restore",
      message: exact,
      allowed: false,
      now: "2026-10-18",
    },
  ]) {
    await t.test(name, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
      const artifactRoot = await mkdtemp(
        path.join(os.tmpdir(), "skia-boundary-"),
      );
      t.after(() => rm(artifactRoot, { recursive: true, force: true }));
      const mainStderr = new EventEmitter();
      const page = {
        isClosed: () => false,
        on: () => undefined,
        waitForFunction: async () => undefined,
        screenshot: async () => undefined,
      };
      const app = {
        firstWindow: async () => page,
        process: () => childProcessStub({ stderr: mainStderr }),
      };
      const harness = createProductJourneyHarness({
        artifactRoot,
        mainCjs: "/tmp/fake-main.cjs",
        electronBin: "/tmp/fake-electron",
        electronLauncher: {
          launch: async () => app,
        },
        closeApp: async () => {
          mainStderr.emit("end");
        },
      });
      t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

      const launched = await harness.launch(phase);
      mainStderr.emit("data", message);
      await harness.close(launched.app, launched.page, phase);

      const error = await harness.finalizeDiagnostics().then(
        () => null,
        (cause) => cause,
      );
      assert.equal(
        error?.name ?? null,
        allowed ? null : "MainProcessDiagnosticsError",
      );
      const diagnostics = harness.diagnostics();
      assert.equal(diagnostics.mainErrorCount, 1);
      assert.equal(diagnostics.mainCleanPass, allowed);
      assert.deepEqual(
        diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
          phase,
          message,
        })),
        allowed ? [] : [{ phase, message }],
      );
      await harness.captureFailureArtifact("boundary");
      const records = JSON.parse(
        await readFile(
          path.join(
            artifactRoot,
            "boundary",
            "runtime",
            "diagnostics",
            "main-diagnostics.json",
          ),
          "utf8",
        ),
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].phase, phase);
      assert.equal(records[0].message, message);
      assert.equal(records[0].classification, "error");
      assert.equal(
        records[0].allowance?.id ?? null,
        allowed ? "ubuntu-xvfb-restore-reload-shared-image-skia" : null,
      );
    });
  }
});

test("restore reload guard binds one Skia warning to a recovered Xvfb WebGL reload", async (t) => {
  const exact =
    "[146128:0824/022134.434622:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n";
  const runtime = {
    electron: "43.5.0",
    chrome: "150.0.7871.250",
    platform: "linux",
    x11Session: true,
    display: true,
    waylandDisplay: false,
    waylandSocket: false,
    xvfbMarker: true,
    swiftshader: true,
  };
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(8, 16);
  png.writeUInt32BE(8, 20);
  const phases = [
    "c2-5b-restore-verify-rebuild-verify/restore",
    "c2-zc-canonical-authority-cutover/restore",
    "c2-zc-post-marker-lifecycle/bootstrap-restore",
  ];
  const cases = [
    ...phases.map((phase) => ({
      name: `recovered ${phase}`,
      phase,
      allowed: true,
    })),
    { name: "warning before the guard", emission: "before", allowed: false },
    { name: "warning after the callback", emission: "after", allowed: false },
    { name: "two exact warnings", warningCount: 2, allowed: false },
    {
      name: "no main-frame navigation",
      navigationCount: 0,
      recoveryFails: true,
    },
    {
      name: "two main-frame navigations",
      navigationCount: 2,
      recoveryFails: true,
    },
    { name: "unchanged time origin", changeOrigin: false, recoveryFails: true },
    {
      name: "callback throws after warning",
      callbackThrows: true,
      recoveryFails: true,
    },
    {
      name: "page closes during restore",
      pageCloses: true,
      recoveryFails: true,
    },
    {
      name: "renderer fallback",
      proof: { renderer: "none" },
      recoveryFails: true,
    },
    {
      name: "lost context",
      proof: { contextLost: true },
      recoveryFails: true,
    },
    {
      name: "blank canvas pixels",
      pixels: { nonBlankPixels: false },
      recoveryFails: true,
    },
    {
      name: "no UI interaction",
      proof: { interaction: false },
      recoveryFails: true,
    },
    {
      name: "wrong Chromium runtime",
      runtime: { chrome: "150.0.7871.251" },
      allowed: false,
    },
    {
      name: "Wayland socket is still present",
      runtime: { waylandSocket: true },
      allowed: false,
    },
    {
      name: "wrong restore phase",
      phase: "c2-zc-canonical-authority-cutover/open",
      allowed: false,
    },
    { name: "expired exception", now: "2026-10-18", allowed: false },
    {
      name: "near-match GPU warning",
      message: exact.replace("ProduceSkia:", "ProduceSkiaNearMatch:"),
      allowed: false,
    },
    {
      name: "warning too early for navigation",
      earlyMs: 5_001,
      allowed: false,
    },
    {
      name: "unsupported runtime without warning still runs",
      runtime: { xvfbMarker: false },
      message: null,
      allowed: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      t.mock.timers.enable({
        apis: ["Date"],
        now: new Date(scenario.now ?? "2026-10-03T00:00:00Z"),
      });
      const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skia-guard-"));
      t.after(() => rm(artifactRoot, { recursive: true, force: true }));
      const stderr = new EventEmitter();
      const frame = {};
      let timeOrigin = 100;
      let pageClosed = false;
      const page = new EventEmitter();
      page.isClosed = () => pageClosed;
      page.mainFrame = () => frame;
      page.evaluate = async (fn) =>
        fn.toString().includes("performance.timeOrigin") ? timeOrigin : [];
      page.waitForFunction = async () => undefined;
      page.screenshot = async () => undefined;
      page.locator = (selector) => {
        assert.equal(selector, "[data-editor-ambient] canvas");
        return {
          screenshot: async (options) => {
            assert.match(
              options.style,
              /html, body \{ background: #000 !important; \}/,
            );
            assert.match(
              options.style,
              /body \* \{ visibility: hidden !important; \}/,
            );
            assert.match(
              options.style,
              /\[data-editor-ambient\] canvas \{ visibility: visible !important; background: #000 !important; \}/,
            );
            assert.doesNotMatch(
              options.style,
              /\[data-editor-ambient\]\s*(?:,|\*)/,
            );
            return png;
          },
        };
      };
      let appEvaluations = 0;
      const app = {
        firstWindow: async () => page,
        process: () => childProcessStub({ stderr }),
        evaluate: async (_fn, screenshotBase64) => {
          appEvaluations += 1;
          if (appEvaluations === 1) {
            assert.equal(screenshotBase64, undefined);
            return { ...runtime, ...scenario.runtime };
          }
          assert.equal(screenshotBase64, png.toString("base64"));
          return {
            width: 8,
            height: 8,
            pixelSampleCount: 64,
            nonBlankPixels: true,
            ...scenario.pixels,
          };
        },
      };
      const harness = createProductJourneyHarness({
        artifactRoot,
        mainCjs: "/tmp/fake-main.cjs",
        electronBin: "/tmp/fake-electron",
        electronLauncher: { launch: async () => app },
        closeApp: async () => stderr.emit("end"),
      });
      t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

      const phase = scenario.phase ?? phases[0];
      const launched = await harness.launch(phase);
      const message = scenario.message === undefined ? exact : scenario.message;
      if (scenario.emission === "before") stderr.emit("data", message);
      const restore = harness.withRestoreRendererReload(page, async () => {
        if (scenario.name === `recovered ${phases[0]}`) {
          await assert.rejects(
            harness.withRestoreRendererReload(page, async () => undefined),
            /one live, unused launch/,
          );
        }
        if (scenario.emission !== "before" && scenario.emission !== "after") {
          for (let n = 0; n < (scenario.warningCount ?? 1); n += 1) {
            if (message) stderr.emit("data", message);
          }
        }
        if (scenario.earlyMs) {
          t.mock.timers.setTime(Date.now() + scenario.earlyMs);
        }
        if ((scenario.navigationCount ?? 1) > 0) {
          if (scenario.changeOrigin !== false) timeOrigin = 200;
          for (let n = 0; n < (scenario.navigationCount ?? 1); n += 1) {
            page.emit("framenavigated", frame);
          }
        }
        if (scenario.pageCloses) pageClosed = true;
        if (scenario.callbackThrows) {
          throw new Error("deliberate restore callback failure");
        }
        return {
          renderer: "webgl",
          canvasSelector: "[data-editor-ambient] canvas",
          canvasWidth: 8,
          canvasHeight: 8,
          contextLost: false,
          drawCount: 2,
          interaction: true,
          timeOrigin,
          ...scenario.proof,
        };
      });
      if (scenario.recoveryFails) {
        await assert.rejects(
          restore,
          scenario.callbackThrows
            ? /deliberate restore callback failure/
            : /restore reload/,
        );
      } else {
        await restore;
      }
      if (scenario.name === `recovered ${phases[0]}`) {
        await assert.rejects(
          harness.withRestoreRendererReload(page, async () => undefined),
          /one live, unused launch/,
        );
      }
      if (scenario.emission === "after" && message)
        stderr.emit("data", message);
      await harness.close(launched.app, launched.page, phase);
      const diagnosticError = await harness.finalizeDiagnostics().then(
        () => null,
        (error) => error,
      );
      const allowed = scenario.allowed === true;
      assert.equal(
        diagnosticError?.name ?? null,
        allowed ? null : "MainProcessDiagnosticsError",
      );
      const diagnostics = harness.diagnostics();
      assert.equal(diagnostics.mainCleanPass, allowed);
      assert.equal(
        diagnostics.mainErrorCount,
        message ? (scenario.warningCount ?? 1) : 0,
      );
      assert.equal(diagnostics.restoreReloadGuards.length, 1);
      assert.equal(page.listenerCount("framenavigated"), 0);
      if (scenario.name === `recovered ${phases[0]}`) {
        const receipt = diagnostics.restoreReloadGuards[0];
        assert.equal(receipt.status, "eligible");
        assert.equal(receipt.allowanceApplied, true);
        assert.equal(receipt.proof.pixelSampleCount, 64);
        assert.equal(receipt.proof.nonBlankPixels, true);
        assert.equal(
          receipt.proof.screenshotSha256,
          createHash("sha256").update(png).digest("hex"),
        );
        assert.deepEqual(await readFile(receipt.proof.screenshotPath), png);
        await harness.captureFailureArtifact("boundary");
        const records = JSON.parse(
          await readFile(
            path.join(
              artifactRoot,
              "boundary",
              "runtime",
              "diagnostics",
              "main-diagnostics.json",
            ),
            "utf8",
          ),
        );
        assert.equal(records[0].launchId, launched.launchId);
        assert.equal(records[0].allowance.guardReceiptId, receipt.id);
        const timeline = JSON.parse(
          await readFile(
            path.join(
              artifactRoot,
              "boundary",
              "runtime",
              "diagnostics",
              "authority-timeline.json",
            ),
            "utf8",
          ),
        );
        assert.ok(
          timeline.some((entry) => entry.event === "restore-reload-guard"),
        );
        t.mock.timers.setTime(new Date("2026-10-18T00:00:00Z").getTime());
        assert.equal(harness.diagnostics().mainCleanPass, false);
      }
    });
  }
});

test("expired C2-ZC Skia mailbox allowance fails clean diagnostics", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const phase = "c2-zc-canonical-authority-cutover/restore";
  const launched = await harness.launch(phase);
  mainStderr.emit(
    "data",
    "[1145775:0828/155801.947748:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
  );
  await harness.close(launched.app, launched.page, phase);

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, 1);
  assert.equal(error.diagnostics.mainCleanPass, false);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase,
        message:
          "[1145775:0828/155801.947748:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
      },
    ],
  );
});

test("C2-ZC Skia mailbox allowance remains phase- and message-exact", async (t) => {
  const exact =
    "[1145775:0828/155801.947748:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n";
  for (const [phase, message] of [
    ["c2-zc-canonical-authority-cutover/open", exact],
    ["c2-zc-canonical-authority-cutover/typed-write", exact],
    [
      "c2-zc-canonical-authority-cutover/restore",
      exact.replace("ProduceSkia:", "ProduceSkiaNearMatch:"),
    ],
  ]) {
    const mainStderr = new EventEmitter();
    const page = {
      isClosed: () => false,
      on: () => undefined,
      waitForFunction: async () => undefined,
      screenshot: async () => undefined,
    };
    const app = {
      firstWindow: async () => page,
      process: () => childProcessStub({ stderr: mainStderr }),
    };
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      electronLauncher: {
        launch: async () => app,
      },
      closeApp: async () => {
        mainStderr.emit("end");
      },
    });
    t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

    const launched = await harness.launch(phase);
    mainStderr.emit("data", message);
    await harness.close(launched.app, launched.page, phase);
    const error = await harness.finalizeDiagnostics().then(
      () => null,
      (cause) => cause,
    );
    assert.equal(error?.name, "MainProcessDiagnosticsError", phase);
    assert.deepEqual(
      error?.diagnostics.unallowedMainErrors.map(
        ({ phase: actualPhase }) => actualPhase,
      ),
      [phase],
      phase,
    );
  }
});

test("shared-image mailbox noise remains gated outside configure and for near matches", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("chat-stream-project-switch");
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
  );
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157830:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
  );
  await harness.close(
    launched.app,
    launched.page,
    "chat-stream-project-switch",
  );

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, 2);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "chat-stream-project-switch",
        message:
          "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
      },
      {
        phase: "chat-stream-project-switch",
        message:
          "[8054:0730/135929.157830:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
      },
    ],
  );
});

test("product journey harness frames main stderr lines before applying allowances", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "known-current-phase",
        phases: ["main-framing"],
        reason: "Only this one complete stderr line is known noise.",
        expiresOn: "2099-12-31",
        pattern: /^Error: known shutdown error\n$/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-framing");
  mainStderr.emit(
    "data",
    "Error: known shutdown error\nFatal: coalesced database corruption\nErr",
  );
  mainStderr.emit(
    "data",
    "or: split-boundary persistence failure\nTypeError: trailing fragment",
  );
  await harness.close(launched.app, launched.page, "main-framing");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-framing",
        message: "Fatal: coalesced database corruption\n",
      },
      {
        phase: "main-framing",
        message: "Error: split-boundary persistence failure\n",
      },
      {
        phase: "main-framing",
        message: "TypeError: trailing fragment",
      },
    ],
  );
  assert.equal(error.diagnostics.mainErrorCount, 4);
});

test("product journey harness waits for delayed main stderr before finalizing", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessDrainTimeoutMs: 250,
    closeApp: async () => {
      setTimeout(() => {
        mainStderr.emit("data", "Fatal: emitted after process exit\n");
        mainStderr.emit("end");
      }, 20);
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-delayed");
  await harness.close(launched.app, launched.page, "main-delayed");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-delayed",
        message: "Fatal: emitted after process exit\n",
      },
    ],
  );
});

test("product journey harness fails closed when main stderr never drains", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub({ stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessDrainTimeoutMs: 20,
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-drain-timeout");
  await harness.close(launched.app, launched.page, "main-drain-timeout");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-drain-timeout",
        message:
          "Main stderr stream did not end or close within 20ms after application close.",
      },
    ],
  );
});

test("product journey harness opts in before launch and reads structured lifecycle events", async (t) => {
  const lifecycleEvents = [
    {
      schemaVersion: 1,
      transitionId: "project:trace",
      sequence: 0,
      timestampMs: 100,
      kind: "project",
      phase: "switch-requested",
      from: { projectId: "a" },
      to: { projectId: "b" },
    },
  ];
  let initScriptConfig = null;
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
    evaluate: async (_operation, argument) => {
      if (typeof argument === "string") return lifecycleEvents;
      return undefined;
    },
  };
  const app = {
    context: () => ({
      addInitScript: async (_operation, config) => {
        initScriptConfig = config;
      },
    }),
    firstWindow: async () => page,
    process: () => childProcessStub(),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("lifecycle-trace");
  assert.equal(
    initScriptConfig.optInKey,
    "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_TRACE__",
  );
  assert.equal(initScriptConfig.eventName, "grimodex:lifecycle-trace");
  assert.deepEqual(
    await harness.readLifecycleTrace(launched.page),
    lifecycleEvents,
  );

  await harness.close(launched.app, launched.page, "lifecycle-trace");
  await harness.dispose({ success: true, name: "lifecycle-trace" });
});

test("invokeOk hard-stops a hung renderer operation with phase, command, and request identity", async () => {
  const result = invokeOk(
    {
      evaluate: async () => new Promise(() => {}),
    },
    "hung_command",
    { secret: "must-not-be-logged" },
    {
      phase: "observability/hung-ipc",
      requestId: "request-hung-ipc",
      timeoutMs: 20,
    },
  );
  await assert.rejects(
    Promise.race([
      result,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("test timeout")), 250),
      ),
    ]),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.match(error.message, /observability\/hung-ipc/);
      assert.match(error.message, /hung_command/);
      assert.match(error.message, /request-hung-ipc/);
      return true;
    },
  );
});

test("waitUntil bounds each predicate iteration even when the predicate never settles", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    Promise.race([
      waitUntil(() => new Promise(() => {}), "hung predicate", 35, 1, {
        phase: "observability/hung-predicate",
        iterationTimeoutMs: 8,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("test timeout")), 250),
      ),
    ]),
    (error) => {
      assert.match(error.message, /timeout waiting for hung predicate/i);
      assert.match(error.message, /observability\/hung-predicate/);
      assert.ok(Date.now() - startedAt < 200);
      return true;
    },
  );
});

test("harness records durable operation journal entries without raw arguments", async (t) => {
  const journalRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-journal-"),
  );
  const journalPath = path.join(journalRoot, "operations.jsonl");
  const page = {
    isClosed: () => false,
    on: () => undefined,
    evaluate: async (_operation, argument) =>
      Array.isArray(argument) ? { ok: true, value: null } : undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => childProcessStub(),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    journalPath,
    operationTimeoutMs: 100,
    electronLauncher: { launch: async () => app },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  });

  const launched = await harness.launch("observability/journal");
  await harness.invokeOk(launched.page, "journal_command", {
    token: "do-not-write-this-secret",
  });
  await harness.close(launched.app, launched.page, "observability/journal");

  const lines = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(lines.length >= 2);
  assert.equal(
    lines.every((entry) => entry.phase.startsWith("observability/journal")),
    true,
  );
  assert.equal(
    lines.every((entry) => typeof entry.operation === "string"),
    true,
  );
  assert.equal(
    lines.every((entry) => /^request-[0-9a-f-]{36}$/u.test(entry.requestId)),
    true,
  );
  assert.equal(
    lines.every((entry) => /^sha256:[0-9a-f]{64}$/u.test(entry.argsDigest)),
    true,
  );
  assert.equal(
    lines.every((entry) => typeof entry.startedAt === "string"),
    true,
  );
  assert.equal(
    lines.every((entry) => typeof entry.finishedAt === "string"),
    true,
  );
  assert.equal(
    lines.every((entry) =>
      ["started", "completed", "failed", "timeout"].includes(entry.status),
    ),
    true,
  );
  assert.equal(
    (await readFile(journalPath, "utf8")).includes("do-not-write-this-secret"),
    false,
  );
  assert.ok(
    lines.some(
      (entry) =>
        entry.operation === "ipc:journal_command" && entry.status === "started",
    ),
  );
  assert.ok(
    lines.some(
      (entry) =>
        entry.operation === "ipc:journal_command" &&
        entry.status === "completed",
    ),
  );
});

test("lane watchdog captures partial evidence and kills registered children", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-watchdog-"),
  );
  const child = new EventEmitter();
  child.pid = 424242;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.killed = true;
    return true;
  };
  let captured = 0;
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));

  await assert.rejects(
    runWithLaneWatchdog(() => new Promise(() => {}), {
      phase: "observability/watchdog",
      timeoutMs: 20,
      children: [child],
      captureFailureArtifact: async (name) => {
        captured += 1;
        await writeFile(path.join(artifactRoot, `${name}.partial`), "partial");
      },
    }),
    /watchdog.*observability\/watchdog/i,
  );
  assert.equal(captured, 1);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    await readFile(
      path.join(artifactRoot, "observability-watchdog.partial"),
      "utf8",
    ),
    "partial",
  );
});

test("harness bounds lifecycle init-script installation and retains a partial lane artifact", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-init-timeout-"),
  );
  const mainProcess = new EventEmitter();
  mainProcess.pid = 424243;
  mainProcess.exitCode = null;
  mainProcess.signalCode = null;
  mainProcess.killSignals = [];
  mainProcess.kill = (signal) => {
    mainProcess.killSignals.push(signal);
    return true;
  };
  const app = {
    context: () => ({ addInitScript: async () => new Promise(() => {}) }),
    process: () => mainProcess,
    firstWindow: async () => {
      throw new Error("firstWindow must not run after init timeout");
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    operationTimeoutMs: 15,
    launchTimeoutMs: 200,
    electronLauncher: { launch: async () => app },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  await assert.rejects(harness.launch("observability/init-script"), (error) => {
    assert.match(error.message, /timed out/i);
    assert.match(error.message, /observability\/init-script/);
    assert.match(error.message, /page\.addInitScript:lifecycle-trace/);
    assert.match(error.message, /request-[0-9a-f-]{36}/u);
    return true;
  });
  await harness.dispose({ success: false, name: "observability-init-script" });
  assert.deepEqual(mainProcess.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(
    await readFile(
      path.join(
        artifactRoot,
        "observability-init-script",
        "runtime",
        "operations.jsonl",
      ),
      "utf8",
    ).then((contents) =>
      contents.includes("page.addInitScript:lifecycle-trace"),
    ),
  );
});

test("harness signal abort captures exactly once before child cleanup", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-signal-"),
  );
  const baselineSignalListeners = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  const child = new EventEmitter();
  child.pid = 424244;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  const page = {
    isClosed: () => false,
    on: () => undefined,
    evaluate: async () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => child,
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    laneWatchdogMs: 250,
    operationTimeoutMs: 100,
    electronLauncher: { launch: async () => app },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });
  const launched = await harness.launch("observability/signal");
  const running = harness.withLaneWatchdog(
    () => new Promise(() => {}),
    "observability/signal",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    process.listenerCount("SIGINT"),
    baselineSignalListeners.sigint + 1,
  );
  assert.equal(
    process.listenerCount("SIGTERM"),
    baselineSignalListeners.sigterm + 1,
  );
  process.emit("SIGTERM");
  process.emit("SIGTERM");
  assert.equal(
    process.listenerCount("SIGTERM"),
    baselineSignalListeners.sigterm + 1,
  );
  await Promise.all([harness.abort("SIGTERM"), harness.abort("SIGTERM")]);
  await assert.rejects(running, /aborted.*observability\/signal/i);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  await harness
    .close(launched.app, launched.page, "observability/signal")
    .catch(() => undefined);
  await harness.dispose({ success: false, name: "observability-signal" });
  assert.equal(process.listenerCount("SIGINT"), baselineSignalListeners.sigint);
  assert.equal(
    process.listenerCount("SIGTERM"),
    baselineSignalListeners.sigterm,
  );
  const retained = await readdir(artifactRoot);
  assert.deepEqual(retained, ["observability-signal"]);
});

test("late electron launch resolution is registered and cleaned after timeout", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-late-launch-"),
  );
  const child = new EventEmitter();
  child.pid = 424245;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  const childKillStarted = createPromiseBarrier();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.killed = true;
    childKillStarted.resolve();
    child.exitCode = 0;
    return true;
  };
  let resolveLaunch;
  const launchResult = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const lateApp = {
    context: () => null,
    process: () => child,
    firstWindow: async () => {
      throw new Error("late launch must not reach firstWindow");
    },
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    operationTimeoutMs: 15,
    launchTimeoutMs: 100,
    electronLauncher: { launch: async () => launchResult },
    closeApp: async (app) => {
      app.closed = true;
      resolveClosed();
    },
  });
  t.after(async () => {
    resolveLaunch?.(lateApp);
    await harness.dispose({ success: false, name: "late-launch" });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  await assert.rejects(harness.launch("observability/late-launch"), (error) => {
    assert.match(error.message, /timed out/i);
    assert.match(error.message, /electron-launch/);
    assert.match(error.message, /observability\/late-launch/);
    return true;
  });
  resolveLaunch(lateApp);
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("late launch cleanup timeout")), 500),
    ),
  ]);
  assert.equal(lateApp.closed, true);
  await awaitPromiseBarrier(
    childKillStarted,
    "late Electron child cleanup",
    LOADED_ELECTRON_BARRIER_TIMEOUT_MS,
  );
  assert.equal(child.killed, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  await harness.dispose({ success: false, name: "late-launch" });
});

test("lane timeout owns late Electron cleanup before publishing one artifact", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-lane-late-owned-"),
  );
  const child = new EventEmitter();
  child.pid = 424251;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    return true;
  };
  let resolveLaunch;
  const launchResult = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  const lateApp = { process: () => child };
  const phase = "observability/lane-late-owned";
  const artifactName = "observability-lane-late-owned";
  const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
  let closeCalls = 0;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    operationTimeoutMs: 100,
    launchTimeoutMs: 10_000,
    electronLauncher: {
      launch: async () => {
        electronLaunchStarted.resolve();
        setTimeout(() => resolveLaunch(lateApp), laneTimeoutMs + 50);
        return launchResult;
      },
    },
    closeApp: async (app) => {
      closeCalls += 1;
      app.closed = true;
    },
  });
  t.after(async () => {
    resolveLaunch?.(lateApp);
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const running = harness.withLaneWatchdog(() => harness.launch(phase), {
    phase,
    timeoutMs: laneTimeoutMs,
  });
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    running,
    phase,
  );
  await assert.rejects(running, /watchdog.*lane-late-owned/i);
  assert.equal(closeCalls, 1);
  assert.equal(lateApp.closed, true);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);

  await harness.dispose({ success: false, name: artifactName });
  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  const artifactDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(artifactDiagnostics.cleanPass, false);
  assert.equal(artifactDiagnostics.closeDiagnostics.length, 1);
  assert.equal(
    artifactDiagnostics.closeDiagnostics[0].errorName,
    "ProductJourneyLaneWatchdogError",
  );
  assert.equal(artifactDiagnostics.closeDiagnostics[0].fatal, true);
  const journal = await readFile(
    path.join(artifactRoot, artifactName, "runtime", "operations.jsonl"),
    "utf8",
  );
  assert.match(journal, /"operation":"electron-close"/u);
  assert.match(journal, /"status":"completed"/u);
});

test("lane timeout records pending Electron launch cleanup without duplicate artifacts", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-lane-pending-forever-"),
  );
  const phase = "observability/lane-pending-forever";
  const artifactName = "observability-lane-pending-forever";
  const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
  let launchCalls = 0;
  const electronLaunchStarted = createPromiseBarrier();
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
    operationTimeoutMs: 100,
    launchTimeoutMs: 10_000,
    electronLauncher: {
      launch: () => {
        launchCalls += 1;
        electronLaunchStarted.resolve();
        return new Promise(() => {});
      },
    },
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const running = harness.withLaneWatchdog(() => harness.launch(phase), {
    phase,
    timeoutMs: laneTimeoutMs,
  });
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    running,
    phase,
  );
  await assert.rejects(running, /watchdog.*lane-pending-forever/i);
  assert.ok(
    Date.now() - startedAt < 4_000,
    "pending launch must use the injected cleanup timeout",
  );
  assert.equal(launchCalls, 1);

  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  const diagnostics = await readRetainedDiagnostics(artifactRoot, artifactName);
  assert.equal(diagnostics.cleanPass, false);
  assert.equal(diagnostics.closeDiagnostics.length, 2);
  assert.ok(
    diagnostics.closeDiagnostics.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(diagnostics),
  );
  assert.ok(
    diagnostics.closeDiagnostics.some(
      (issue) =>
        issue.fatal === true &&
        issue.errorName === "ElectronChildProcessCaptureError" &&
        issue.message.includes("Late Electron launch did not settle"),
    ),
    JSON.stringify(diagnostics),
  );
  await harness.dispose({ success: false, name: artifactName });
  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
});

test("late Electron close rejection is retained as a fatal diagnostic", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-late-close-reject-"),
  );
  const child = new EventEmitter();
  child.pid = 424252;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    return true;
  };
  let resolveLaunch;
  const launchResult = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  const lateApp = { process: () => child };
  const phase = "observability/late-close-reject";
  const artifactName = "observability-late-close-reject";
  // The harness performs journal fsync and receipt preflight before invoking
  // Electron; allow that deterministic setup to complete under the loaded
  // Electron contract worker while keeping the late-launch offset intact.
  const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    operationTimeoutMs: 100,
    launchTimeoutMs: 10_000,
    electronLauncher: {
      launch: async () => {
        electronLaunchStarted.resolve();
        setTimeout(() => resolveLaunch(lateApp), laneTimeoutMs + 50);
        return launchResult;
      },
    },
    closeApp: async () => {
      throw new Error("late close rejected");
    },
  });
  t.after(async () => {
    resolveLaunch?.(lateApp);
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const running = harness.withLaneWatchdog(() => harness.launch(phase), {
    phase,
    timeoutMs: laneTimeoutMs,
  });
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    running,
    phase,
  );
  await assert.rejects(running, /watchdog.*late-close-reject/i);
  await harness.dispose({ success: false, name: artifactName });

  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  const artifactDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(artifactDiagnostics.cleanPass, false);
  assert.equal(artifactDiagnostics.closeDiagnostics.length, 2);
  const closeDiagnostic = artifactDiagnostics.closeDiagnostics.find((issue) =>
    issue.message.includes("late close rejected"),
  );
  assert.ok(closeDiagnostic, JSON.stringify(artifactDiagnostics));
  assert.equal(closeDiagnostic.fatal, true);
  assert.ok(
    artifactDiagnostics.closeDiagnostics.some(
      (issue) => issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(artifactDiagnostics),
  );
  assert.match(closeDiagnostic.message, /late close rejected/u);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("late Electron close hang is bounded and retained as a fatal diagnostic", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-late-close-hang-"),
  );
  const child = new EventEmitter();
  child.pid = 424253;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    return true;
  };
  let resolveLaunch;
  const launchResult = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  const electronLaunchStarted = createPromiseBarrier();
  const lateApp = { process: () => child };
  const phase = "observability/late-close-hang";
  const artifactName = "observability-late-close-hang";
  const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    failureCleanupTimeoutMs: HANGING_CLEANUP_TIMEOUT_MS,
    operationTimeoutMs: 100,
    launchTimeoutMs: 10_000,
    electronLauncher: {
      launch: async () => {
        electronLaunchStarted.resolve();
        setTimeout(() => resolveLaunch(lateApp), laneTimeoutMs + 50);
        return launchResult;
      },
    },
    closeApp: async () => new Promise(() => {}),
  });
  t.after(async () => {
    resolveLaunch?.(lateApp);
    await harness.dispose({ success: false, name: artifactName });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const running = harness.withLaneWatchdog(() => harness.launch(phase), {
    phase,
    timeoutMs: laneTimeoutMs,
  });
  await awaitPromiseBarrierBeforeOperationSettles(
    electronLaunchStarted,
    running,
    phase,
  );
  await assert.rejects(running, /watchdog.*late-close-hang/i);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 4_000, `late cleanup exceeded bound: ${elapsedMs}ms`);
  await harness.dispose({ success: false, name: artifactName });

  assert.deepEqual(await readdir(artifactRoot), [artifactName]);
  const artifactDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        artifactName,
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.equal(artifactDiagnostics.cleanPass, false);
  assert.equal(artifactDiagnostics.closeDiagnostics.length, 2);
  const closeDiagnostic = artifactDiagnostics.closeDiagnostics.find(
    (issue) => issue.errorName === "ProductJourneyOperationTimeoutError",
  );
  assert.ok(closeDiagnostic, JSON.stringify(artifactDiagnostics));
  assert.equal(closeDiagnostic.fatal, true);
  assert.match(closeDiagnostic.message, /after 500ms/u);
  assert.ok(
    artifactDiagnostics.closeDiagnostics.some(
      (issue) => issue.errorName === "ProductJourneyLaneWatchdogError",
    ),
    JSON.stringify(artifactDiagnostics),
  );
  assert.match(closeDiagnostic.message, /timed out/u);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("late Electron child kill false or throw is fatal and preserves tracking", async (t) => {
  for (const [label, kill] of [
    ["false", () => false],
    [
      "throw",
      () => {
        throw new Error("late kill threw");
      },
    ],
  ]) {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), `grimodex-product-late-kill-${label}-`),
    );
    const child = new EventEmitter();
    child.pid = label === "false" ? 424254 : 424255;
    child.exitCode = null;
    child.signalCode = null;
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      return kill();
    };
    let resolveLaunch;
    const launchResult = new Promise((resolve) => {
      resolveLaunch = resolve;
    });
    const electronLaunchStarted = createPromiseBarrier();
    const lateApp = { process: () => child };
    const phase = `observability/late-kill-${label}`;
    const artifactName = `observability-late-kill-${label}`;
    const laneTimeoutMs = LOADED_ELECTRON_LANE_TIMEOUT_MS;
    const harness = createProductJourneyHarness({
      mainCjs: "/tmp/fake-main.cjs",
      electronBin: "/tmp/fake-electron",
      artifactRoot,
      operationTimeoutMs: 100,
      launchTimeoutMs: 10_000,
      electronLauncher: {
        launch: async () => {
          electronLaunchStarted.resolve();
          setTimeout(() => resolveLaunch(lateApp), laneTimeoutMs + 50);
          return launchResult;
        },
      },
      closeApp: async () => undefined,
    });
    t.after(async () => {
      resolveLaunch?.(lateApp);
      await harness.dispose({ success: false, name: artifactName });
      await rm(harness.tmpRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    });

    const startedAt = Date.now();
    const running = harness.withLaneWatchdog(() => harness.launch(phase), {
      phase,
      timeoutMs: laneTimeoutMs,
    });
    await awaitPromiseBarrierBeforeOperationSettles(
      electronLaunchStarted,
      running,
      phase,
    );
    await assert.rejects(running, new RegExp(`watchdog.*late-kill-${label}`));
    assert.ok(Date.now() - startedAt < 3_000);
    await harness.dispose({ success: false, name: artifactName });

    assert.deepEqual(await readdir(artifactRoot), [artifactName]);
    const artifactDiagnostics = JSON.parse(
      await readFile(
        path.join(
          artifactRoot,
          artifactName,
          "runtime",
          "diagnostics",
          "renderer-diagnostics.json",
        ),
        "utf8",
      ),
    );
    assert.equal(artifactDiagnostics.cleanPass, false);
    assert.equal(artifactDiagnostics.closeDiagnostics.length, 2);
    const terminationDiagnostic = artifactDiagnostics.closeDiagnostics.find(
      (issue) => issue.phase.endsWith("/termination"),
    );
    assert.ok(terminationDiagnostic, JSON.stringify(artifactDiagnostics));
    assert.equal(terminationDiagnostic.fatal, true);
    assert.equal(
      terminationDiagnostic.errorName,
      "ElectronChildProcessTerminationError",
    );
    assert.ok(
      artifactDiagnostics.closeDiagnostics.some(
        (issue) => issue.errorName === "ProductJourneyLaneWatchdogError",
      ),
      JSON.stringify(artifactDiagnostics),
    );
    assert.match(
      terminationDiagnostic.phase,
      new RegExp(`late-kill-${label}/termination`),
    );
    assert.equal(child.exitCode, null);
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  }
});

test("failure evidence is published before a bounded optional screenshot", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-hung-screenshot-"),
  );
  const runtime = path.join(artifactRoot, "hung-screenshot", "runtime");
  const runtimeOperationsPath = path.join(runtime, "operations.jsonl");
  let resolveScreenshotStarted;
  const screenshotStarted = new Promise((resolve) => {
    resolveScreenshotStarted = resolve;
  });
  let screenshotEvidence;
  let screenshotEvidenceError;
  const page = {
    isClosed: () => false,
    on: () => undefined,
    evaluate: async () => [],
    waitForFunction: async () => undefined,
    screenshot: async () => {
      try {
        screenshotEvidence = {
          operations: await readFile(runtimeOperationsPath, "utf8"),
          mainLog: await readFile(
            path.join(runtime, "diagnostics", "main.log"),
            "utf8",
          ),
          rendererLog: await readFile(
            path.join(runtime, "diagnostics", "renderer.log"),
            "utf8",
          ),
          authorityTimeline: await readFile(
            path.join(runtime, "diagnostics", "authority-timeline.json"),
            "utf8",
          ),
          rendererDiagnostics: await readFile(
            path.join(runtime, "diagnostics", "renderer-diagnostics.json"),
            "utf8",
          ),
          mainDiagnostics: await readFile(
            path.join(runtime, "diagnostics", "main-diagnostics.json"),
            "utf8",
          ),
          database: await readFile(
            path.join(
              runtime,
              "diagnostics",
              "databases",
              "snapshot-workspace.db",
            ),
          ),
          receiptSnapshot: await readdir(
            path.join(runtime, "diagnostics", "receipt-snapshot"),
          ),
        };
      } catch (error) {
        screenshotEvidenceError = error;
      }
      resolveScreenshotStarted();
      return new Promise(() => {});
    },
  };
  const app = {
    context: () => null,
    firstWindow: async () => page,
    process: () => childProcessStub(),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    operationTimeoutMs: LOADED_ELECTRON_OPERATION_TIMEOUT_MS,
    electronLauncher: { launch: async () => app },
    closeApp: async () => undefined,
  });
  t.after(async () => {
    await harness.dispose({ success: false, name: "hung-screenshot" });
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const launched = await harness.launch("observability/hung-screenshot");
  const snapshotWorkspace = harness.workspacePath("snapshot-workspace");
  await mkdir(snapshotWorkspace, { recursive: true });
  await execFile("sqlite3", [
    path.join(snapshotWorkspace, "grimodex.db"),
    "CREATE TABLE evidence (value TEXT);",
  ]);
  let captureSettled = false;
  const capture = harness.captureFailureArtifact("hung-screenshot");
  void capture.then(
    () => {
      captureSettled = true;
    },
    () => {
      captureSettled = true;
    },
  );

  let screenshotAttemptTimer;
  try {
    await Promise.race([
      screenshotStarted,
      new Promise((_, reject) => {
        screenshotAttemptTimer = setTimeout(
          () =>
            reject(
              new Error(
                `screenshot was not attempted within ${HUNG_SCREENSHOT_ATTEMPT_TIMEOUT_MS}ms`,
              ),
            ),
          HUNG_SCREENSHOT_ATTEMPT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (screenshotAttemptTimer) clearTimeout(screenshotAttemptTimer);
  }
  if (screenshotEvidenceError) {
    throw new Error("durable failure evidence was not published", {
      cause: screenshotEvidenceError,
    });
  }
  assert.ok(screenshotEvidence);
  assert.match(screenshotEvidence.operations, /electron-launch/);
  assert.equal(screenshotEvidence.mainLog, "");
  assert.ok(screenshotEvidence.rendererLog !== undefined);
  assert.ok(screenshotEvidence.authorityTimeline !== undefined);
  assert.ok(screenshotEvidence.rendererDiagnostics !== undefined);
  assert.ok(screenshotEvidence.mainDiagnostics !== undefined);
  assert.ok(screenshotEvidence.database.byteLength > 0);
  assert.ok(Array.isArray(screenshotEvidence.receiptSnapshot));
  assert.equal(
    captureSettled,
    false,
    "capture must still be pending on the bounded screenshot",
  );
  let captureCompletionTimer;
  try {
    await Promise.race([
      capture,
      new Promise((_, reject) => {
        captureCompletionTimer = setTimeout(
          () => reject(new Error("hung screenshot was not bounded")),
          HUNG_SCREENSHOT_CAPTURE_COMPLETION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (captureCompletionTimer) clearTimeout(captureCompletionTimer);
  }
  assert.equal(captureSettled, true);
  await harness
    .close(launched.app, launched.page, "observability/hung-screenshot")
    .catch(() => undefined);
});

test("journal close rejects appends before waiting for accepted writes", async (t) => {
  const journalRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-journal-close-"),
  );
  const journalPath = path.join(journalRoot, "operations.jsonl");
  const journal = createProductJourneyJournal(journalPath);
  t.after(() => rm(journalRoot, { recursive: true, force: true }));

  const entry = {
    phase: "observability/journal-close",
    operation: "test",
    requestId: "request-journal-close",
    argsDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "started",
  };
  const accepted = journal.append(entry);
  const closing = journal.close();
  await assert.rejects(
    journal.append({ ...entry, status: "completed" }),
    /closed|closing/i,
  );
  await Promise.all([accepted, closing]);
  await assert.rejects(journal.append(entry), /closed|closing/i);
  assert.equal(
    (await readFile(journalPath, "utf8")).trim().split("\n").length,
    1,
  );
});

test("lane watchdog kills children registered while cleanup is draining", async () => {
  const firstChild = { pid: 424246 };
  const lateChild = { pid: 424247 };
  let registerChild;
  const killed = [];
  const killChildren = async (child) => {
    killed.push(child);
    if (child === firstChild) registerChild(lateChild);
  };
  const running = runWithLaneWatchdog(
    async (context) => {
      registerChild = context.registerChild;
      await new Promise(() => {});
    },
    {
      phase: "observability/late-child",
      timeoutMs: 20,
      children: [firstChild],
      killChildren,
    },
  );
  await assert.rejects(running, /watchdog.*observability\/late-child/i);
  assert.equal(killed.includes(firstChild), true);
  assert.equal(killed.includes(lateChild), true);
});

test("killProcessTree addresses descendants after an exited direct child", async () => {
  const originalKill = process.kill;
  const groupSignals = [];
  process.kill = (pid, signal) => {
    if (pid === -424248) {
      groupSignals.push(signal);
      return true;
    }
    return originalKill(pid, signal);
  };
  try {
    await killProcessTree(
      {
        pid: 424248,
        exitCode: 0,
        signalCode: null,
        kill: () => {
          throw new Error("direct child is already exited");
        },
      },
      { graceMs: 0 },
    );
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(groupSignals, ["SIGTERM", "SIGKILL"]);
});

test("late launch resolution after an AbortSignal invokes the cleanup hook", async () => {
  const controller = new AbortController();
  let resolveLaunch;
  const launchResult = new Promise((resolve) => {
    resolveLaunch = resolve;
  });
  let observedLateApp;
  let resolveLateApp;
  const lateAppObserved = new Promise((resolve) => {
    resolveLateApp = resolve;
  });
  const lateApp = { id: "late-after-abort" };

  const pending = withOperationTimeout("electron-launch", () => launchResult, {
    phase: "observability/aborted-launch",
    command: "electron-launch",
    requestId: "request-aborted-launch",
    timeoutMs: 1_000,
    signal: controller.signal,
    onLateResolve: (app) => {
      observedLateApp = app;
      resolveLateApp(app);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("lane-watchdog");
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /aborted/);
    assert.match(error.message, /observability\/aborted-launch/);
    assert.match(error.message, /request-aborted-launch/);
    return true;
  });

  resolveLaunch(lateApp);
  await Promise.race([
    lateAppObserved,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("late resolve hook was not called")),
        250,
      ),
    ),
  ]);
  assert.equal(observedLateApp, lateApp);
});

test("late old launch cleanup does not touch an active replacement app", async (t) => {
  const makeChild = (pid) => {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      child.exitCode = 0;
      return true;
    };
    return child;
  };
  const page = {
    isClosed: () => false,
    on: () => undefined,
    evaluate: async () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const replacementChild = makeChild(424249);
  const oldChild = makeChild(424250);
  const oldChildKillStarted = createPromiseBarrier();
  const oldChildKill = oldChild.kill;
  oldChild.kill = (signal) => {
    oldChildKillStarted.resolve();
    return oldChildKill(signal);
  };
  const replacementApp = {
    context: () => null,
    firstWindow: async () => page,
    process: () => replacementChild,
  };
  const oldApp = {
    context: () => null,
    firstWindow: async () => {
      throw new Error("old launch must not reach firstWindow");
    },
    process: () => oldChild,
  };
  let resolveOldLaunch;
  const oldLaunch = new Promise((resolve) => {
    resolveOldLaunch = resolve;
  });
  let launchCount = 0;
  const closeCalls = [];
  const oldClosed = new Promise((resolve) => {
    oldApp.resolveClosed = resolve;
  });
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    operationTimeoutMs: 20,
    launchTimeoutMs: 30,
    electronLauncher: {
      launch: async () => (launchCount++ === 0 ? replacementApp : oldLaunch),
    },
    closeApp: async (app) => {
      closeCalls.push(app);
      app.closed = true;
      if (app === oldApp) app.resolveClosed();
    },
  });
  t.after(async () => {
    resolveOldLaunch?.(oldApp);
    await harness.dispose({ success: false, name: "replacement-active" });
    await rm(harness.tmpRoot, { recursive: true, force: true });
  });

  const replacement = await harness.launch("observability/replacement-active");
  await assert.rejects(
    harness.launch("observability/old-launch"),
    /timed out.*observability\/old-launch/i,
  );
  assert.equal(replacementApp.closed, undefined);
  assert.deepEqual(replacementChild.killSignals, []);

  resolveOldLaunch(oldApp);
  await Promise.race([
    oldClosed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("old app was not closed")), 500),
    ),
  ]);
  await awaitPromiseBarrier(
    oldChildKillStarted,
    "late old Electron child cleanup",
    LOADED_ELECTRON_BARRIER_TIMEOUT_MS,
  );
  assert.equal(oldApp.closed, true);
  assert.deepEqual(oldChild.killSignals, ["SIGTERM"]);
  assert.deepEqual(replacementChild.killSignals, []);
  assert.equal(closeCalls.filter((app) => app === replacementApp).length, 0);
  assert.equal(closeCalls.filter((app) => app === oldApp).length, 1);

  await harness
    .close(
      replacement.app,
      replacement.page,
      "observability/replacement-active",
    )
    .catch(() => undefined);
});
