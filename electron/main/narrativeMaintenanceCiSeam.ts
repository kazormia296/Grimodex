/**
 * Main-process-only C2-5B product-journey seam.
 *
 * The product journey runner owns the environment names and values.  This
 * module mirrors that small declaration so the Electron main bundle does not
 * import the runner (which would pull the harness into the application).
 * Renderer, preload, and IPC never see this configuration.
 */
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

export const NARRATIVE_MAINTENANCE_FAULT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT";
export const NARRATIVE_MAINTENANCE_TRIGGER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
export const NARRATIVE_MAINTENANCE_SETUP_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP";
/** Main-only restore launch seam; never forwarded to the native boundary. */
export const NARRATIVE_FRESHNESS_DISABLE_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION";
/** CI-only two-project Freshness hold; never accepted outside the seam gate. */
export const NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS_HOLD_PROJECT_ID";
/** Correlates one isolated product-journey launch with its main receipt. */
export const NARRATIVE_MAINTENANCE_NONCE_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE";
export const NARRATIVE_MAINTENANCE_RECEIPT_EVENT =
  "grimodex:narrative-maintenance-ci-receipt";
/** The receipt root is derived from Electron's already-configured userData. */
export const NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME =
  ".grimodex-product-journey-receipts";
export const NARRATIVE_MAINTENANCE_RECEIPT_VERSION = 1;
export const NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES = 4_096;
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN =
  "c2-5b-product-journey-owner-v1";

export const NARRATIVE_MAINTENANCE_FAULTS = Object.freeze([
  "transient-io",
  "contract-violation",
  "process-interruption",
] as const);
export const NARRATIVE_MAINTENANCE_TRIGGERS = Object.freeze([
  "dependency-gap",
  "foreground-workspace-wake",
  "graphContractDigest-changed",
  "ruleRegistryDigest-changed",
  "producerGenerationSetDigest-changed",
] as const);

export type NarrativeMaintenanceCiFault =
  (typeof NARRATIVE_MAINTENANCE_FAULTS)[number];
export type NarrativeMaintenanceCiTrigger =
  (typeof NARRATIVE_MAINTENANCE_TRIGGERS)[number];

export interface NarrativeMaintenanceCiConfig {
  readonly ownerToken: string;
  readonly nonce: string;
  readonly fault: NarrativeMaintenanceCiFault | null;
  readonly trigger: NarrativeMaintenanceCiTrigger | null;
  readonly setup: "disabled" | null;
  readonly freshness: "disabled" | null;
  readonly freshnessHoldProjectId: string | null;
  readonly productJourneyBarrierId: string | null;
  readonly correlation: string | null;
}

export type NarrativeMaintenanceCiSeam =
  | { readonly active: false }
  | ({ readonly active: true } & NarrativeMaintenanceCiConfig);

export interface NarrativeMaintenanceCiReceipt {
  readonly version: typeof NARRATIVE_MAINTENANCE_RECEIPT_VERSION;
  readonly type: typeof NARRATIVE_MAINTENANCE_RECEIPT_EVENT;
  readonly nonce: string;
  readonly active: true;
  readonly setup: "disabled" | null;
  readonly freshness: "disabled" | null;
  readonly fault: NarrativeMaintenanceCiFault | null;
  readonly trigger: NarrativeMaintenanceCiTrigger | null;
  readonly freshnessHoldProjectId: string | null;
  readonly isPackaged: boolean;
  readonly nativeAck: true;
}

export interface NarrativeMaintenanceCiReceiptArtifact {
  readonly receipt: NarrativeMaintenanceCiReceipt;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Distinct CI-only evidence for one completed Held Freshness callback. */
export const NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE =
  "grimodex:narrative-maintenance-ci-held-freshness";
export const NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE =
  "grimodex:narrative-maintenance-ci-held-freshness-request";
export const NARRATIVE_MAINTENANCE_HELD_FRESHNESS_MAX_BYTES = 16_384;
export const NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_MAX_BYTES = 4_096;
export const NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE =
  "held-freshness-request.json";

/** @deprecated Compatibility names; the emitted protocol is Held Freshness. */
export const NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_MAX_BYTES;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_MAX_BYTES;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE =
  NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE;

export interface NarrativeMaintenanceCiHeldFreshnessWriter {
  /**
   * Compatibility no-op. Held evidence has no maintenance/coordinator owner.
   * A null binding is ordinary invalidation and must never throw.
   */
  recordMaintenance(observation: unknown): Promise<unknown | null>;
  /** Compatibility no-op; scheduler state is not evidence for this protocol. */
  recordScheduler(observation: unknown): Promise<unknown | null>;
  /** Observe one completed periodic Freshness callback. */
  recordFreshness(observation: unknown): Promise<unknown | null>;
  /** Compatibility no-op; runtime state is not re-read by the writer. */
  setRuntimeStateReader(reader: NarrativeMaintenanceCiRuntimeStateReader): void;
  dispose(): void;
}

export interface NarrativeMaintenanceCiHeldFreshnessWriterOptions {
  readonly userDataDir: string;
  /** Test-only proof that the durable barrier was armed synchronously. */
  readonly afterRequestBarrierForTest?: () => void;
  /**
   * Test-only synchronous interposition immediately before no-replace
   * publication. Production callers never provide this hook.
   */
  readonly beforePublishForTest?: (finalPath: string) => void;
}

/** @deprecated Use NarrativeMaintenanceCiHeldFreshnessWriter. */
export type NarrativeMaintenanceCiQuiescenceWriter =
  NarrativeMaintenanceCiHeldFreshnessWriter;

/** @deprecated The held-Freshness writer no longer reads runtime state. */
export type NarrativeMaintenanceCiRuntimeStateReader = () => unknown;

/**
 * The setup marker belongs to one product-journey configure launch only. It
 * is intentionally evaluated in main, after the owner/CI gate, so an
 * ordinary launch cannot inherit the marker or disable its scheduler.
 */
export function shouldDisableNarrativeMaintenanceForLaunch(
  seam: NarrativeMaintenanceCiSeam,
): boolean {
  return seam.active && seam.setup === "disabled";
}

/**
 * Freshness is disabled only for the owner-gated restore launch. This remains
 * a main-process policy: the value is intentionally absent from the native
 * seam payload, and ordinary/fixture launches keep the scheduler enabled.
 */
export function shouldDisableNarrativeFreshnessForLaunch(
  seam: NarrativeMaintenanceCiSeam,
): boolean {
  return (
    seam.active && seam.setup === "disabled" && seam.freshness === "disabled"
  );
}

/**
 * Startup errors are fatal only for the unpackaged, exact-CI, exact-owner
 * acceptance process.  Ordinary and packaged launches retain backend
 * fail-soft behavior, including their existing explicit error envelope.
 */
export function shouldFailFastNarrativeMaintenanceCiLaunch(
  environment: Pick<NarrativeMaintenanceCiEnvironment, "isPackaged" | "env">,
): boolean {
  return (
    !environment.isPackaged &&
    environment.env.CI === "true" &&
    environment.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] ===
      NARRATIVE_MAINTENANCE_OWNER_TOKEN
  );
}

