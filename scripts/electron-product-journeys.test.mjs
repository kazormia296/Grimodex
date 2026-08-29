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

import { PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";
import {
  createProductJourneyHarness,
  invokeOk,
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
  assertNarrativeMaintenanceCiReceipt,
  assertNarrativeMaintenanceCiHeldFreshnessReceipt,
  expectedNarrativeMaintenanceCiReceipt,
  readNarrativeMaintenanceCiHeldFreshness,
  narrativeMaintenanceReceiptRoot,
  MAIN_PROCESS_NOISE_ALLOWLIST,
  runWithLaneWatchdog,
  waitUntil,
} from "../electron/scripts/product-journey-harness.mjs";
import {
  configureWorkspace,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const execFile = promisify(execFileCallback);

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function runCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

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
});

const RECEIPT_NONCE = "00000000-0000-4000-8000-000000000001";
const RECEIPT_STALE_NONCE = "00000000-0000-4000-8000-000000000002";
const HELD_FRESHNESS_REQUEST_NONCE = "00000000-0000-4000-8000-000000000003";
const HELD_FRESHNESS_INITIAL_REQUEST_NONCE =
  "00000000-0000-4000-8000-000000000006";

function canonicalReceiptText(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
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
    process: () => ({ stdout: new EventEmitter(), stderr: null }),
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
    process: () => ({ stdout: new EventEmitter(), stderr: null }),
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
    process: () => ({ stdout: new EventEmitter(), stderr: null }),
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
  const stuckWrite = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
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
  await assert.rejects(
    harness.awaitHeldFreshness(launched.app, "held-freshness-retry/stuck", {
      previousSequence: 2,
      requestNonce: stuckRequestNonce,
      authorityId: "authority-1",
      generation: 1,
      workspaceBinding: { authorityId: "authority-1", generation: 1 },
    }),
    /partial\/stuck/i,
  );
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
      process: () => ({ stdout, stderr: null }),
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
              process: () => ({ stdout: new EventEmitter(), stderr: null }),
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
      process: () => ({ stdout, stderr: null }),
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
      process: () => ({ stdout: new EventEmitter(), stderr: null }),
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
      process: () => ({ stdout: new EventEmitter(), stderr: null }),
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

test("workspace pairs are created in one cold configure session before startup auto-open", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-workspace-pair-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const workspaceA = path.join(temporaryRoot, "workspace-a");
  const workspaceB = path.join(temporaryRoot, "workspace-b");
  const calls = [];
  const app = {};
  const page = {};
  const harness = {
    async launch(phase) {
      calls.push({ kind: "launch", phase });
      return { app, page };
    },
    async invokeOk(_page, command, args) {
      calls.push({ kind: "invoke", command, args });
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

  await configureWorkspace(harness, workspaceA, {
    appSettings: { "editor.autoSaveDelay": 60_000 },
    additionalWorkspaces: [workspaceB],
  });

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
        process: () => ({ stdout: null, stderr: null }),
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
  assert.match(source, /workspace-chat-stream-drained/);
  assert.match(source, /project-pending-editor-restored/);
  assert.match(source, /mcp-clean-external-write-reloaded/);
  assert.match(source, /mcp-dirty-external-write-conflict/);
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: null }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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

test("default main allowances cover only exact expiring Ubuntu Xvfb diagnostics", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
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
  const launched = await harness.launch("configure");
  mainStderr.emit(
    "data",
    '[6341:0730/134519.105645:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")\n',
  );
  mainStderr.emit(
    "data",
    "[6341:0730/134519.106425:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: \n",
  );
  mainStderr.emit(
    "data",
    "[6468:0730/134521.502865:ERROR:gpu/command_buffer/service/context_group.cc:148] ContextResult::kFatalFailure: WebGL2 blocklisted\n",
  );
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
  );
  mainStderr.emit("data", "Fatal: database corruption\n");
  await harness.close(launched.app, launched.page, "configure");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, 5);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [{ phase: "configure", message: "Fatal: database corruption\n" }],
  );
});

test("trusted restore reload allows only the exact Ubuntu Xvfb Skia mailbox line", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
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

  const phase = "c2-5b-restore-verify-rebuild-verify/open";
  const launched = await harness.launch(phase);
  mainStderr.emit(
    "data",
    "[146128:0824/022134.434622:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
  );
  await harness.close(launched.app, launched.page, phase);

  const diagnostics = await harness.finalizeDiagnostics();
  assert.equal(diagnostics.mainErrorCount, 1);
  assert.deepEqual(diagnostics.unallowedMainErrors, []);
  assert.equal(diagnostics.mainCleanPass, true);
});

test("C2-ZC restore reload allows the exact Ubuntu Xvfb Skia mailbox line", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
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

  const diagnostics = await harness.finalizeDiagnostics();
  assert.equal(diagnostics.mainErrorCount, 1);
  assert.deepEqual(diagnostics.unallowedMainErrors, []);
  assert.equal(diagnostics.mainCleanPass, true);
});

test("C2-ZC post-marker bootstrap restore allows the exact Ubuntu Xvfb Skia mailbox line", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
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

  const phase = "c2-zc-post-marker-lifecycle/bootstrap-restore";
  const launched = await harness.launch(phase);
  mainStderr.emit(
    "data",
    "[1145775:0828/155801.947748:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
  );
  await harness.close(launched.app, launched.page, phase);

  const diagnostics = await harness.finalizeDiagnostics();
  assert.ok(diagnostics.mainErrorCount >= 1);
  assert.deepEqual(diagnostics.unallowedMainErrors, []);
  assert.equal(diagnostics.mainCleanPass, true);
});

test("C2-ZC Skia mailbox allowance remains phase- and message-exact", async (t) => {
  const exact =
    "[1145775:0828/155801.947748:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n";
  for (const [phase, message] of [
    ["c2-zc-canonical-authority-cutover/open", exact],
    ["c2-zc-post-marker-lifecycle/new-project", exact],
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
      process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: mainStderr }),
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
    process: () => ({ stdout: null, stderr: null }),
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
    process: () => ({ stdout: null, stderr: null }),
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
