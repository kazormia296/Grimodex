import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { _electron } from "playwright";

import { closeElectronAppWithDiagnostics } from "./close-electron-app.mjs";
import { C2ZC_RENDERER_DML_PHASE_ALLOWLIST } from "./c2zc-renderer-mcp-dml-denial-product-journey.mjs";

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCallback);
const PRODUCT_JOURNEY_AI_ENV = "GRIMODEX_PRODUCT_JOURNEY_FAKE_AI";
const PRODUCT_JOURNEY_AI_VERSION = "deterministic-v1";
const PRODUCT_JOURNEY_FIXTURE_DML_OWNER = "ci-product-journey-harness-v1";
export const PRODUCT_JOURNEY_FIXTURE_OPERATION_KINDS = Object.freeze([
  "app-settings-upsert",
  "project-settings-upsert",
  "content-version-insert",
  "dependency-edge-insert",
  "dependency-derived-state-gap-delete",
]);
export const NARRATIVE_MAINTENANCE_NONCE_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN =
  "c2-5b-product-journey-owner-v1";
export const NARRATIVE_MAINTENANCE_RECEIPT_EVENT =
  "grimodex:narrative-maintenance-ci-receipt";
export const NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE =
  "grimodex:narrative-maintenance-ci-quiescence";
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE =
  "grimodex:narrative-maintenance-ci-quiescence-request";
export const NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME =
  ".grimodex-product-journey-receipts";
export const NARRATIVE_MAINTENANCE_RECEIPT_VERSION = 1;
export const NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES = 4_096;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES = 16_384;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES = 4_096;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE =
  "quiescence-request.json";
const NARRATIVE_MAINTENANCE_SETUP_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP";
const NARRATIVE_MAINTENANCE_FRESHNESS_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS";
const NARRATIVE_MAINTENANCE_FAULT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT";
const NARRATIVE_MAINTENANCE_TRIGGER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
export const NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS_HOLD_PROJECT_ID";
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
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function nullableEnvironmentValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Derive the receipt expected for one harness launch. The owner token is
 * consulted only to decide whether an active receipt is required; it is never
 * copied into the receipt itself.
 */
export function expectedNarrativeMaintenanceCiReceipt(env = process.env) {
  if (
    env.CI !== "true" ||
    env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] !==
      NARRATIVE_MAINTENANCE_OWNER_TOKEN
  ) {
    return null;
  }
  const nonce = nullableEnvironmentValue(env, NARRATIVE_MAINTENANCE_NONCE_ENV);
  if (!nonce) {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_NONCE_ENV} is required for an active harness launch`,
    );
  }
  if (!UUID_V4.test(nonce)) {
    throw new Error(`${NARRATIVE_MAINTENANCE_NONCE_ENV} must be a UUIDv4`);
  }
  return {
    version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
    type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
    nonce,
    active: true,
    setup: nullableEnvironmentValue(env, NARRATIVE_MAINTENANCE_SETUP_ENV),
    freshness: nullableEnvironmentValue(
      env,
      NARRATIVE_MAINTENANCE_FRESHNESS_ENV,
    ),
    freshnessHoldProjectId: nullableEnvironmentValue(
      env,
      NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
    ),
    fault: nullableEnvironmentValue(env, NARRATIVE_MAINTENANCE_FAULT_ENV),
    trigger: nullableEnvironmentValue(env, NARRATIVE_MAINTENANCE_TRIGGER_ENV),
    isPackaged: false,
    nativeAck: true,
  };
}

/**
 * Validate an observed main receipt before renderer readiness is accepted.
 * Exact keys prevent accidental leakage of owner credentials or paths, while
 * nonce/effective-field equality prevents stale or mismatched launch ACKs.
 */
export function assertNarrativeMaintenanceCiReceipt(receipt, expected) {
  if (expected === null) {
    if (receipt !== null && receipt !== undefined) {
      throw new Error(
        "unexpected active narrative maintenance receipt during production launch",
      );
    }
    return null;
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("missing narrative maintenance receipt");
  }
  if ("ownerToken" in receipt || "path" in receipt) {
    throw new Error("narrative maintenance receipt owner token/path leak");
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(receipt).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `narrative maintenance receipt fields mismatch: expected ${expectedKeys.join(",")}, got ${actualKeys.join(",")}`,
    );
  }
  for (const key of expectedKeys) {
    if (receipt[key] !== expected[key]) {
      throw new Error(
        `narrative maintenance receipt ${key} mismatch: expected ${String(expected[key])}, got ${String(receipt[key])}`,
      );
    }
  }
  return receipt;
}

const QUIESCENCE_BINDING_KEYS = ["authorityId", "generation"];
const QUIESCENCE_STATE_KEYS = [
  "authorityId",
  "generation",
  "freshnessHoldProjectId",
  "heldProjectId",
  "projects",
  "marker",
  "stateDigest",
];
const QUIESCENCE_CURSOR_KEYS = [
  "acknowledgedThrough",
  "reservedThrough",
  "activeRunId",
  "semanticEpochId",
  "lastError",
];
const QUIESCENCE_PROJECT_KEYS = [
  "projectId",
  "currentEpochId",
  "feedHead",
  "cursor",
];
const QUIESCENCE_MARKER_KEYS = ["migrationId", "contractVersion", "appliedAt"];
const QUIESCENCE_DISCOVERY_KEYS = [
  "discoveryGeneration",
  "empty",
  "inFlight",
  "timerScheduled",
  "pendingRetry",
  "pendingEvent",
  "wakeAckPending",
  "wakeOutboxDrainInFlight",
  "wakeOutboxDrainSucceeded",
  "wakeOutboxDrainFailed",
  "wakeOutboxPendingRows",
  "queueIdle",
];
const QUIESCENCE_FRESHNESS_KEYS = [
  "cycleGeneration",
  "inFlight",
  "hasMore",
  "noWrite",
  "heldProjectId",
  "cutoverNotReady",
  "wakePending",
  "timerScheduled",
  "nextCycleGuardStateDigest",
];
const QUIESCENCE_RECEIPT_KEYS = [
  "version",
  "type",
  "nonce",
  "requestNonce",
  "phase",
  "requestedAt",
  "sequence",
  "observedAt",
  "monotonicObservedAtMs",
  "workspaceBinding",
  "discovery",
  "freshness",
  "state",
  "stateDigest",
];

function assertExactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function assertQuiescenceBinding(value, label) {
  assertExactKeys(value, QUIESCENCE_BINDING_KEYS, label);
  if (
    typeof value.authorityId !== "string" ||
    value.authorityId.length === 0 ||
    value.authorityId.trim() !== value.authorityId ||
    value.authorityId.includes("\u0000") ||
    !Number.isSafeInteger(value.generation) ||
    value.generation <= 0
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertNullableSafeInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative safe integer or null`);
  }
}

function assertNullableIdentifier(value, label) {
  if (
    value !== null &&
    (typeof value !== "string" ||
      value.length === 0 ||
      value.trim() !== value ||
      value.includes("\u0000"))
  ) {
    throw new Error(`${label} must be a trimmed non-empty identifier or null`);
  }
}