export interface NarrativeMaintenanceCiEnvironment {
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export interface NarrativeMaintenanceCiBackend {
  configureNarrativeMaintenanceCiSeam?(
    payload: NarrativeMaintenanceCiNativePayload,
  ): Promise<unknown> | unknown;
}

/** Wire shape kept private to the main/N-API boundary. */
export interface NarrativeMaintenanceCiNativePayload {
  readonly isPackaged: boolean;
  readonly ci: string | undefined;
  readonly ownerToken: string;
  readonly fault: NarrativeMaintenanceCiFault | null;
  readonly trigger: NarrativeMaintenanceCiTrigger | null;
  readonly setup: "disabled" | null;
  readonly freshnessHoldProjectId: string | null;
  readonly productJourneyBarrierId: string | null;
  readonly correlation: string | null;
}

const hasValue = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

function enumValue<T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: T,
): T[number] | null {
  const raw = env[name];
  if (!hasValue(raw)) return null;
  if (!values.includes(raw as T[number])) {
    throw new Error(`${name} has unsupported value '${raw}'`);
  }
  return raw as T[number];
}

function optionalIdentifier(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const raw = env[name];
  if (!hasValue(raw)) return null;
  if (raw !== raw.trim()) {
    throw new Error(`${name} must be trimmed`);
  }
  if (raw.includes("\u0000")) {
    throw new Error(`${name} must not contain NUL`);
  }
  return raw;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireUuidV4(value: string, label: string): string {
  if (!UUID_V4.test(value)) {
    throw new Error(`${label} must be a UUIDv4`);
  }
  return value.toLowerCase();
}

/**
 * Parse the runner seam only after the outer activation gate is satisfied.
 * Every test-only variable is ignored—including malformed values—when the
 * launch is packaged, non-CI, or owned by another caller.
 */
export function parseNarrativeMaintenanceCiSeam(
  env: NodeJS.ProcessEnv = process.env,
  { isPackaged }: Pick<NarrativeMaintenanceCiEnvironment, "isPackaged"> = {
    isPackaged: false,
  },
): NarrativeMaintenanceCiSeam {
  const ownerToken = env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  if (
    isPackaged ||
    env.CI !== "true" ||
    ownerToken !== NARRATIVE_MAINTENANCE_OWNER_TOKEN
  ) {
    return { active: false };
  }

  const fault = enumValue(
    env,
    NARRATIVE_MAINTENANCE_FAULT_ENV,
    NARRATIVE_MAINTENANCE_FAULTS,
  );
  const trigger = enumValue(
    env,
    NARRATIVE_MAINTENANCE_TRIGGER_ENV,
    NARRATIVE_MAINTENANCE_TRIGGERS,
  );
  const setupRaw = env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  if (hasValue(setupRaw) && setupRaw !== "disabled") {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_SETUP_ENV} has unsupported value '${setupRaw}'`,
    );
  }
  const freshnessRaw = env[NARRATIVE_FRESHNESS_DISABLE_ENV];
  if (hasValue(freshnessRaw) && freshnessRaw !== "disabled") {
    throw new Error(
      `${NARRATIVE_FRESHNESS_DISABLE_ENV} has unsupported value '${freshnessRaw}'`,
    );
  }
  if (freshnessRaw === "disabled" && setupRaw !== "disabled") {
    throw new Error(
      `${NARRATIVE_FRESHNESS_DISABLE_ENV} requires ${NARRATIVE_MAINTENANCE_SETUP_ENV}=disabled`,
    );
  }
  const freshnessHoldProjectId = optionalIdentifier(
    env,
    NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
  );
  const productJourneyBarrierId = optionalIdentifier(
    env,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  );
  const correlation = optionalIdentifier(
    env,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  );
  if ((productJourneyBarrierId === null) !== (correlation === null)) {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV} and ` +
        `${NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV} must be supplied together`,
    );
  }
  const nonceValue = optionalIdentifier(env, NARRATIVE_MAINTENANCE_NONCE_ENV);
  if (nonceValue === null) {
    throw new Error(
      `${NARRATIVE_MAINTENANCE_NONCE_ENV} is required for an active seam`,
    );
  }
  const nonce = requireUuidV4(nonceValue, NARRATIVE_MAINTENANCE_NONCE_ENV);

  return {
    active: true,
    ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    nonce,
    fault,
    trigger,
    setup: setupRaw === "disabled" ? "disabled" : null,
    freshness: freshnessRaw === "disabled" ? "disabled" : null,
    freshnessHoldProjectId,
    productJourneyBarrierId,
    correlation,
  };
}

/**
 * Build the only main-process acknowledgement exposed to the product
 * journey harness. Keep this deliberately allowlisted: owner credentials and
 * filesystem values never cross the file receipt boundary.
 */
export function createNarrativeMaintenanceCiReceipt(
  seam: NarrativeMaintenanceCiSeam,
  { isPackaged }: Pick<NarrativeMaintenanceCiEnvironment, "isPackaged">,
): NarrativeMaintenanceCiReceipt | null {
  if (!seam.active) return null;
  return {
    version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
    type: NARRATIVE_MAINTENANCE_RECEIPT_EVENT,
    nonce: seam.nonce,
    active: true,
    setup: seam.setup,
    freshness: seam.freshness,
    fault: seam.fault,
    trigger: seam.trigger,
    freshnessHoldProjectId: seam.freshnessHoldProjectId,
    isPackaged,
    nativeAck: true,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptRootPath(userDataDir: string): string {
  if (!path.isAbsolute(userDataDir) || userDataDir.includes("\u0000")) {
    throw new Error(
      "narrative maintenance receipt userDataDir must be absolute",
    );
  }
  return path.join(userDataDir, NARRATIVE_MAINTENANCE_RECEIPT_ROOT_NAME);
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function requireRealDirectory(
  candidate: string,
  label: string,
): Promise<string> {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
  const resolved = await realpath(candidate);
  return resolved;
}

async function requireReceiptRoot(userDataDir: string): Promise<string> {
  const userDataReal = await requireRealDirectory(userDataDir, "userDataDir");
  const root = receiptRootPath(userDataReal);
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") throw error;
  }
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      "narrative maintenance receipt root must be a regular directory",
    );
  }
  const rootReal = await realpath(root);
  if (rootReal !== root || !isContainedPath(userDataReal, rootReal)) {
    throw new Error("narrative maintenance receipt root escaped userDataDir");
  }
  return rootReal;
}

async function requireEmptyReceiptRoot(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 0) {
    throw new Error(
      `narrative maintenance receipt root is not clean: ${entries
        .map((entry) => entry.name)
        .sort()
        .join(",")}`,
    );
  }
}

/**
 * Persist the acknowledgement after native configure has returned.  The
 * nonce directory and temporary file are both exclusive; the final rename is
 * same-directory and therefore readers observe either no receipt or one
 * complete immutable receipt, never a partial JSON document.
 */
export async function writeNarrativeMaintenanceCiReceipt(
  seam: NarrativeMaintenanceCiSeam,
  {
    isPackaged,
    userDataDir,
  }: Pick<NarrativeMaintenanceCiEnvironment, "isPackaged"> & {
    userDataDir: string;
  },
): Promise<NarrativeMaintenanceCiReceiptArtifact | null> {
  const receipt = createNarrativeMaintenanceCiReceipt(seam, { isPackaged });
  if (!receipt) return null;
  const root = await requireReceiptRoot(userDataDir);
  await requireEmptyReceiptRoot(root);
  const nonce = requireUuidV4(receipt.nonce, "receipt nonce");
  const nonceDir = path.join(root, nonce);
  if (!isContainedPath(root, nonceDir)) {
    throw new Error("narrative maintenance receipt nonce escaped its root");
  }
  try {
    await mkdir(nonceDir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("narrative maintenance receipt nonce already exists");
    }
    throw error;
  }
  try {
    const nonceMetadata = await lstat(nonceDir);
    if (!nonceMetadata.isDirectory() || nonceMetadata.isSymbolicLink()) {
      throw new Error(
        "narrative maintenance receipt nonce is not a regular directory",
      );
    }
    const nonceReal = await realpath(nonceDir);
    if (nonceReal !== nonceDir || !isContainedPath(root, nonceReal)) {
      throw new Error("narrative maintenance receipt nonce escaped its root");
    }
    const encoded = canonicalJson(receipt);
    const byteLength = Buffer.byteLength(encoded, "utf8");
    if (byteLength > NARRATIVE_MAINTENANCE_RECEIPT_MAX_BYTES) {
      throw new Error("narrative maintenance receipt exceeds its byte bound");
    }
    const temporaryPath = path.join(nonceDir, "receipt.tmp");
    const finalPath = path.join(nonceDir, "receipt.json");
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);
    return {
      receipt,
      sha256: `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`,
      byteLength,
    };
  } catch (error) {
    // Leave any temporary/partial artifact in place.  A subsequent launch
    // must fail closed on the non-clean root rather than silently erasing
    // evidence of a violated exactly-once receipt write.
    throw error;
  }
}

type QuiescenceBinding = {
  readonly authorityId: string;
  readonly generation: number;
};

type QuiescenceState = {
  readonly authorityId: string;
  readonly generation: number;
  readonly freshnessHoldProjectId: string | null;
  readonly heldProjectId: string | null;
  readonly projects: readonly unknown[];
  readonly marker: unknown;
  readonly stateDigest: string;
};

const QUIESCENCE_BINDING_KEYS = ["authorityId", "generation"] as const;
const QUIESCENCE_STATE_KEYS = [
  "authorityId",
  "generation",
  "freshnessHoldProjectId",
  "heldProjectId",
  "projects",
  "marker",
  "stateDigest",
] as const;
const QUIESCENCE_CURSOR_KEYS = [
  "acknowledgedThrough",
  "reservedThrough",
  "activeRunId",
  "semanticEpochId",
  "lastError",
] as const;
const QUIESCENCE_PROJECT_KEYS = [
  "projectId",
  "currentEpochId",
  "feedHead",
  "cursor",
] as const;
const QUIESCENCE_MARKER_KEYS = [
  "migrationId",
  "contractVersion",
  "appliedAt",
] as const;
const HELD_FRESHNESS_REQUEST_KEYS = [
  "version",
  "type",
  "nonce",
  "requestNonce",
  "phase",
  "requestedAt",
  "workspaceBinding",
] as const;

type HeldFreshnessRequest = {
  readonly version: typeof NARRATIVE_MAINTENANCE_RECEIPT_VERSION;
  readonly type: typeof NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE;
  readonly nonce: string;
  readonly requestNonce: string;
  readonly phase: string;
  readonly requestedAt: string;
  readonly workspaceBinding: QuiescenceBinding;
};