function assertQuiescenceState(value) {
  assertExactKeys(value, QUIESCENCE_STATE_KEYS, "quiescence state");
  assertQuiescenceBinding(
    { authorityId: value.authorityId, generation: value.generation },
    "quiescence state workspace binding",
  );
  assertNullableIdentifier(
    value.freshnessHoldProjectId,
    "quiescence state freshness hold project",
  );
  assertNullableIdentifier(
    value.heldProjectId,
    "quiescence state held project",
  );
  if (
    value.heldProjectId !== null &&
    value.heldProjectId !== value.freshnessHoldProjectId
  ) {
    throw new Error(
      "quiescence state held project must match the effective freshness hold",
    );
  }
  if (!Array.isArray(value.projects)) {
    throw new Error("quiescence state projects must be an array");
  }
  let previousProjectId = "";
  for (const [index, project] of value.projects.entries()) {
    assertExactKeys(
      project,
      QUIESCENCE_PROJECT_KEYS,
      `quiescence state project ${index}`,
    );
    if (
      typeof project.projectId !== "string" ||
      project.projectId.length === 0 ||
      project.projectId.trim() !== project.projectId ||
      project.projectId.includes("\u0000") ||
      (previousProjectId !== "" && project.projectId <= previousProjectId)
    ) {
      throw new Error("quiescence state projects must be sorted and unique");
    }
    previousProjectId = project.projectId;
    if (
      project.currentEpochId !== null &&
      (typeof project.currentEpochId !== "string" ||
        project.currentEpochId.length === 0 ||
        project.currentEpochId.trim() !== project.currentEpochId)
    ) {
      throw new Error("quiescence state project epoch is invalid");
    }
    if (!Number.isSafeInteger(project.feedHead) || project.feedHead < 0) {
      throw new Error("quiescence state project feed head is invalid");
    }
    assertExactKeys(
      project.cursor,
      QUIESCENCE_CURSOR_KEYS,
      `quiescence state project ${index} cursor`,
    );
    assertNullableSafeInteger(
      project.cursor.acknowledgedThrough,
      `quiescence state project ${index} acknowledged cursor`,
    );
    assertNullableSafeInteger(
      project.cursor.reservedThrough,
      `quiescence state project ${index} reserved cursor`,
    );
    assertNullableIdentifier(
      project.cursor.activeRunId,
      `quiescence state project ${index} active run`,
    );
    assertNullableIdentifier(
      project.cursor.semanticEpochId,
      `quiescence state project ${index} cursor epoch`,
    );
    assertNullableIdentifier(
      project.cursor.lastError,
      `quiescence state project ${index} last error`,
    );
  }
  if (value.marker !== null) {
    assertExactKeys(
      value.marker,
      QUIESCENCE_MARKER_KEYS,
      "quiescence state marker",
    );
    if (
      value.marker.migrationId !== "narrative-c2-canonical-freshness-v1" ||
      value.marker.contractVersion !== 1 ||
      typeof value.marker.appliedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
        value.marker.appliedAt,
      )
    ) {
      throw new Error("quiescence state marker is invalid");
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.stateDigest)) {
    throw new Error("quiescence state digest is invalid");
  }
  const withoutDigest = { ...value };
  delete withoutDigest.stateDigest;
  const expectedDigest = receiptArtifactDigest(
    Buffer.from(canonicalJson(withoutDigest), "utf8"),
  );
  if (expectedDigest !== value.stateDigest) {
    throw new Error("quiescence state digest does not bind its state");
  }
  return value;
}

export function assertNarrativeMaintenanceCiQuiescenceRequest(
  request,
  expectedNonce,
) {
  assertExactKeys(
    request,
    ["version", "type", "nonce", "requestNonce", "phase", "requestedAt"],
    "quiescence request",
  );
  if (
    request.version !== NARRATIVE_MAINTENANCE_RECEIPT_VERSION ||
    request.type !== NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE ||
    request.nonce !== expectedNonce ||
    !UUID_V4.test(request.nonce) ||
    !UUID_V4.test(request.requestNonce) ||
    typeof request.phase !== "string" ||
    request.phase.length === 0 ||
    request.phase.length > 256 ||
    request.phase.trim() !== request.phase ||
    request.phase.includes("\u0000") ||
    typeof request.requestedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      request.requestedAt,
    ) ||
    !Number.isFinite(Date.parse(request.requestedAt))
  ) {
    throw new Error("quiescence request fields are invalid");
  }
  return request;
}

/** Validate one immutable main-owned quiescence sidecar. */
export function assertNarrativeMaintenanceCiQuiescenceReceipt(
  receipt,
  expectedNonce,
  expectedSequence = null,
  expectedRequest = null,
) {
  assertExactKeys(receipt, QUIESCENCE_RECEIPT_KEYS, "quiescence receipt");
  if (
    receipt.version !== NARRATIVE_MAINTENANCE_RECEIPT_VERSION ||
    receipt.type !== NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE ||
    receipt.nonce !== expectedNonce ||
    !UUID_V4.test(receipt.nonce) ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence <= 0 ||
    typeof receipt.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      receipt.observedAt,
    ) ||
    !Number.isSafeInteger(receipt.monotonicObservedAtMs) ||
    receipt.monotonicObservedAtMs < 0
  ) {
    throw new Error("quiescence receipt header is invalid");
  }
  if (
    !UUID_V4.test(receipt.requestNonce) ||
    typeof receipt.phase !== "string" ||
    receipt.phase.length === 0 ||
    receipt.phase.length > 256 ||
    receipt.phase.trim() !== receipt.phase ||
    receipt.phase.includes("\u0000") ||
    typeof receipt.requestedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      receipt.requestedAt,
    ) ||
    Date.parse(receipt.observedAt) < Date.parse(receipt.requestedAt)
  ) {
    throw new Error("quiescence receipt request echo is invalid");
  }
  if (
    expectedRequest !== null &&
    (receipt.requestNonce !== expectedRequest.requestNonce ||
      receipt.phase !== expectedRequest.phase ||
      receipt.requestedAt !== expectedRequest.requestedAt)
  ) {
    throw new Error("quiescence receipt request echo does not match request");
  }
  if (expectedSequence !== null && receipt.sequence !== expectedSequence) {
    throw new Error("quiescence receipt sequence is not contiguous");
  }
  assertQuiescenceBinding(
    receipt.workspaceBinding,
    "quiescence receipt binding",
  );
  assertExactKeys(
    receipt.discovery,
    QUIESCENCE_DISCOVERY_KEYS,
    "quiescence receipt discovery",
  );
  if (
    !Number.isSafeInteger(receipt.discovery.discoveryGeneration) ||
    receipt.discovery.discoveryGeneration <= 0 ||
    receipt.discovery.empty !== true ||
    receipt.discovery.inFlight !== false ||
    receipt.discovery.timerScheduled !== false ||
    receipt.discovery.pendingRetry !== false ||
    receipt.discovery.pendingEvent !== false ||
    receipt.discovery.wakeAckPending !== false ||
    receipt.discovery.wakeOutboxDrainInFlight !== false ||
    receipt.discovery.wakeOutboxDrainSucceeded !== true ||
    receipt.discovery.wakeOutboxDrainFailed !== false ||
    receipt.discovery.wakeOutboxPendingRows !== false ||
    receipt.discovery.queueIdle !== true
  ) {
    throw new Error("quiescence receipt discovery is not idle");
  }
  assertExactKeys(
    receipt.freshness,
    QUIESCENCE_FRESHNESS_KEYS,
    "quiescence receipt freshness",
  );
  if (
    !Number.isSafeInteger(receipt.freshness.cycleGeneration) ||
    receipt.freshness.cycleGeneration <= 0 ||
    receipt.freshness.inFlight !== false ||
    receipt.freshness.hasMore !== false ||
    receipt.freshness.noWrite !== true ||
    (receipt.freshness.heldProjectId !== null &&
      typeof receipt.freshness.heldProjectId !== "string") ||
    typeof receipt.freshness.cutoverNotReady !== "boolean" ||
    (receipt.freshness.heldProjectId !== null &&
      receipt.freshness.cutoverNotReady !== true) ||
    (receipt.freshness.heldProjectId === null &&
      receipt.freshness.cutoverNotReady === true) ||
    receipt.freshness.wakePending !== false ||
    typeof receipt.freshness.timerScheduled !== "boolean" ||
    (receipt.freshness.nextCycleGuardStateDigest !== null &&
      typeof receipt.freshness.nextCycleGuardStateDigest !== "string") ||
    receipt.freshness.timerScheduled !==
      (receipt.freshness.nextCycleGuardStateDigest !== null)
  ) {
    throw new Error("quiescence receipt freshness is not idle");
  }
  const state = assertQuiescenceState(receipt.state);
  if (
    receipt.workspaceBinding.authorityId !== state.authorityId ||
    receipt.workspaceBinding.generation !== state.generation ||
    receipt.stateDigest !== state.stateDigest ||
    (receipt.freshness.timerScheduled &&
      receipt.freshness.nextCycleGuardStateDigest !== state.stateDigest)
  ) {
    throw new Error("quiescence receipt binding or digest mismatch");
  }
  if (
    receipt.freshness.heldProjectId !== receipt.state.heldProjectId ||
    receipt.state.freshnessHoldProjectId !== receipt.freshness.heldProjectId ||
    (receipt.freshness.heldProjectId !== null && receipt.state.marker !== null)
  ) {
    throw new Error("quiescence receipt hold evidence is inconsistent");
  }
  return receipt;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isContainedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function narrativeMaintenanceReceiptRoot(userDataDir) {
  if (
    typeof userDataDir !== "string" ||
    !path.isAbsolute(userDataDir) ||
    userDataDir.includes("\u0000")
  ) {
    throw new Error(
      "narrative maintenance receipt userDataDir must be absolute",
    );
  }
  return path.join(userDataDir, NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME);
}