type HeldFreshnessRequestVisibility = {
  /** Bytes captured from the descriptor opened at callback invocation. */
  readonly bytes: Buffer;
  readonly contentSha256: string;
};

type HeldFreshnessFileMetadata = {
  readonly size: number;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
};

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(label + " has unexpected keys");
  }
}

function requireQuiescenceBinding(
  value: unknown,
  label: string,
): QuiescenceBinding {
  exactKeys(value, QUIESCENCE_BINDING_KEYS, label);
  const generation = value.generation;
  if (
    typeof value.authorityId !== "string" ||
    value.authorityId.trim() !== value.authorityId ||
    value.authorityId.length === 0 ||
    value.authorityId.includes("\u0000") ||
    !Number.isSafeInteger(generation) ||
    (generation as number) <= 0
  ) {
    throw new Error(label + " is invalid");
  }
  return {
    authorityId: value.authorityId,
    generation: generation as number,
  };
}

function requireNullableSafeInteger(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(label + " must be a non-negative safe integer or null");
  }
  return value as number;
}

function requireNullableIdentifier(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    throw new Error(label + " must be a trimmed non-empty identifier or null");
  }
  return value;
}

function requireQuiescenceState(value: unknown): QuiescenceState {
  exactKeys(value, QUIESCENCE_STATE_KEYS, "quiescenceState");
  requireQuiescenceBinding(
    { authorityId: value.authorityId, generation: value.generation },
    "quiescenceState workspaceBinding",
  );
  requireNullableIdentifier(
    value.freshnessHoldProjectId,
    "quiescenceState freshness hold project",
  );
  requireNullableIdentifier(
    value.heldProjectId,
    "quiescenceState held project",
  );
  if (
    value.heldProjectId !== null &&
    value.heldProjectId !== value.freshnessHoldProjectId
  ) {
    throw new Error(
      "quiescenceState held project must match the effective freshness hold",
    );
  }
  if (!Array.isArray(value.projects)) {
    throw new Error("quiescenceState.projects must be an array");
  }
  let previousProjectId = "";
  for (const [index, project] of value.projects.entries()) {
    exactKeys(
      project,
      QUIESCENCE_PROJECT_KEYS,
      "quiescenceState.projects[" + index + "]",
    );
    const projectId = project.projectId;
    const currentEpochId = project.currentEpochId;
    const feedHead = project.feedHead;
    const cursor = project.cursor;
    if (
      typeof projectId !== "string" ||
      projectId.length === 0 ||
      projectId.trim() !== projectId ||
      projectId.includes("\u0000") ||
      (previousProjectId !== "" && projectId <= previousProjectId)
    ) {
      throw new Error("quiescenceState.projects must be sorted and unique");
    }
    previousProjectId = projectId;
    if (
      currentEpochId !== null &&
      (typeof currentEpochId !== "string" ||
        currentEpochId.trim() !== currentEpochId ||
        currentEpochId.length === 0)
    ) {
      throw new Error("quiescenceState project currentEpochId is invalid");
    }
    if (!Number.isSafeInteger(feedHead) || (feedHead as number) < 0) {
      throw new Error("quiescenceState project feedHead is invalid");
    }
    exactKeys(
      cursor,
      QUIESCENCE_CURSOR_KEYS,
      "quiescenceState.projects[" + index + "].cursor",
    );
    requireNullableSafeInteger(
      (cursor as Record<string, unknown>).acknowledgedThrough,
      "quiescenceState.projects[" + index + "].cursor.acknowledgedThrough",
    );
    requireNullableSafeInteger(
      (cursor as Record<string, unknown>).reservedThrough,
      "quiescenceState.projects[" + index + "].cursor.reservedThrough",
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).activeRunId,
      "quiescenceState.projects[" + index + "].cursor.activeRunId",
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).semanticEpochId,
      "quiescenceState.projects[" + index + "].cursor.semanticEpochId",
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).lastError,
      "quiescenceState.projects[" + index + "].cursor.lastError",
    );
  }
  if (value.marker !== null) {
    exactKeys(value.marker, QUIESCENCE_MARKER_KEYS, "quiescenceState.marker");
    if (
      value.marker.migrationId !== "narrative-c2-canonical-freshness-v1" ||
      value.marker.contractVersion !== 1 ||
      typeof value.marker.appliedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
        value.marker.appliedAt,
      )
    ) {
      throw new Error("quiescenceState.marker is invalid");
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.stateDigest))) {
    throw new Error("quiescenceState.stateDigest is invalid");
  }
  const withoutDigest = { ...value };
  delete withoutDigest.stateDigest;
  const expectedDigest =
    "sha256:" +
    createHash("sha256")
      .update(canonicalJson(withoutDigest), "utf8")
      .digest("hex");
  if (expectedDigest !== value.stateDigest) {
    throw new Error("quiescenceState.stateDigest does not bind its state");
  }
  return value as QuiescenceState;
}

function sameQuiescenceBinding(
  left: QuiescenceBinding,
  right: QuiescenceBinding,
): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.generation === right.generation
  );
}

function heldFreshnessSequenceFile(sequence: number): string {
  return "held-freshness-" + String(sequence).padStart(10, "0") + ".json";
}

function parseHeldFreshnessRequest(
  snapshot: HeldFreshnessRequestVisibility,
  seamNonce: string,
): HeldFreshnessRequest {
  const text = snapshot.bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("held Freshness request is not JSON", { cause: error });
  }
  exactKeys(value, HELD_FRESHNESS_REQUEST_KEYS, "held Freshness request");
  if (
    value.version !== NARRATIVE_MAINTENANCE_RECEIPT_VERSION ||
    value.type !== NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_TYPE ||
    value.nonce !== seamNonce ||
    typeof value.nonce !== "string" ||
    !UUID_V4.test(value.nonce) ||
    typeof value.requestNonce !== "string" ||
    !UUID_V4.test(value.requestNonce) ||
    typeof value.phase !== "string" ||
    value.phase.length === 0 ||
    value.phase.length > 256 ||
    value.phase.trim() !== value.phase ||
    value.phase.includes("\u0000") ||
    typeof value.requestedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.requestedAt) ||
    !Number.isFinite(Date.parse(value.requestedAt))
  ) {
    throw new Error("held Freshness request has invalid fields");
  }
  const workspaceBinding = requireQuiescenceBinding(
    value.workspaceBinding,
    "held Freshness request workspaceBinding",
  );
  if (canonicalJson(value) !== text) {
    throw new Error("held Freshness request is not canonical JSON");
  }
  return { ...(value as HeldFreshnessRequest), workspaceBinding };
}

function noFollowReadOnlyFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0))
  );
}

function isBoundedRegularFile(metadata: HeldFreshnessFileMetadata): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    metadata.size <= NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_MAX_BYTES
  );
}

/**
 * Read exactly the byte count obtained from fstat without following a later
 * path lookup. A second descriptor/stat check rejects append/truncate races
 * that occur while this descriptor is being read.
 */
function readHeldFreshnessRequestSnapshot(
  requestPath: string,
): HeldFreshnessRequestVisibility | null {
  let descriptor: number | null = null;
  try {
    // O_NOFOLLOW is unavailable on win32.  Reject the path itself before the
    // open so a contained symlink/junction cannot redirect the descriptor to
    // an outside regular JSON file on that platform.
    const pathMetadata = lstatSync(requestPath);
    if (!isBoundedRegularFile(pathMetadata)) {
      return null;
    }
    descriptor = openSync(requestPath, noFollowReadOnlyFlags());
    const metadata = fstatSync(descriptor);
    if (
      !isBoundedRegularFile(metadata) ||
      metadata.size !== pathMetadata.size
    ) {
      return null;
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const afterRead = fstatSync(descriptor);
    if (!isBoundedRegularFile(afterRead) || afterRead.size !== metadata.size) {
      return null;
    }
    // The descriptor remains the source of truth for bytes.  This final path
    // size check only detects a replacement or resize of request.json while
    // the descriptor was being read; publication separately compares bytes.
    const afterReadPath = lstatSync(requestPath);
    if (
      !isBoundedRegularFile(afterReadPath) ||
      afterReadPath.size !== afterRead.size
    ) {
      return null;
    }
    return {
      bytes,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type HeldFreshnessRequestBarrier = {
  readonly request: HeldFreshnessRequestVisibility;
  readonly requestPublishedAtMs: number;
  readonly requestBarrierCycleGeneration: number;
};

function sameHeldFreshnessRequestContent(
  left: HeldFreshnessRequestVisibility,
  right: HeldFreshnessRequestVisibility,
): boolean {
  return (
    left.contentSha256 === right.contentSha256 && left.bytes.equals(right.bytes)
  );
}

/**
 * Establish the only accepted request publication boundary. A directory
 * fsync is intentionally strict: if the host cannot durably sync the nonce
 * directory, the callback cannot produce evidence. The timestamp is captured
 * only after fsync succeeds, and therefore is never inferred from metadata.
 */
function syncNarrativeMaintenanceDirectoryStrict(nonceDir: string): number {
  if (process.platform === "win32") {
    throw new Error(
      "strict held Freshness request directory fsync is unavailable on win32",
    );
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(nonceDir, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
    const requestPublishedAtMs = Date.now();
    closeSync(descriptor);
    descriptor = null;
    return requestPublishedAtMs;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the strict fsync failure as the cause below.
      }
    }
    throw new Error("strict held Freshness request directory fsync failed", {
      cause: error,
    });
  }
}

function syncHeldFreshnessRequestAndDirectoryStrict(
  nonceDir: string,
  snapshot: HeldFreshnessRequestVisibility,
): number {
  const requestPath = path.join(
    nonceDir,
    NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
  );
  let descriptor: number | null = null;
  try {
    const pathMetadata = lstatSync(requestPath);
    if (!isBoundedRegularFile(pathMetadata)) {
      throw new Error("held Freshness request changed before fsync");
    }
    descriptor = openSync(requestPath, noFollowReadOnlyFlags());
    const metadata = fstatSync(descriptor);
    if (
      !isBoundedRegularFile(metadata) ||
      metadata.size !== pathMetadata.size ||
      metadata.size !== snapshot.bytes.byteLength
    ) {
      throw new Error("held Freshness request changed during fsync");
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) {
        throw new Error("held Freshness request changed during fsync");
      }
      offset += bytesRead;
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      contentSha256 !== snapshot.contentSha256 ||
      !bytes.equals(snapshot.bytes)
    ) {
      throw new Error("held Freshness request changed during fsync");
    }
    fsyncSync(descriptor);
    const afterSync = fstatSync(descriptor);
    if (!isBoundedRegularFile(afterSync) || afterSync.size !== metadata.size) {
      throw new Error("held Freshness request changed after fsync");
    }
    closeSync(descriptor);
    descriptor = null;
    return syncNarrativeMaintenanceDirectoryStrict(nonceDir);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the strict fsync failure as the cause below.
      }
    }
    throw new Error("strict held Freshness request durability failed", {
      cause: error,
    });
  }
}

/**
 * Re-read the durable request immediately before publication.  The final
 * path is opened with O_NOFOLLOW and its bytes are hashed from that same
 * descriptor; an atomic replacement or in-place mutation therefore cannot
 * turn an invocation-time snapshot into a different request.
 */
function heldFreshnessRequestStillCurrent(
  nonceDir: string,
  snapshot: HeldFreshnessRequestVisibility,
): boolean {
  try {
    const directory = lstatSync(nonceDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return false;
    }
    const requestPath = path.join(
      nonceDir,
      NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
    );
    const current = readHeldFreshnessRequestSnapshot(requestPath);
    if (current === null) return false;
    return sameHeldFreshnessRequestContent(snapshot, current);
  } catch {
    return false;
  }
}