async function ensureNarrativeMaintenanceReceiptRoot(userDataDir) {
  const userDataPath = userDataDir;
  try {
    const metadata = await lstat(userDataPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "product journey userDataDir must be a regular directory",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  }
  const userDataReal = await realpath(userDataPath);
  const rootPath = path.join(
    userDataReal,
    NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME,
  );
  try {
    await mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const rootMetadata = await lstat(rootPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("product journey receipt root must be a regular directory");
  }
  const rootReal = await realpath(rootPath);
  if (rootReal !== rootPath || !isContainedPath(userDataReal, rootReal)) {
    throw new Error("product journey receipt root escaped userDataDir");
  }
  return rootReal;
}

async function receiptRootEntries(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
      symlink: entry.isSymbolicLink(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function requireCleanNarrativeMaintenanceReceiptRoot(root, phase) {
  const entries = await receiptRootEntries(root);
  if (entries.length !== 0) {
    throw new Error(
      `narrative maintenance receipt root is not clean before ${phase}: ${entries
        .map((entry) => entry.name)
        .join(",")}`,
    );
  }
  return entries;
}

function receiptArtifactDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function inspectNarrativeMaintenanceReceipt(
  root,
  expected,
  phase,
  { allowMissing = true, allowTransientTemp = false } = {},
) {
  const rootReal = await realpath(root);
  const entries = await receiptRootEntries(rootReal);
  if (expected === null) {
    if (entries.length !== 0) {
      throw new Error(
        `unexpected narrative maintenance receipt artifact for ${phase}: ${entries
          .map((entry) => entry.name)
          .join(",")}`,
      );
    }
    return null;
  }
  const nonce = expected.nonce;
  if (!UUID_V4.test(nonce)) {
    throw new Error(
      `expected narrative maintenance receipt nonce is not UUIDv4`,
    );
  }
  if (entries.length === 0 && allowMissing) return null;
  if (
    entries.length !== 1 ||
    entries[0].name !== nonce ||
    !entries[0].directory ||
    entries[0].symlink
  ) {
    throw new Error(
      `narrative maintenance receipt nonce/root entries mismatch for ${phase}`,
    );
  }
  const nonceDir = path.join(rootReal, nonce);
  if (!isContainedPath(rootReal, nonceDir)) {
    throw new Error(`narrative maintenance receipt nonce escaped its root`);
  }
  const nonceMetadata = await lstat(nonceDir);
  if (!nonceMetadata.isDirectory() || nonceMetadata.isSymbolicLink()) {
    throw new Error(
      `narrative maintenance receipt nonce is not a regular directory`,
    );
  }
  const nonceReal = await realpath(nonceDir);
  if (nonceReal !== nonceDir || !isContainedPath(rootReal, nonceReal)) {
    throw new Error(`narrative maintenance receipt nonce escaped its root`);
  }
  const childEntries = await readdir(nonceReal, { withFileTypes: true });
  const launchEntry = childEntries.find(
    (entry) => entry.name === "receipt.json",
  );
  const temporaryEntries = childEntries.filter((entry) =>
    entry.name.endsWith(".tmp"),
  );
  const requestEntry = childEntries.find(
    (entry) => entry.name === NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
  );
  const quiescenceEntries = childEntries.filter((entry) =>
    /^quiescence-\d{10}\.json$/u.test(entry.name),
  );
  const allowedEntries = new Set([
    "receipt.json",
    NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
    ...quiescenceEntries.map((entry) => entry.name),
    ...temporaryEntries.map((entry) => entry.name),
  ]);
  if (childEntries.some((entry) => !allowedEntries.has(entry.name))) {
    throw new Error(
      `narrative maintenance receipt nonce has unexpected entries for ${phase}`,
    );
  }
  for (const entry of childEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `narrative maintenance receipt nonce contains a non-regular entry for ${phase}`,
      );
    }
  }
  if (temporaryEntries.length > 0) {
    const expectedQuiescenceTemp = `quiescence-${String(
      quiescenceEntries.length + 1,
    ).padStart(10, "0")}.json.tmp`;
    const currentQuiescenceTemp =
      temporaryEntries.length === 1 &&
      temporaryEntries[0].name === expectedQuiescenceTemp;
    const currentLaunchTemp =
      temporaryEntries.length === 1 &&
      temporaryEntries[0].name === "receipt.tmp";
    const transientTempAllowed =
      (allowMissing && (currentQuiescenceTemp || currentLaunchTemp)) ||
      (allowTransientTemp && currentQuiescenceTemp);
    if (
      temporaryEntries.length > 1 ||
      temporaryEntries.some(
        (entry) =>
          entry.name !== "receipt.tmp" && entry.name !== expectedQuiescenceTemp,
      ) ||
      !transientTempAllowed
    ) {
      throw new Error(
        `narrative maintenance receipt nonce contains a partial artifact for ${phase}`,
      );
    }
    // Both launch and quiescence writers expose one bounded temp file only
    // while an atomic rename is pending. Treat it as transient during the
    // normal polling window; the deadline path reports a stuck partial.
    return null;
  }
  if (!launchEntry) {
    if (quiescenceEntries.length > 0) {
      throw new Error(
        `quiescence artifacts appeared before the launch receipt for ${phase}`,
      );
    }
    // receipt.tmp is intentionally tolerated while the atomic launch writer
    // is still open; a stuck partial artifact fails at the bounded deadline.
    return null;
  }
  let request = null;
  if (requestEntry) {
    const requestPath = path.join(
      nonceReal,
      NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
    );
    const requestMetadata = await lstat(requestPath);
    if (
      !requestMetadata.isFile() ||
      requestMetadata.isSymbolicLink() ||
      requestMetadata.size > NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES
    ) {
      throw new Error(`quiescence request is not a bounded regular file`);
    }
    const requestBytes = await readFile(requestPath);
    if (
      requestBytes.byteLength >
      NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES
    ) {
      throw new Error(`quiescence request exceeds its byte bound`);
    }
    const requestText = requestBytes.toString("utf8");
    try {
      request = JSON.parse(requestText);
    } catch (error) {
      throw new Error(`quiescence request is not JSON`, { cause: error });
    }
    assertNarrativeMaintenanceCiQuiescenceRequest(request, expected.nonce);
    if (canonicalJson(request) !== requestText) {
      throw new Error(`quiescence request is not canonical JSON`);
    }
  }
  const receiptPath = path.join(nonceReal, "receipt.json");
  const receiptMetadata = await lstat(receiptPath);
  if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()) {
    throw new Error(`narrative maintenance receipt is not a regular file`);
  }
  if (receiptMetadata.size > NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES) {
    throw new Error(`narrative maintenance receipt exceeds its byte bound`);
  }
  const bytes = await readFile(receiptPath);
  if (bytes.byteLength > NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES) {
    throw new Error(`narrative maintenance receipt exceeds its byte bound`);
  }
  const text = bytes.toString("utf8");
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (error) {
    throw new Error(`narrative maintenance receipt is not JSON`, {
      cause: error,
    });
  }
  assertNarrativeMaintenanceCiReceipt(receipt, expected);
  if (canonicalJson(receipt) !== text) {
    throw new Error(`narrative maintenance receipt is not canonical JSON`);
  }

  const sortedQuiescenceEntries = [...quiescenceEntries].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (sortedQuiescenceEntries.length > 0 && request === null) {
    throw new Error(`quiescence receipt request is missing for ${phase}`);
  }
  const quiescenceArtifacts = [];
  for (const [index, entry] of sortedQuiescenceEntries.entries()) {
    const expectedName = `quiescence-${String(index + 1).padStart(10, "0")}.json`;
    if (entry.name !== expectedName) {
      throw new Error(
        `quiescence receipt sequence is not contiguous for ${phase}`,
      );
    }
    const artifactPath = path.join(nonceReal, entry.name);
    const metadata = await lstat(artifactPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES
    ) {
      throw new Error(`quiescence receipt is not a bounded regular file`);
    }
    const artifactBytes = await readFile(artifactPath);
    if (artifactBytes.byteLength > NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES) {
      throw new Error(`quiescence receipt exceeds its byte bound`);
    }
    const artifactText = artifactBytes.toString("utf8");
    let quiescence;
    try {
      quiescence = JSON.parse(artifactText);
    } catch (error) {
      throw new Error(`quiescence receipt is not JSON`, { cause: error });
    }
    assertNarrativeMaintenanceCiQuiescenceReceipt(
      quiescence,
      expected.nonce,
      index + 1,
    );
    if (canonicalJson(quiescence) !== artifactText) {
      throw new Error(`quiescence receipt is not canonical JSON`);
    }
    quiescenceArtifacts.push({
      receipt: quiescence,
      path: artifactPath,
      realPath: await realpath(artifactPath),
      sha256: receiptArtifactDigest(artifactBytes),
      byteLength: artifactBytes.byteLength,
    });
  }
  const latestQuiescence =
    quiescenceArtifacts[quiescenceArtifacts.length - 1] ?? null;
  if (
    latestQuiescence &&
    (request === null ||
      latestQuiescence.receipt.requestNonce !== request.requestNonce ||
      latestQuiescence.receipt.phase !== request.phase ||
      latestQuiescence.receipt.requestedAt !== request.requestedAt)
  ) {
    // Historical immutable sequences may belong to an earlier request. The
    // await API, which owns the current request, rejects them until a fresh
    // sequence echoes the current caller nonce/phase.
    if (request === null) {
      throw new Error(`quiescence receipt request is missing for ${phase}`);
    }
  }
  return {
    receipt,
    path: receiptPath,
    realPath: await realpath(receiptPath),
    sha256: receiptArtifactDigest(bytes),
    byteLength: bytes.byteLength,
    quiescenceArtifacts,
    request,
    quiescenceArtifact: latestQuiescence,
  };
}

/**
 * Read the latest immutable main-owned quiescence sequence without waiting
 * for a new one. Callers still supply the launch ACK expectation, so this
 * helper cannot accidentally read a stale nonce or a production artifact.
 */
export async function readNarrativeMaintenanceCiQuiescence(
  root,
  expected,
  phase,
  {
    previousSequence = null,
    requestNonce = null,
    authorityId = null,
    generation = null,
  } = {},
) {
  if (expected === null) {
    throw new Error(
      `cannot read a CI quiescence receipt during production phase ${phase}`,
    );
  }
  if (
    !Number.isSafeInteger(previousSequence) ||
    previousSequence < 0 ||
    typeof requestNonce !== "string" ||
    !UUID_V4.test(requestNonce) ||
    typeof authorityId !== "string" ||
    authorityId.length === 0 ||
    authorityId.trim() !== authorityId ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new Error(
      "quiescence read requires previousSequence, request nonce, and expected authority binding",
    );
  }
  const artifact = await inspectNarrativeMaintenanceReceipt(
    root,
    expected,
    phase,
    { allowMissing: false },
  );
  const latest = artifact?.quiescenceArtifact ?? null;
  if (!latest) {
    throw new Error(`quiescence read found no immutable sequence for ${phase}`);
  }
  if (latest.receipt.sequence <= previousSequence) {
    throw new Error(
      `quiescence read sequence ${latest.receipt.sequence} is not newer than ${previousSequence}`,
    );
  }
  if (
    latest.receipt.requestNonce !== requestNonce ||
    latest.receipt.phase !== phase ||
    !artifact.request ||
    latest.receipt.requestedAt !== artifact.request.requestedAt ||
    latest.receipt.workspaceBinding.authorityId !== authorityId ||
    latest.receipt.workspaceBinding.generation !== generation
  ) {
    throw new Error(
      `quiescence read rejected stale request or authority binding for ${phase}`,
    );
  }
  return latest;
}

async function awaitNarrativeMaintenanceReceipt(state, phase) {
  const deadline = Date.now() + state.launchTimeoutMs;
  let sawPartial = false;
  for (;;) {
    const artifact = await inspectNarrativeMaintenanceReceipt(
      state.root,
      state.expected,
      phase,
    );
    if (artifact) {
      state.artifact = artifact;
      state.quiescenceArtifacts = artifact.quiescenceArtifacts;
      state.quiescenceArtifact = artifact.quiescenceArtifact;
      state.receiptCount = 1;
      return artifact;
    }
    if (state.expected === null) {
      state.receiptCount = 0;
      return null;
    }
    try {
      const nonceDir = path.join(state.root, state.expected.nonce);
      const children = await readdir(nonceDir);
      sawPartial ||= children.some((name) => name.endsWith(".tmp"));
    } catch {
      // The writer may not have created the nonce directory yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `missing${sawPartial ? " or partial" : ""} narrative maintenance receipt for ${phase}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function reverifyNarrativeMaintenanceReceipt(state, phase) {
  const artifact = await inspectNarrativeMaintenanceReceipt(
    state.root,
    state.expected,
    phase,
    { allowMissing: false },
  );
  if (state.expected === null) return null;
  if (!artifact || artifact.sha256 !== state.artifact?.sha256) {
    throw new Error(
      `narrative maintenance receipt changed or disappeared for ${phase}`,
    );
  }
  state.quiescenceArtifacts = artifact.quiescenceArtifacts;
  state.quiescenceArtifact = artifact.quiescenceArtifact;
  return artifact;
}

async function writeNarrativeMaintenanceQuiescenceRequest(
  state,
  { requestNonce, phase },
) {
  if (state.expected === null) {
    throw new Error(
      "cannot write a quiescence request for a production launch",
    );
  }
  if (!UUID_V4.test(requestNonce)) {
    throw new Error("quiescence request nonce must be a UUIDv4");
  }
  if (
    typeof phase !== "string" ||
    phase.length === 0 ||
    phase.length > 256 ||
    phase.trim() !== phase ||
    phase.includes("\u0000")
  ) {
    throw new Error("quiescence request phase is invalid");
  }
  const request = {
    version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
    type: NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE,
    nonce: state.expected.nonce,
    requestNonce,
    phase,
    requestedAt: new Date().toISOString(),
  };
  assertNarrativeMaintenanceCiQuiescenceRequest(request, state.expected.nonce);
  const nonceDir = path.join(state.root, state.expected.nonce);
  const requestPath = path.join(
    nonceDir,
    NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
  );
  const temporaryPath = `${requestPath}.tmp`;
  const encoded = canonicalJson(request);
  if (
    Buffer.byteLength(encoded, "utf8") >
    NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES
  ) {
    throw new Error("quiescence request exceeds its byte bound");
  }
  let nonceMetadata;
  try {
    nonceMetadata = await lstat(nonceDir);
  } catch (error) {
    throw new Error("quiescence request nonce directory is missing", {
      cause: error,
    });
  }
  if (!nonceMetadata.isDirectory() || nonceMetadata.isSymbolicLink()) {
    throw new Error("quiescence request nonce directory is not regular");
  }
  const nonceReal = await realpath(nonceDir);
  const rootReal = await realpath(state.root);
  if (nonceReal !== nonceDir || !isContainedPath(rootReal, nonceReal)) {
    throw new Error("quiescence request nonce directory escaped its root");
  }
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, requestPath);
  return request;
}

async function awaitNarrativeMaintenanceQuiescence(
  state,
  phase,
  { previousSequence = null, requestNonce, authorityId, generation } = {},
) {
  if (state.expected === null) {
    throw new Error(
      `cannot await a CI quiescence receipt during production phase ${phase}`,
    );
  }
  if (typeof requestNonce !== "string") {
    throw new Error(
      "quiescence wait requires a caller-generated request nonce",
    );
  }
  if (
    !Number.isSafeInteger(previousSequence) ||
    previousSequence < 0 ||
    typeof authorityId !== "string" ||
    authorityId.length === 0 ||
    authorityId.trim() !== authorityId ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new Error(
      "quiescence wait requires previousSequence and expected authority binding",
    );
  }
  if (state.quiescenceBinding) {
    if (
      state.quiescenceBinding.authorityId !== authorityId ||
      state.quiescenceBinding.generation !== generation
    ) {
      throw new Error(
        "quiescence wait rejected an authority/generation swap within one launch",
      );
    }
  }
  state.quiescenceBinding = { authorityId, generation };
  // Bind the request to the immutable launch ACK before writing it. This
  // prevents a stale/partially replaced launch from accepting a fresh barrier
  // request under the wrong seam nonce.
  await reverifyNarrativeMaintenanceReceipt(state, `${phase}/before-request`);
  const request = await writeNarrativeMaintenanceQuiescenceRequest(state, {
    requestNonce,
    phase,
  });
  const deadline = Date.now() + state.launchTimeoutMs;
  let sawPartial = false;
  for (;;) {
    const artifact = await inspectNarrativeMaintenanceReceipt(
      state.root,
      state.expected,
      phase,
      { allowMissing: false, allowTransientTemp: true },
    );
    const latest = artifact?.quiescenceArtifact ?? null;
    if (
      latest &&
      latest.receipt.sequence > previousSequence &&
      latest.receipt.requestNonce === request.requestNonce &&
      latest.receipt.phase === request.phase &&
      latest.receipt.requestedAt === request.requestedAt &&
      latest.receipt.workspaceBinding.authorityId === authorityId &&
      latest.receipt.workspaceBinding.generation === generation
    ) {
      state.quiescenceArtifacts = artifact.quiescenceArtifacts;
      state.quiescenceArtifact = latest;
      return latest;
    }
    // Inspect the nonce directory before the deadline decision as well.  A
    // writer that fsyncs the final bytes just after the last polling turn may
    // leave its current `.tmp` visible at the deadline; retain that fact in
    // the error instead of collapsing a stuck writer into an undifferentiated
    // missing receipt.
    try {
      const nonceDir = path.join(state.root, state.expected.nonce);
      const children = await readdir(nonceDir);
      sawPartial ||= children.some((name) => name.endsWith(".tmp"));
    } catch {
      // The writer may not have created the nonce directory yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `missing${sawPartial ? " or partial/stuck" : ""} fresh narrative maintenance quiescence receipt after sequence ${previousSequence} for ${phase}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function consumeNarrativeMaintenanceReceipt(state, phase) {
  await reverifyNarrativeMaintenanceReceipt(state, phase);
  if (state.expected === null) return;
  const nonceDir = path.join(state.root, state.expected.nonce);
  const children = await readdir(nonceDir, { withFileTypes: true });
  for (const child of children) {
    if (!child.isFile() || child.isSymbolicLink()) {
      throw new Error(
        `cannot consume non-regular narrative receipt entry ${child.name}`,
      );
    }
    await rm(path.join(nonceDir, child.name), { force: false });
  }
  await rmdir(nonceDir);
  await requireCleanNarrativeMaintenanceReceiptRoot(state.root, phase);
}

function fixtureOperationDigest(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function sqliteText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteNullableText(value) {
  return value === null ? "NULL" : sqliteText(value);
}

function requireFixtureText(value, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "") ||
    value.includes("\u0000")
  ) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires ${label} text`,
    );
  }
  return value;
}

function requireFixtureNullableText(value, label) {
  if (value !== null) requireFixtureText(value, label);
  return value;
}

function requireExactFixtureOperationKeys(operation, expected, index) {
  const actual = Object.keys(operation ?? {}).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects extra or missing fields at operation ${index}`,
    );
  }
}

function normalizeFixtureOperation(operation, index) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(
      `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires typed operation objects at ${index}`,
    );
  }
  switch (operation.kind) {
    case "app-settings-upsert":
      requireExactFixtureOperationKeys(
        operation,
        ["kind", "key", "value"],
        index,
      );
      return {
        kind: operation.kind,
        key: requireFixtureText(operation.key, `app setting key at ${index}`),
        value: requireFixtureText(
          operation.value,
          `app setting value at ${index}`,
          {
            allowEmpty: true,
          },
        ),
      };
    case "project-settings-upsert":
      requireExactFixtureOperationKeys(
        operation,
        ["kind", "projectId", "key", "value"],
        index,
      );
      return {
        kind: operation.kind,
        projectId: requireFixtureText(
          operation.projectId,
          `project ID at ${index}`,
        ),
        key: requireFixtureText(
          operation.key,
          `project setting key at ${index}`,
        ),
        value: requireFixtureText(
          operation.value,
          `project setting value at ${index}`,
          {
            allowEmpty: true,
          },
        ),
      };
    case "content-version-insert":
      requireExactFixtureOperationKeys(
        operation,
        ["kind", "id", "entityId", "content", "createdAt"],
        index,
      );
      return {
        kind: operation.kind,
        id: requireFixtureText(operation.id, `content version ID at ${index}`),
        entityId: requireFixtureText(
          operation.entityId,
          `content version entity ID at ${index}`,
        ),
        content: requireFixtureText(
          operation.content,
          `content version content at ${index}`,
          {
            allowEmpty: true,
          },
        ),
        createdAt: requireFixtureText(
          operation.createdAt,
          `content version createdAt at ${index}`,
        ),
      };
    case "dependency-edge-insert":
      requireExactFixtureOperationKeys(
        operation,
        [
          "kind",
          "id",
          "projectId",
          "consumerKind",
          "consumerKey",
          "sourceObjectIdentity",
          "readSetJson",
          "generatedByTransactionId",
          "createdAt",
          "owningRunId",
        ],
        index,
      );
      if (operation.consumerKind !== "narrative-extraction-run") {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} only permits narrative-extraction-run dependency edges`,
        );
      }
      if (operation.generatedByTransactionId !== null) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} dependency fixture edges require a null generated transaction ID`,
        );
      }
      let readSet;
      try {
        readSet = JSON.parse(operation.readSetJson);
      } catch (error) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} dependency fixture readSetJson must be JSON`,
          { cause: error },
        );
      }
      if (
        !Array.isArray(readSet) ||
        readSet.length !== 1 ||
        typeof readSet[0] !== "string" ||
        readSet[0].trim() === "" ||
        JSON.stringify(readSet) !== operation.readSetJson
      ) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} dependency fixture readSetJson must be a canonical one-token array`,
        );
      }
      if (operation.consumerKey !== operation.owningRunId) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} dependency fixture consumer and owner IDs must match`,
        );
      }
      const sourceObjectIdentity = requireFixtureText(
        operation.sourceObjectIdentity,
        `dependency edge source identity at ${index}`,
      );
      if (!sourceObjectIdentity.startsWith("project:scene:")) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} dependency fixture source must be a project scene identity`,
        );
      }
      return {
        kind: operation.kind,
        id: requireFixtureText(operation.id, `dependency edge ID at ${index}`),
        projectId: requireFixtureText(
          operation.projectId,
          `dependency edge project ID at ${index}`,
        ),
        consumerKind: operation.consumerKind,
        consumerKey: requireFixtureText(
          operation.consumerKey,
          `dependency edge consumer key at ${index}`,
        ),
        sourceObjectIdentity,
        readSetJson: operation.readSetJson,
        generatedByTransactionId: null,
        createdAt: requireFixtureText(
          operation.createdAt,
          `dependency edge createdAt at ${index}`,
        ),
        owningRunId: requireFixtureText(
          operation.owningRunId,
          `dependency edge owning Run ID at ${index}`,
        ),
      };
    case "dependency-derived-state-gap-delete":
      requireExactFixtureOperationKeys(
        operation,
        ["kind", "projectId", "edgeId", "consumerKind", "consumerKey"],
        index,
      );
      if (operation.consumerKind !== "narrative-extraction-run") {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} only permits narrative-extraction-run derived-state gaps`,
        );
      }
      return {
        kind: operation.kind,
        projectId: requireFixtureText(
          operation.projectId,
          `gap project ID at ${index}`,
        ),
        edgeId: requireFixtureText(operation.edgeId, `gap edge ID at ${index}`),
        consumerKind: operation.consumerKind,
        consumerKey: requireFixtureText(
          operation.consumerKey,
          `gap consumer key at ${index}`,
        ),
      };
    default:
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects unsupported fixture operation kind '${String(operation.kind)}'`,
      );
  }
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
  "c2-zc-canonical-authority-cutover/restart-persistence",
  "c2-zc-post-marker-lifecycle/bootstrap-restore-fixture",
  "c2-zc-post-marker-lifecycle/bootstrap-restore",
  "c2-zc-post-marker-lifecycle/bootstrap-open",
  "c2-zc-post-marker-lifecycle/bootstrap-restart",
  "c2-zc-post-marker-lifecycle/bootstrap-restart-persistence",
  "c2-zc-post-marker-lifecycle/open",
  "c2-zc-post-marker-lifecycle/new-project",
  "c2-zc-post-marker-lifecycle/restart",
  ...C2ZC_RENDERER_DML_PHASE_ALLOWLIST,
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
      "c2-zc-post-marker-lifecycle/bootstrap-restore",
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
  const receiptRoot = narrativeMaintenanceReceiptRoot(userDataDir);
  const retainedRendererPath = path.join(tmpRoot, "last-renderer.png");
  const mainLog = [];
  const rendererLog = [];
  const mainDiagnostics = [];
  const rendererWarnings = [];
  const rendererErrors = [];
  const pageErrors = [];
  const pendingDiagnosticWork = new Set();
  const mainDiagnosticTrackers = new Map();
  const receiptStates = new Map();
  const authorityTimeline = [];
  const recordedLifecycleEvents = new Set();
  const ownedWorkspaces = new Set();
  let fixtureOperationsInFlight = false;
  let launchInFlight = false;
  const lastResources = {
    app: null,
    page: null,
    phase: null,
    launchId: null,
    receiptArtifact: null,
    quiescenceArtifact: null,
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

  async function readFixtureRows(databasePath, query) {
    const { stdout } = await execFile("sqlite3", [
      "-json",
      databasePath,
      query,
    ]);
    const parsed = JSON.parse(String(stdout).trim() || "[]");
    if (!Array.isArray(parsed)) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} received a non-array count response`,
      );
    }
    return parsed;
  }

  function fixtureOperationSql(operation) {
    switch (operation.kind) {
      case "app-settings-upsert":
        return `INSERT OR REPLACE INTO app_settings (key, value)
          VALUES (${sqliteText(operation.key)}, ${sqliteText(operation.value)})`;
      case "project-settings-upsert":
        return `INSERT OR REPLACE INTO project_settings (project_id, key, value)
          VALUES (${sqliteText(operation.projectId)}, ${sqliteText(operation.key)}, ${sqliteText(operation.value)})`;
      case "content-version-insert":
        return `INSERT INTO content_versions
          (id, entity_type, entity_id, content, version_number, snapshot_type, created_at)
          VALUES (${sqliteText(operation.id)}, 'scene', ${sqliteText(operation.entityId)},
            ${sqliteText(operation.content)}, 1, 'manual', ${sqliteText(operation.createdAt)})`;
      case "dependency-edge-insert":
        return `INSERT INTO narrative_dependency_edges
          (id, project_id, consumer_kind, consumer_key, source_object_identity,
           read_set_json, generated_by_transaction_id, created_at, owning_run_id)
          VALUES (${sqliteText(operation.id)}, ${sqliteText(operation.projectId)},
            ${sqliteText(operation.consumerKind)}, ${sqliteText(operation.consumerKey)},
            ${sqliteText(operation.sourceObjectIdentity)}, ${sqliteText(operation.readSetJson)},
            ${sqliteNullableText(operation.generatedByTransactionId)},
            ${sqliteText(operation.createdAt)}, ${sqliteText(operation.owningRunId)})`;
      case "dependency-derived-state-gap-delete":
        return [
          `DELETE FROM narrative_dependency_edge_states
            WHERE project_id = ${sqliteText(operation.projectId)}
              AND edge_id = ${sqliteText(operation.edgeId)}`,
          `DELETE FROM narrative_consumer_freshness
            WHERE project_id = ${sqliteText(operation.projectId)}
              AND consumer_kind = ${sqliteText(operation.consumerKind)}
              AND consumer_key = ${sqliteText(operation.consumerKey)}`,
        ].join(";\n");
      default:
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} cannot render unsupported fixture operation`,
        );
    }
  }

  function fixtureOperationCountQuery(operation) {
    switch (operation.kind) {
      case "app-settings-upsert":
        return `SELECT COUNT(*) AS rows
          FROM app_settings WHERE key = ${sqliteText(operation.key)}`;
      case "project-settings-upsert":
        return `SELECT COUNT(*) AS rows
          FROM project_settings
         WHERE project_id = ${sqliteText(operation.projectId)}
           AND key = ${sqliteText(operation.key)}`;
      case "content-version-insert":
        return `SELECT COUNT(*) AS rows
          FROM content_versions
         WHERE id = ${sqliteText(operation.id)}`;
      case "dependency-edge-insert":
        return `SELECT COUNT(*) AS rows
          FROM narrative_dependency_edges
         WHERE id = ${sqliteText(operation.id)}`;
      case "dependency-derived-state-gap-delete":
        return `SELECT
          (SELECT COUNT(*) FROM narrative_dependency_edge_states
            WHERE project_id = ${sqliteText(operation.projectId)}
              AND edge_id = ${sqliteText(operation.edgeId)}) AS edgeStateRows,
          (SELECT COUNT(*) FROM narrative_consumer_freshness
            WHERE project_id = ${sqliteText(operation.projectId)}
              AND consumer_kind = ${sqliteText(operation.consumerKind)}
              AND consumer_key = ${sqliteText(operation.consumerKey)}) AS freshnessRows`;
      default:
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} cannot count unsupported fixture operation`,
        );
    }
  }

  async function fixtureOperationCounts(databasePath, operation) {
    const row =
      (
        await readFixtureRows(
          databasePath,
          fixtureOperationCountQuery(operation),
        )
      )[0] ?? {};
    if (operation.kind === "dependency-derived-state-gap-delete") {
      return {
        edgeStateRows: Number(row.edgeStateRows ?? 0),
        freshnessRows: Number(row.freshnessRows ?? 0),
      };
    }
    return { rows: Number(row.rows ?? 0) };
  }

  async function validateFixtureOperationOwnership(
    databasePath,
    operation,
    index,
  ) {
    const ownershipRows = async (query) => readFixtureRows(databasePath, query);
    switch (operation.kind) {
      case "app-settings-upsert":
        return;
      case "project-settings-upsert": {
        const projectRows = await ownershipRows(
          `SELECT COUNT(*) AS rows FROM projects WHERE id = ${sqliteText(operation.projectId)}`,
        );
        if (Number(projectRows[0]?.rows ?? 0) !== 1) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects an unowned project ID at operation ${index}`,
          );
        }
        return;
      }
      case "content-version-insert": {
        const entityRows = await ownershipRows(
          `SELECT COUNT(*) AS rows FROM tree_nodes WHERE id = ${sqliteText(operation.entityId)}`,
        );
        if (Number(entityRows[0]?.rows ?? 0) !== 1) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects an unowned scene ID at operation ${index}`,
          );
        }
        return;
      }
      case "dependency-edge-insert": {
        const sceneId = operation.sourceObjectIdentity.slice(
          "project:scene:".length,
        );
        const rows = await ownershipRows(`
          SELECT
            (SELECT COUNT(*) FROM projects WHERE id = ${sqliteText(operation.projectId)}) AS projectRows,
            (SELECT COUNT(*) FROM narrative_extraction_runs
              WHERE id = ${sqliteText(operation.owningRunId)}
                AND project_id = ${sqliteText(operation.projectId)}) AS ownerRunRows,
            (SELECT COUNT(*) FROM tree_nodes
              WHERE id = ${sqliteText(sceneId)}
                AND project_id = ${sqliteText(operation.projectId)}) AS sceneRows,
            (SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE id = ${sqliteText(operation.id)}) AS edgeRows,
            (SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ${sqliteText(operation.projectId)}
                AND consumer_kind = ${sqliteText(operation.consumerKind)}
                AND consumer_key = ${sqliteText(operation.consumerKey)}
                AND source_object_identity = ${sqliteText(operation.sourceObjectIdentity)}) AS uniqueRows`);
        const row = rows[0] ?? {};
        if (
          Number(row.projectRows ?? 0) !== 1 ||
          Number(row.ownerRunRows ?? 0) !== 1 ||
          Number(row.sceneRows ?? 0) !== 1
        ) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects unowned dependency fixture references at operation ${index}`,
          );
        }
        if (
          Number(row.edgeRows ?? 0) !== 0 ||
          Number(row.uniqueRows ?? 0) !== 0
        ) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects duplicate dependency fixture edges at operation ${index}`,
          );
        }
        return;
      }
      case "dependency-derived-state-gap-delete": {
        const rows = await ownershipRows(`
          SELECT COUNT(*) AS rows
            FROM narrative_dependency_edges
           WHERE id = ${sqliteText(operation.edgeId)}
             AND project_id = ${sqliteText(operation.projectId)}
             AND consumer_kind = ${sqliteText(operation.consumerKind)}
             AND consumer_key = ${sqliteText(operation.consumerKey)}`);
        if (Number(rows[0]?.rows ?? 0) !== 1) {
          throw new Error(
            `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects an unowned dependency gap at operation ${index}`,
          );
        }
        return;
      }
      default:
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} rejects unsupported fixture operation at ${index}`,
        );
    }
  }

  async function executeFixtureOperations(workspace, operations) {
    if (fixtureOperationsInFlight) {
      throw new Error(
        `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} serializes fixture DML operations`,
      );
    }
    fixtureOperationsInFlight = true;
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
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error(
          `${PRODUCT_JOURNEY_FIXTURE_DML_OWNER} requires a non-empty operations[]`,
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
      const normalizedOperations = operations.map(normalizeFixtureOperation);
      for (const [index, operation] of normalizedOperations.entries()) {
        await validateFixtureOperationOwnership(databasePath, operation, index);
      }
      const beforeCounts = await Promise.all(
        normalizedOperations.map((operation) =>
          fixtureOperationCounts(databasePath, operation),
        ),
      );
      const script = [
        "PRAGMA busy_timeout = 5000;",
        "BEGIN IMMEDIATE;",
        ...normalizedOperations.map(
          (operation) => `${fixtureOperationSql(operation)};`,
        ),
        "COMMIT;",
      ].join("\n");
      await execFile("sqlite3", ["-bail", databasePath, script]);
      const afterCounts = await Promise.all(
        normalizedOperations.map((operation) =>
          fixtureOperationCounts(databasePath, operation),
        ),
      );
      return {
        operationCount: normalizedOperations.length,
        operationDigest: fixtureOperationDigest(normalizedOperations),
        operations: normalizedOperations.map((operation, index) => ({
          operation: operation,
          kind: operation.kind,
          operationDigest: fixtureOperationDigest(operation),
          beforeCounts: beforeCounts[index],
          afterCounts: afterCounts[index],
        })),
        beforeCounts,
        afterCounts,
      };
    } finally {
      fixtureOperationsInFlight = false;
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
    if (fixtureOperationsInFlight) {
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
    const launchId = `launch-${randomUUID()}`;
    recordTimeline("launch-requested", { phase, launchId });
    const env = { ...process.env };
    delete env.ELECTRON_RENDERER_URL;
    env.GRIMODEX_USER_DATA_DIR = userDataDir;
    env[PRODUCT_JOURNEY_AI_ENV] = PRODUCT_JOURNEY_AI_VERSION;
    const electronArgs =
      env.ELECTRON_DISABLE_SANDBOX === "1"
        ? ["--no-sandbox", mainCjs]
        : [mainCjs];
    const expectedReceipt = expectedNarrativeMaintenanceCiReceipt(env);
    const receiptState = {
      root: await ensureNarrativeMaintenanceReceiptRoot(userDataDir),
      expected: expectedReceipt,
      launchTimeoutMs,
      artifact: null,
      quiescenceArtifacts: [],
      quiescenceArtifact: null,
      quiescenceBinding: null,
      receiptCount: 0,
    };
    await requireCleanNarrativeMaintenanceReceiptRoot(receiptState.root, phase);
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
    lastResources.launchId = launchId;
    lastResources.receiptArtifact = null;
    lastResources.quiescenceArtifact = null;
    receiptStates.set(app, receiptState);
    const appProcess = typeof app.process === "function" ? app.process() : null;
    // stdout remains diagnostics-only.  The acceptance receipt is read from
    // the harness-owned userData-derived file root below.
    appProcess?.stdout?.on("data", (data) => {
      const line = `  [product:${phase}:main] ${String(data)}`;
      mainLog.push(line);
      process.stdout.write(line);
    });
    attachMainDiagnosticStream(app, appProcess?.stderr, phase);
    try {
      await awaitNarrativeMaintenanceReceipt(receiptState, phase);
      if (receiptState.artifact) {
        lastResources.receiptArtifact = receiptState.artifact;
        recordTimeline("main-maintenance-receipt", {
          launchId,
          ...receiptState.artifact.receipt,
          sha256: receiptState.artifact.sha256,
          byteLength: receiptState.artifact.byteLength,
        });
        if (receiptState.quiescenceArtifact) {
          lastResources.quiescenceArtifact = receiptState.quiescenceArtifact;
          recordTimeline("main-maintenance-quiescence", {
            launchId,
            ...receiptState.quiescenceArtifact.receipt,
            sha256: receiptState.quiescenceArtifact.sha256,
            byteLength: receiptState.quiescenceArtifact.byteLength,
          });
        }
      }
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
            ...(error.stack
              ? { stack: boundedDiagnosticText(error.stack) }
              : {}),
          });
        });
      });
      await page.waitForFunction(
        () => globalThis.grimodex?.shell === "electron",
        undefined,
        { timeout: launchTimeoutMs },
      );
      // Give the bridge one event-loop turn to settle, then re-read the
      // immutable file artifact.  This closes the pre-bridge acceptance
      // boundary without depending on Playwright's stdout scheduling.
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
      await reverifyNarrativeMaintenanceReceipt(
        receiptState,
        `${phase}/bridge`,
      );
      lastResources.quiescenceArtifact = receiptState.quiescenceArtifact;
      recordTimeline("renderer-bridge-ready", { launchId });
      return {
        app,
        page,
        launchId,
        receiptArtifact: receiptState.artifact,
        quiescenceArtifact: receiptState.quiescenceArtifact,
        launchReceipt: {
          launchId,
          active: receiptState.artifact !== null,
          receipt: receiptState.artifact?.receipt ?? null,
          path: receiptState.artifact?.path ?? null,
          realPath: receiptState.artifact?.realPath ?? null,
          sha256: receiptState.artifact?.sha256 ?? null,
          byteLength: receiptState.artifact?.byteLength ?? null,
        },
      };
    } catch (error) {
      throw error;
    }
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
    const receiptState = receiptStates.get(app);
    await readLifecycleTrace(page).catch(() => undefined);
    await retainRendererScreenshot(page);
    await closeApp(app, page, phase);
    if (receiptState) {
      await consumeNarrativeMaintenanceReceipt(receiptState, `${phase}/close`);
      receiptStates.delete(app);
    }
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
      lastResources.launchId = null;
      lastResources.receiptArtifact = null;
      lastResources.quiescenceArtifact = null;
    }
  }

  async function awaitQuiescence(
    app = lastResources.app,
    phaseOrOptions = lastResources.phase ?? "quiescence",
    options = {},
  ) {
    const phase =
      typeof phaseOrOptions === "string"
        ? phaseOrOptions
        : phaseOrOptions?.phase;
    const requestOptions =
      typeof phaseOrOptions === "string" ? options : phaseOrOptions;
    if (typeof phase !== "string" || phase.trim() !== phase || phase === "") {
      throw new Error("quiescence wait requires a phase");
    }
    const state = receiptStates.get(app);
    if (!state) {
      throw new Error(`no active product-journey launch for ${phase}`);
    }
    const artifact = await awaitNarrativeMaintenanceQuiescence(
      state,
      phase,
      requestOptions ?? {},
    );
    lastResources.quiescenceArtifact = artifact;
    recordTimeline("main-maintenance-quiescence", {
      ...artifact.receipt,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    });
    return artifact;
  }

  async function readQuiescence(
    app = lastResources.app,
    phaseOrOptions = lastResources.phase ?? "quiescence",
    options = {},
  ) {
    const phase =
      typeof phaseOrOptions === "string"
        ? phaseOrOptions
        : phaseOrOptions?.phase;
    const readOptions =
      typeof phaseOrOptions === "string" ? options : phaseOrOptions;
    if (typeof phase !== "string" || phase.trim() !== phase || phase === "") {
      throw new Error("quiescence read requires a phase");
    }
    const state = receiptStates.get(app);
    if (!state) {
      throw new Error(`no active product-journey launch for ${phase}`);
    }
    return readNarrativeMaintenanceCiQuiescence(
      state.root,
      state.expected,
      phase,
      readOptions ?? {},
    );
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
    receiptRoot,
    workspacePath,
    executeFixtureOperations,
    launch,
    close,
    awaitQuiescence,
    readQuiescence,
    invokeOk,
    waitUntil,
    recordTimeline,
    readLifecycleTrace,
    diagnostics,
    finalizeDiagnostics,
    dispose,
  };
}