/**
 * Capture request visibility before the Freshness callback enters its async
 * queue.  A request renamed after callback invocation belongs to a later
 * cycle even if the queued operation has not reached its reader yet.  The
 * async reader still rechecks the durable request bytes below.
 */
function captureHeldFreshnessRequestVisibility(
  userDataDir: string,
  seamNonce: string,
): HeldFreshnessRequestVisibility | null {
  try {
    const nonce = requireUuidV4(seamNonce, "held Freshness receipt nonce");
    const root = receiptRootPath(userDataDir);
    const nonceDir = path.join(root, nonce);
    const requestPath = path.join(
      nonceDir,
      NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE,
    );
    if (
      !isContainedPath(root, nonceDir) ||
      !isContainedPath(nonceDir, requestPath)
    ) {
      return null;
    }
    const directory = lstatSync(nonceDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    const snapshot = readHeldFreshnessRequestSnapshot(requestPath);
    if (snapshot === null) return null;
    const afterReadDirectory = lstatSync(nonceDir);
    if (
      !afterReadDirectory.isDirectory() ||
      afterReadDirectory.isSymbolicLink()
    ) {
      return null;
    }
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
}

async function writeHeldFreshnessEvidence(
  seam: Extract<NarrativeMaintenanceCiSeam, { active: true }>,
  userDataDir: string,
  payload: Record<string, unknown>,
  sequence: number,
  requestSnapshot: HeldFreshnessRequestVisibility,
  beforePublishForTest?: (finalPath: string) => void,
): Promise<{
  receipt: Record<string, unknown>;
  sha256: string;
  byteLength: number;
} | null> {
  const root = await requireReceiptRoot(userDataDir);
  const nonce = requireUuidV4(seam.nonce, "held Freshness receipt nonce");
  const nonceDir = path.join(root, nonce);
  if (
    !isContainedPath(root, nonceDir) ||
    !isContainedPath(nonceDir, path.join(nonceDir, "receipt.json"))
  ) {
    throw new Error("held Freshness receipt nonce escaped its root");
  }
  const nonceMetadata = await lstat(nonceDir);
  if (!nonceMetadata.isDirectory() || nonceMetadata.isSymbolicLink()) {
    throw new Error("held Freshness receipt nonce is not a regular directory");
  }
  const nonceReal = await realpath(nonceDir);
  if (nonceReal !== nonceDir || !isContainedPath(root, nonceReal)) {
    throw new Error("held Freshness receipt nonce escaped its root");
  }
  const launchReceipt = path.join(nonceDir, "receipt.json");
  const launchMetadata = await lstat(launchReceipt);
  if (!launchMetadata.isFile() || launchMetadata.isSymbolicLink()) {
    throw new Error("held Freshness receipt launch ACK is missing");
  }
  const encoded = canonicalJson(payload);
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength > NARRATIVE_MAINTENANCE_HELD_FRESHNESS_MAX_BYTES) {
    throw new Error("held Freshness receipt exceeds its byte bound");
  }
  const basename = heldFreshnessSequenceFile(sequence);
  const temporaryPath = path.join(nonceDir, basename + ".tmp");
  const finalPath = path.join(nonceDir, basename);
  if (
    !isContainedPath(nonceDir, temporaryPath) ||
    !isContainedPath(nonceDir, finalPath)
  ) {
    throw new Error("held Freshness receipt path escaped its nonce directory");
  }
  const existingEntries = await readdir(nonceDir, { withFileTypes: true });
  const expectedPrevious = new Set(
    Array.from({ length: sequence - 1 }, (_, index) =>
      heldFreshnessSequenceFile(index + 1),
    ),
  );
  for (const entry of existingEntries) {
    if (
      entry.name === "receipt.json" ||
      entry.name === NARRATIVE_MAINTENANCE_HELD_FRESHNESS_REQUEST_FILE
    ) {
      continue;
    }
    if (
      !/^held-freshness-\d{10}\.json$/u.test(entry.name) ||
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !expectedPrevious.has(entry.name)
    ) {
      throw new Error("held Freshness receipt nonce has unexpected entries");
    }
    expectedPrevious.delete(entry.name);
  }
  if (expectedPrevious.size > 0) {
    throw new Error("held Freshness receipt sequence is not contiguous");
  }
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Recheck the request only after the evidence bytes are durable and
  // immediately before the no-replace publication. The recheck binds the
  // exact canonical request bytes captured at callback entry.
  if (!heldFreshnessRequestStillCurrent(nonceDir, requestSnapshot)) {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return null;
  }
  beforePublishForTest?.(finalPath);
  let published = false;
  try {
    // link(2) is the no-replace primitive: unlike lstat+rename, it cannot
    // overwrite a competitor that appears between the check and publish.
    linkSync(temporaryPath, finalPath);
    published = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  if (!published) {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    syncNarrativeMaintenanceDirectoryStrict(nonceDir);
    return null;
  }
  unlinkSync(temporaryPath);
  syncNarrativeMaintenanceDirectoryStrict(nonceDir);
  return {
    receipt: payload,
    sha256:
      "sha256:" + createHash("sha256").update(encoded, "utf8").digest("hex"),
    byteLength,
  };
}

/**
 * Compatibility export for the main bootstrap. The implementation is the
 * held-Freshness event writer; no composite maintenance barrier is exposed.
 */
export function createNarrativeMaintenanceCiHeldFreshnessWriter(
  seam: NarrativeMaintenanceCiSeam,
  options: NarrativeMaintenanceCiHeldFreshnessWriterOptions,
): NarrativeMaintenanceCiHeldFreshnessWriter | null {
  return createHeldFreshnessWriter(seam, options);
}

/** @deprecated Use createNarrativeMaintenanceCiHeldFreshnessWriter. */
export function createNarrativeMaintenanceCiQuiescenceWriter(
  seam: NarrativeMaintenanceCiSeam,
  options: NarrativeMaintenanceCiHeldFreshnessWriterOptions,
): NarrativeMaintenanceCiHeldFreshnessWriter | null {
  return createNarrativeMaintenanceCiHeldFreshnessWriter(seam, options);
}

function createHeldFreshnessWriter(
  seam: NarrativeMaintenanceCiSeam,
  {
    userDataDir,
    afterRequestBarrierForTest,
    beforePublishForTest,
  }: NarrativeMaintenanceCiHeldFreshnessWriterOptions,
): NarrativeMaintenanceCiHeldFreshnessWriter | null {
  if (!seam.active) return null;
  let disposed = false;
  let sequence = 0;
  let lastCycleGeneration = 0;
  // A request nonce identifies one caller request for the lifetime of this
  // launch.  Remember every successfully published nonce so A -> B -> A
  // cannot replay evidence merely because A was not the immediately previous
  // request.
  const seenRequestNonces = new Set<string>();
  let requestBarrier: HeldFreshnessRequestBarrier | null = null;
  let lastMonotonicObservedAtMs = 0;
  let writeChain: Promise<unknown> = Promise.resolve();

  const enqueue = (
    operation: () => Promise<unknown | null>,
  ): Promise<unknown | null> => {
    const next = writeChain.then(operation, operation);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const requireObservedAtMs = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(
        "held Freshness observedAtMs must be a non-negative safe integer",
      );
    }
    return value as number;
  };

  return {
    recordMaintenance(): Promise<unknown | null> {
      return enqueue(async () => null);
    },
    recordScheduler(): Promise<unknown | null> {
      return enqueue(async () => null);
    },
    recordFreshness(observation: unknown): Promise<unknown | null> {
      const requestVisibility = captureHeldFreshnessRequestVisibility(
        userDataDir,
        seam.nonce,
      );
      let armedBarrierForInvocation = false;

      // Arm the durability barrier before returning to the event loop. The
      // Freshness scheduler has already reserved its next timer and does not
      // await this callback; deferring fsync into the async write queue would
      // allow that next native cycle to start before the barrier exists.
      try {
        exactKeys(
          observation,
          [
            "cycleGeneration",
            "cycleStartedAtMs",
            "observedAtMs",
            "inFlight",
            "hasMore",
            "noWrite",
            "heldProjectId",
            "cutoverNotReady",
            "wakePending",
            "timerScheduled",
            "nextCycleGuardStateDigest",
            "quiescenceState",
          ],
          "held Freshness observation",
        );
        const candidateGeneration = observation.cycleGeneration;
        if (
          !disposed &&
          requestVisibility !== null &&
          Number.isSafeInteger(candidateGeneration) &&
          (candidateGeneration as number) > 0 &&
          (candidateGeneration as number) > lastCycleGeneration &&
          (requestBarrier === null ||
            !sameHeldFreshnessRequestContent(
              requestBarrier.request,
              requestVisibility,
            ))
        ) {
          requestBarrier = null;
          parseHeldFreshnessRequest(requestVisibility, seam.nonce);
          const root = receiptRootPath(userDataDir);
          const nonce = requireUuidV4(
            seam.nonce,
            "held Freshness receipt nonce",
          );
          const nonceDir = path.join(root, nonce);
          if (
            !isContainedPath(root, nonceDir) ||
            !heldFreshnessRequestStillCurrent(nonceDir, requestVisibility)
          ) {
            throw new Error(
              "held Freshness request changed before durable barrier",
            );
          }
          const requestPublishedAtMs =
            syncHeldFreshnessRequestAndDirectoryStrict(
              nonceDir,
              requestVisibility,
            );
          if (!heldFreshnessRequestStillCurrent(nonceDir, requestVisibility)) {
            throw new Error(
              "held Freshness request changed after durable barrier",
            );
          }
          requestBarrier = {
            request: requestVisibility,
            requestPublishedAtMs,
            requestBarrierCycleGeneration: candidateGeneration as number,
          };
          armedBarrierForInvocation = true;
          afterRequestBarrierForTest?.();
        }
      } catch {
        requestBarrier = null;
      }
      return enqueue(async () => {
        if (disposed) return null;
        try {
          exactKeys(
            observation,
            [
              "cycleGeneration",
              "cycleStartedAtMs",
              "observedAtMs",
              "inFlight",
              "hasMore",
              "noWrite",
              "heldProjectId",
              "cutoverNotReady",
              "wakePending",
              "timerScheduled",
              "nextCycleGuardStateDigest",
              "quiescenceState",
            ],
            "held Freshness observation",
          );
          const record = observation;
          const cycleGeneration = record.cycleGeneration as number;
          const cycleStartedAtMs = requireObservedAtMs(record.cycleStartedAtMs);
          const observedAtMs = requireObservedAtMs(record.observedAtMs);
          if (
            !Number.isSafeInteger(cycleGeneration) ||
            (cycleGeneration as number) <= 0 ||
            (cycleGeneration as number) <= lastCycleGeneration
          ) {
            return null;
          }
          lastCycleGeneration = cycleGeneration as number;
          if (
            typeof record.inFlight !== "boolean" ||
            typeof record.hasMore !== "boolean" ||
            typeof record.noWrite !== "boolean" ||
            typeof record.cutoverNotReady !== "boolean" ||
            typeof record.wakePending !== "boolean" ||
            typeof record.timerScheduled !== "boolean" ||
            (record.heldProjectId !== null &&
              (typeof record.heldProjectId !== "string" ||
                record.heldProjectId.length === 0 ||
                record.heldProjectId.trim() !== record.heldProjectId ||
                record.heldProjectId.includes("\u0000"))) ||
            (record.nextCycleGuardStateDigest !== null &&
              typeof record.nextCycleGuardStateDigest !== "string")
          ) {
            return null;
          }
          if (
            record.inFlight !== false ||
            record.hasMore !== false ||
            record.noWrite !== true ||
            record.wakePending !== false ||
            record.heldProjectId === null ||
            record.cutoverNotReady !== true
          ) {
            return null;
          }
          const state = requireQuiescenceState(record.quiescenceState);
          const heldProjectId = record.heldProjectId as string;
          if (
            state.marker !== null ||
            seam.freshnessHoldProjectId !== heldProjectId ||
            state.freshnessHoldProjectId !== heldProjectId ||
            state.heldProjectId !== heldProjectId
          ) {
            return null;
          }
          if (
            record.timerScheduled !==
              (record.nextCycleGuardStateDigest !== null) ||
            (record.timerScheduled &&
              record.nextCycleGuardStateDigest !== state.stateDigest)
          ) {
            return null;
          }
          const root = await requireReceiptRoot(userDataDir);
          const nonce = requireUuidV4(
            seam.nonce,
            "held Freshness receipt nonce",
          );
          const nonceDir = path.join(root, nonce);
          if (!isContainedPath(root, nonceDir)) return null;
          if (requestVisibility === null) {
            requestBarrier = null;
            return null;
          }
          // Parse only the immutable invocation-time bytes.  Never perform a
          // later path read for the request; the durable path is rechecked
          // immediately before publication below.
          const request = parseHeldFreshnessRequest(
            requestVisibility,
            seam.nonce,
          );
          const requestedAtMs = Date.parse(request.requestedAt);
          if (!Number.isFinite(requestedAtMs)) {
            return null;
          }
          if (armedBarrierForInvocation) {
            if (
              !heldFreshnessRequestStillCurrent(nonceDir, requestVisibility)
            ) {
              requestBarrier = null;
            }
            return null;
          }
          if (
            requestBarrier === null ||
            !sameHeldFreshnessRequestContent(
              requestBarrier.request,
              requestVisibility,
            )
          ) {
            requestBarrier = null;
            return null;
          }
          const { requestPublishedAtMs, requestBarrierCycleGeneration } =
            requestBarrier;
          if (
            cycleGeneration <= requestBarrierCycleGeneration ||
            cycleStartedAtMs <= requestPublishedAtMs ||
            cycleStartedAtMs > observedAtMs ||
            observedAtMs <= requestPublishedAtMs
          ) {
            return null;
          }
          const stateBinding = requireQuiescenceBinding(
            { authorityId: state.authorityId, generation: state.generation },
            "held Freshness state workspaceBinding",
          );
          if (!sameQuiescenceBinding(request.workspaceBinding, stateBinding)) {
            return null;
          }
          if (seenRequestNonces.has(request.requestNonce)) return null;
          const nextSequence = sequence + 1;
          const now = Math.floor(performance.now());
          lastMonotonicObservedAtMs = Math.max(
            now,
            lastMonotonicObservedAtMs + 1,
          );
          const receipt = {
            version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
            type: NARRATIVE_MAINTENANCE_HELD_FRESHNESS_TYPE,
            nonce: seam.nonce,
            requestNonce: request.requestNonce,
            phase: request.phase,
            requestedAt: request.requestedAt,
            sequence: nextSequence,
            observedAt: new Date().toISOString(),
            monotonicObservedAtMs: lastMonotonicObservedAtMs,
            workspaceBinding: request.workspaceBinding,
            freshness: {
              cycleGeneration,
              requestBarrierCycleGeneration,
              requestPublishedAtMs,
              cycleStartedAtMs,
              observedAtMs,
              inFlight: false,
              hasMore: false,
              noWrite: true,
              heldProjectId,
              cutoverNotReady: true,
              wakePending: false,
              timerScheduled: record.timerScheduled,
              nextCycleGuardStateDigest: record.nextCycleGuardStateDigest as
                | string
                | null,
            },
            state,
            stateDigest: state.stateDigest,
          } satisfies Record<string, unknown>;
          const artifact = await writeHeldFreshnessEvidence(
            seam,
            userDataDir,
            receipt,
            nextSequence,
            requestVisibility,
            beforePublishForTest,
          );
          if (artifact === null) {
            requestBarrier = null;
            return null;
          }
          sequence = nextSequence;
          seenRequestNonces.add(request.requestNonce);
          return artifact;
        } catch {
          requestBarrier = null;
          return null;
        }
      });
    },
    dispose(): void {
      disposed = true;
    },
    setRuntimeStateReader(): void {
      // Compatibility API; no runtime state reader participates in evidence.
    },
  };
}

function parseNativeStatus(raw: unknown): void {
  if (typeof raw === "string") {
    try {
      return parseNativeStatus(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("native C2-5B seam returned malformed JSON");
    }
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).status !== "enabled"
  ) {
    throw new Error("native C2-5B seam did not acknowledge enablement");
  }
}

/**
 * Validate and configure exactly once during main startup. The caller invokes
 * this immediately after `initBackend()` and before creating any scheduler.
 */
export async function configureNarrativeMaintenanceCiSeam(
  backend: NarrativeMaintenanceCiBackend | null,
  environment: NarrativeMaintenanceCiEnvironment,
): Promise<NarrativeMaintenanceCiSeam> {
  const seam = parseNarrativeMaintenanceCiSeam(environment.env, {
    isPackaged: environment.isPackaged,
  });
  if (!seam.active) return seam;
  const configure = backend?.configureNarrativeMaintenanceCiSeam;
  if (typeof configure !== "function") {
    throw new Error(
      "active C2-5B product journey requires native seam configuration",
    );
  }
  const result = await configure.call(backend, {
    isPackaged: environment.isPackaged,
    ci: environment.env.CI,
    ownerToken: seam.ownerToken,
    fault: seam.fault,
    trigger: seam.trigger,
    setup: seam.setup,
    freshnessHoldProjectId: seam.freshnessHoldProjectId,
    productJourneyBarrierId: seam.productJourneyBarrierId,
    correlation: seam.correlation,
  });
  parseNativeStatus(result);
  return seam;
}
