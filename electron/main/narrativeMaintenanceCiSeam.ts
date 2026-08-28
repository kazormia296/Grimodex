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
  lstatSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
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

export const NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE =
  "grimodex:narrative-maintenance-ci-quiescence";
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE =
  "grimodex:narrative-maintenance-ci-quiescence-request";
export const NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES = 16_384;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES = 4_096;
export const NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE =
  "quiescence-request.json";

export interface NarrativeMaintenanceCiQuiescenceWriter {
  /** Observe the post-discovery main coordinator state. */
  recordMaintenance(observation: unknown): Promise<unknown | null>;
  /** Observe the post-cycle main maintenance queue/scheduler state. */
  recordScheduler(observation: unknown): Promise<unknown | null>;
  /** Observe the post-cycle main freshness state. */
  recordFreshness(observation: unknown): Promise<unknown | null>;
  /** Install the main-only runtime recheck after scheduler construction. */
  setRuntimeStateReader(reader: NarrativeMaintenanceCiRuntimeStateReader): void;
  dispose(): void;
}

export interface NarrativeMaintenanceCiRuntimeStateReaderResult {
  /** Monotonic main-owned mutation epoch for all three state machines. */
  readonly mutationRevision: number;
  readonly maintenance: {
    readonly mutationRevision: number;
    readonly workspaceBinding: {
      readonly authorityId: string;
      readonly generation: number;
    } | null;
    readonly discoveryInFlight: boolean;
    readonly timerScheduled: boolean;
    readonly pendingRetry: boolean;
    readonly pendingEvent: boolean;
    readonly wakeAckPending: boolean;
    readonly wakeOutboxDrainInFlight?: boolean;
    readonly wakeOutboxDrainSucceeded?: boolean;
    readonly wakeOutboxDrainFailed?: boolean;
    readonly wakeOutboxPendingRows?: boolean;
  } | null;
  readonly scheduler: {
    readonly mutationRevision: number;
    readonly workspaceBinding: {
      readonly authorityId: string;
      readonly generation: number;
    } | null;
    readonly queueIdle: boolean;
    readonly inFlight: boolean;
    readonly hasMore: boolean;
    readonly timerScheduled: boolean;
  } | null;
  readonly freshness: {
    readonly mutationRevision: number;
    readonly inFlight: boolean;
    readonly hasMore: boolean;
    readonly wakePending: boolean;
    readonly timerScheduled: boolean;
    readonly nextCycleGuardStateDigest: string | null;
    readonly heldProjectId: string | null;
    readonly cutoverNotReady: boolean;
    readonly quiescenceState: unknown;
  } | null;
}

export type NarrativeMaintenanceCiRuntimeStateReader =
  () => NarrativeMaintenanceCiRuntimeStateReaderResult | null;

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
const QUIESCENCE_REQUEST_KEYS = [
  "version",
  "type",
  "nonce",
  "requestNonce",
  "phase",
  "requestedAt",
] as const;

type QuiescenceRequest = {
  readonly version: typeof NARRATIVE_MAINTENANCE_RECEIPT_VERSION;
  readonly type: typeof NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE;
  readonly nonce: string;
  readonly requestNonce: string;
  readonly phase: string;
  readonly requestedAt: string;
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
    throw new Error(`${label} has unexpected keys`);
  }
}

function exactKeysWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

async function readNarrativeMaintenanceCiQuiescenceRequest(
  nonceDir: string,
  seamNonce: string,
): Promise<QuiescenceRequest | null> {
  const requestPath = path.join(
    nonceDir,
    NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE,
  );
  let metadata;
  try {
    metadata = await lstat(requestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("quiescence request is not a regular file");
  }
  if (metadata.size > NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES) {
    throw new Error("quiescence request exceeds its byte bound");
  }
  const bytes = await readFile(requestPath);
  if (bytes.byteLength > NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_MAX_BYTES) {
    throw new Error("quiescence request exceeds its byte bound");
  }
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("quiescence request is not JSON", { cause: error });
  }
  exactKeys(value, QUIESCENCE_REQUEST_KEYS, "quiescence request");
  if (
    value.version !== NARRATIVE_MAINTENANCE_RECEIPT_VERSION ||
    value.type !== NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_TYPE ||
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
    throw new Error("quiescence request has invalid fields");
  }
  if (canonicalJson(value) !== text) {
    throw new Error("quiescence request is not canonical JSON");
  }
  return value as QuiescenceRequest;
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
    throw new Error(`${label} is invalid`);
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
    throw new Error(`${label} must be a non-negative safe integer or null`);
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
    throw new Error(`${label} must be a trimmed non-empty identifier or null`);
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
      `quiescenceState.projects[${index}]`,
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
      `quiescenceState.projects[${index}].cursor`,
    );
    requireNullableSafeInteger(
      (cursor as Record<string, unknown>).acknowledgedThrough,
      `quiescenceState.projects[${index}].cursor.acknowledgedThrough`,
    );
    requireNullableSafeInteger(
      (cursor as Record<string, unknown>).reservedThrough,
      `quiescenceState.projects[${index}].cursor.reservedThrough`,
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).activeRunId,
      `quiescenceState.projects[${index}].cursor.activeRunId`,
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).semanticEpochId,
      `quiescenceState.projects[${index}].cursor.semanticEpochId`,
    );
    requireNullableIdentifier(
      (cursor as Record<string, unknown>).lastError,
      `quiescenceState.projects[${index}].cursor.lastError`,
    );
  }
  if (value.marker !== null) {
    exactKeys(value.marker, QUIESCENCE_MARKER_KEYS, "quiescenceState.marker");
    if (
      value.marker.migrationId !== "narrative-c2-canonical-freshness-v1" ||
      value.marker.contractVersion !== 1 ||
      typeof value.marker.appliedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        value.marker.appliedAt,
      )
    ) {
      throw new Error("quiescenceState.marker is invalid");
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.stateDigest))) {
    throw new Error("quiescenceState.stateDigest is invalid");
  }
  const withoutDigest = { ...value };
  delete withoutDigest.stateDigest;
  const expectedDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(withoutDigest), "utf8")
    .digest("hex")}`;
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

function quiescenceSequenceFile(sequence: number): string {
  return `quiescence-${String(sequence).padStart(10, "0")}.json`;
}

async function writeNarrativeMaintenanceCiQuiescence(
  seam: Extract<NarrativeMaintenanceCiSeam, { active: true }>,
  userDataDir: string,
  payload: Record<string, unknown>,
  sequence: number,
  canPublish?: () => boolean,
): Promise<{
  receipt: Record<string, unknown>;
  sha256: string;
  byteLength: number;
} | null> {
  const root = await requireReceiptRoot(userDataDir);
  const nonce = requireUuidV4(seam.nonce, "quiescence receipt nonce");
  const nonceDir = path.join(root, nonce);
  if (!isContainedPath(root, nonceDir)) {
    throw new Error("quiescence receipt nonce escaped its root");
  }
  const nonceMetadata = await lstat(nonceDir);
  if (!nonceMetadata.isDirectory() || nonceMetadata.isSymbolicLink()) {
    throw new Error("quiescence receipt nonce is not a regular directory");
  }
  const nonceReal = await realpath(nonceDir);
  if (nonceReal !== nonceDir || !isContainedPath(root, nonceReal)) {
    throw new Error("quiescence receipt nonce escaped its root");
  }
  const launchReceipt = path.join(nonceDir, "receipt.json");
  const launchMetadata = await lstat(launchReceipt);
  if (!launchMetadata.isFile() || launchMetadata.isSymbolicLink()) {
    throw new Error("quiescence receipt launch ACK is missing");
  }
  const encoded = canonicalJson(payload);
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength > NARRATIVE_MAINTENANCE_QUIESCENCE_MAX_BYTES) {
    throw new Error("quiescence receipt exceeds its byte bound");
  }
  const basename = quiescenceSequenceFile(sequence);
  const temporaryPath = path.join(nonceDir, `${basename}.tmp`);
  const finalPath = path.join(nonceDir, basename);
  const existingEntries = await readdir(nonceDir, { withFileTypes: true });
  const expectedPrevious = new Set(
    Array.from({ length: sequence - 1 }, (_, index) =>
      quiescenceSequenceFile(index + 1),
    ),
  );
  for (const entry of existingEntries) {
    if (
      entry.name === "receipt.json" ||
      entry.name === NARRATIVE_MAINTENANCE_QUIESCENCE_REQUEST_FILE
    ) {
      continue;
    }
    if (
      !/^quiescence-\d{10}\.json$/u.test(entry.name) ||
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !expectedPrevious.has(entry.name)
    ) {
      throw new Error("quiescence receipt nonce has unexpected entries");
    }
    expectedPrevious.delete(entry.name);
  }
  if (expectedPrevious.size > 0) {
    throw new Error("quiescence receipt sequence is not contiguous");
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
  // The final check and rename must not yield to the main event loop. A timer,
  // native completion callback, or trigger event can otherwise change the
  // runtime state between an async recheck and publication. The caller also
  // supplies a monotonic revision guard so an ABA transition cannot be
  // mistaken for the same quiescent observation.
  let publishAllowed = true;
  try {
    publishAllowed = canPublish?.() ?? true;
  } catch {
    publishAllowed = false;
  }
  if (publishAllowed) {
    try {
      lstatSync(finalPath);
      publishAllowed = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  if (!publishAllowed) {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return null;
  }
  renameSync(temporaryPath, finalPath);
  await chmod(finalPath, 0o600);
  return {
    receipt: payload,
    sha256: `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`,
    byteLength,
  };
}

/**
 * Combine the main coordinator and freshness scheduler observations into a
 * CI-only immutable sidecar.  The writer never crosses renderer/preload/IPC;
 * a fresh sequence exists only after both main-owned state machines have
 * reached their explicit quiescent boundary for the same authority digest.
 */
export function createNarrativeMaintenanceCiQuiescenceWriter(
  seam: NarrativeMaintenanceCiSeam,
  { userDataDir }: { userDataDir: string },
): NarrativeMaintenanceCiQuiescenceWriter | null {
  if (!seam.active) return null;
  let disposed = false;
  let sequence = 0;
  let lastEmittedKey: string | null = null;
  let lastMonotonicObservedAtMs = 0;
  let latestMaintenance: {
    readonly discoveryGeneration: number;
    readonly observedAtMs: number;
    readonly workspaceBinding: QuiescenceBinding;
    readonly discoveryEmpty: true;
    readonly discoveryInFlight: false;
    readonly timerScheduled: false;
    readonly pendingRetry: false;
    readonly pendingEvent: false;
    readonly wakeAckPending: false;
    readonly wakeOutboxDrainInFlight: false;
    readonly wakeOutboxDrainSucceeded: true;
    readonly wakeOutboxDrainFailed: false;
    readonly wakeOutboxPendingRows: false;
  } | null = null;
  let latestScheduler: {
    readonly cycleGeneration: number;
    readonly observedAtMs: number;
    readonly workspaceBinding: QuiescenceBinding;
    readonly queueIdle: true;
    readonly inFlight: false;
    readonly hasMore: false;
    readonly timerScheduled: false;
  } | null = null;
  let latestFreshness: {
    readonly cycleGeneration: number;
    readonly observedAtMs: number;
    readonly inFlight: false;
    readonly hasMore: false;
    readonly noWrite: true;
    readonly heldProjectId: string | null;
    readonly cutoverNotReady: boolean;
    readonly wakePending: false;
    readonly timerScheduled: boolean;
    readonly nextCycleGuardStateDigest: string | null;
    readonly quiescenceState: QuiescenceState;
  } | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();
  let runtimeStateReader: NarrativeMaintenanceCiRuntimeStateReader | null =
    null;

  const requireObservedAtMs = (value: unknown, label: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value as number;
  };

  const runtimeIsQuiescent = (
    state: QuiescenceState,
  ): { quiescent: boolean; mutationRevision: number | null } => {
    if (!runtimeStateReader) return { quiescent: true, mutationRevision: 0 };
    const runtime = runtimeStateReader();
    const mutationRevision = runtime?.mutationRevision;
    if (
      !Number.isSafeInteger(mutationRevision) ||
      (mutationRevision as number) < 0
    ) {
      return { quiescent: false, mutationRevision: null };
    }
    if (!runtime?.maintenance || !runtime.scheduler || !runtime.freshness) {
      return { quiescent: false, mutationRevision: mutationRevision as number };
    }
    const stateBinding = requireQuiescenceBinding(
      { authorityId: state.authorityId, generation: state.generation },
      "quiescenceState workspaceBinding",
    );
    const maintenanceBinding = runtime.maintenance.workspaceBinding;
    const schedulerBinding = runtime.scheduler.workspaceBinding;
    if (
      maintenanceBinding === null ||
      schedulerBinding === null ||
      !sameQuiescenceBinding(maintenanceBinding, stateBinding) ||
      !sameQuiescenceBinding(schedulerBinding, stateBinding)
    ) {
      return { quiescent: false, mutationRevision: mutationRevision as number };
    }
    const runtimeState = runtime.freshness.quiescenceState;
    if (
      runtimeState === null ||
      typeof runtimeState !== "object" ||
      Array.isArray(runtimeState) ||
      (runtimeState as Record<string, unknown>).stateDigest !==
        state.stateDigest
    ) {
      return { quiescent: false, mutationRevision: mutationRevision as number };
    }
    const runtimeHeldProjectId = runtime.freshness.heldProjectId ?? null;
    const runtimeCutoverNotReady = runtime.freshness.cutoverNotReady ?? false;
    const runtimeWakeOutboxDrainInFlight =
      runtime.maintenance.wakeOutboxDrainInFlight ?? false;
    const runtimeWakeOutboxDrainSucceeded =
      runtime.maintenance.wakeOutboxDrainSucceeded ?? true;
    const runtimeWakeOutboxDrainFailed =
      runtime.maintenance.wakeOutboxDrainFailed ?? false;
    const runtimeWakeOutboxPendingRows =
      runtime.maintenance.wakeOutboxPendingRows ?? false;
    return {
      quiescent:
        runtime.maintenance.discoveryInFlight ===
          latestMaintenance?.discoveryInFlight &&
        runtime.maintenance.timerScheduled ===
          latestMaintenance?.timerScheduled &&
        runtime.maintenance.pendingRetry === latestMaintenance?.pendingRetry &&
        runtime.maintenance.pendingEvent === latestMaintenance?.pendingEvent &&
        runtime.maintenance.wakeAckPending ===
          latestMaintenance?.wakeAckPending &&
        runtimeWakeOutboxDrainInFlight ===
          latestMaintenance?.wakeOutboxDrainInFlight &&
        runtimeWakeOutboxDrainSucceeded ===
          latestMaintenance?.wakeOutboxDrainSucceeded &&
        runtimeWakeOutboxDrainFailed ===
          latestMaintenance?.wakeOutboxDrainFailed &&
        runtimeWakeOutboxPendingRows ===
          latestMaintenance?.wakeOutboxPendingRows &&
        runtime.scheduler.queueIdle === latestScheduler?.queueIdle &&
        runtime.scheduler.inFlight === latestScheduler?.inFlight &&
        runtime.scheduler.hasMore === latestScheduler?.hasMore &&
        runtime.scheduler.timerScheduled === latestScheduler?.timerScheduled &&
        runtime.freshness.inFlight === latestFreshness?.inFlight &&
        runtime.freshness.hasMore === latestFreshness?.hasMore &&
        runtimeHeldProjectId === latestFreshness?.heldProjectId &&
        runtimeCutoverNotReady === latestFreshness?.cutoverNotReady &&
        runtime.freshness.wakePending === latestFreshness?.wakePending &&
        runtime.freshness.timerScheduled === latestFreshness?.timerScheduled &&
        runtime.freshness.nextCycleGuardStateDigest ===
          latestFreshness?.nextCycleGuardStateDigest &&
        runtime.maintenance.discoveryInFlight === false &&
        runtime.maintenance.timerScheduled === false &&
        runtime.maintenance.pendingRetry === false &&
        runtime.maintenance.pendingEvent === false &&
        runtime.maintenance.wakeAckPending === false &&
        runtimeWakeOutboxDrainInFlight === false &&
        runtimeWakeOutboxDrainSucceeded === true &&
        runtimeWakeOutboxDrainFailed === false &&
        runtimeWakeOutboxPendingRows === false &&
        runtime.scheduler.queueIdle === true &&
        runtime.scheduler.inFlight === false &&
        runtime.scheduler.hasMore === false &&
        runtime.scheduler.timerScheduled === false &&
        runtime.freshness.inFlight === false &&
        runtime.freshness.hasMore === false &&
        runtime.freshness.wakePending === false &&
        runtime.freshness.timerScheduled ===
          (runtime.freshness.nextCycleGuardStateDigest !== null) &&
        (!runtime.freshness.timerScheduled ||
          runtime.freshness.nextCycleGuardStateDigest === state.stateDigest) &&
        runtime.freshness.quiescenceState !== null,
      mutationRevision: mutationRevision as number,
    };
  };

  const maybeEmit = async (): Promise<unknown | null> => {
    if (
      disposed ||
      !latestMaintenance ||
      !latestScheduler ||
      !latestFreshness
    ) {
      return null;
    }
    const state = latestFreshness.quiescenceState;
    const stateBinding = requireQuiescenceBinding(
      { authorityId: state.authorityId, generation: state.generation },
      "quiescenceState workspaceBinding",
    );
    if (
      !sameQuiescenceBinding(
        latestMaintenance.workspaceBinding,
        stateBinding,
      ) ||
      !sameQuiescenceBinding(latestScheduler.workspaceBinding, stateBinding)
    ) {
      return null;
    }
    if (
      state.authorityId !== stateBinding.authorityId ||
      state.generation !== stateBinding.generation ||
      latestFreshness.hasMore ||
      latestFreshness.inFlight ||
      !latestFreshness.noWrite ||
      latestFreshness.wakePending ||
      !latestMaintenance.discoveryEmpty ||
      latestMaintenance.discoveryInFlight ||
      latestMaintenance.timerScheduled ||
      latestMaintenance.pendingRetry ||
      latestMaintenance.pendingEvent ||
      latestMaintenance.wakeAckPending ||
      latestMaintenance.wakeOutboxDrainInFlight ||
      !latestMaintenance.wakeOutboxDrainSucceeded ||
      latestMaintenance.wakeOutboxDrainFailed ||
      latestMaintenance.wakeOutboxPendingRows ||
      !latestScheduler.queueIdle ||
      latestScheduler.inFlight ||
      latestScheduler.hasMore ||
      latestScheduler.timerScheduled
    ) {
      return null;
    }
    const heldProjectId = latestFreshness.heldProjectId;
    const heldCycle = heldProjectId !== null;
    if (
      latestFreshness.cutoverNotReady !== heldCycle ||
      state.freshnessHoldProjectId !== heldProjectId ||
      state.heldProjectId !== heldProjectId ||
      (heldCycle && state.marker !== null)
    ) {
      return null;
    }
    if (
      latestFreshness.timerScheduled !==
        (latestFreshness.nextCycleGuardStateDigest !== null) ||
      (latestFreshness.timerScheduled &&
        latestFreshness.nextCycleGuardStateDigest !== state.stateDigest)
    ) {
      return null;
    }
    const initialRuntime = runtimeIsQuiescent(state);
    if (!initialRuntime.quiescent || initialRuntime.mutationRevision === null) {
      return null;
    }
    const request = await readNarrativeMaintenanceCiQuiescenceRequest(
      path.join(
        await requireReceiptRoot(userDataDir),
        requireUuidV4(seam.nonce, "quiescence receipt nonce"),
      ),
      seam.nonce,
    );
    if (request === null) return null;
    const requestedAtMs = Date.parse(request.requestedAt);
    if (
      !Number.isFinite(requestedAtMs) ||
      latestMaintenance.observedAtMs < requestedAtMs ||
      latestScheduler.observedAtMs < requestedAtMs ||
      latestFreshness.observedAtMs < requestedAtMs
    ) {
      // A request is a causal barrier, not a label for an old idle state. All
      // three main-owned observations must have been produced at or after the
      // caller's request timestamp before a new immutable sequence is issued.
      return null;
    }
    const key = `${latestMaintenance.discoveryGeneration}:${latestScheduler.cycleGeneration}:${latestFreshness.cycleGeneration}:${state.stateDigest}`;
    const requestKey = `${request.requestNonce}:${request.phase}:${request.requestedAt}`;
    if (`${key}:${requestKey}` === lastEmittedKey) return null;
    const nextSequence = sequence + 1;
    const now = Math.floor(performance.now());
    lastMonotonicObservedAtMs = Math.max(now, lastMonotonicObservedAtMs + 1);
    const receipt = {
      version: NARRATIVE_MAINTENANCE_RECEIPT_VERSION,
      type: NARRATIVE_MAINTENANCE_QUIESCENCE_TYPE,
      nonce: seam.nonce,
      requestNonce: request.requestNonce,
      phase: request.phase,
      requestedAt: request.requestedAt,
      sequence: nextSequence,
      observedAt: new Date().toISOString(),
      monotonicObservedAtMs: lastMonotonicObservedAtMs,
      workspaceBinding: latestMaintenance.workspaceBinding,
      discovery: {
        discoveryGeneration: latestMaintenance.discoveryGeneration,
        empty: true,
        inFlight: false,
        timerScheduled: false,
        pendingRetry: false,
        pendingEvent: false,
        wakeAckPending: false,
        wakeOutboxDrainInFlight: false,
        wakeOutboxDrainSucceeded: true,
        wakeOutboxDrainFailed: false,
        wakeOutboxPendingRows: false,
        queueIdle: true,
      },
      freshness: {
        cycleGeneration: latestFreshness.cycleGeneration,
        inFlight: false,
        hasMore: false,
        noWrite: true,
        heldProjectId,
        cutoverNotReady: latestFreshness.cutoverNotReady,
        wakePending: false,
        timerScheduled: latestFreshness.timerScheduled,
        nextCycleGuardStateDigest: latestFreshness.nextCycleGuardStateDigest,
      },
      state,
      stateDigest: state.stateDigest,
    } satisfies Record<string, unknown>;
    const artifact = await writeNarrativeMaintenanceCiQuiescence(
      seam,
      userDataDir,
      receipt,
      nextSequence,
      () => {
        const finalRuntime = runtimeIsQuiescent(state);
        return (
          finalRuntime.quiescent &&
          finalRuntime.mutationRevision === initialRuntime.mutationRevision
        );
      },
    );
    if (artifact === null) return null;
    sequence = nextSequence;
    lastEmittedKey = `${key}:${requestKey}`;
    return artifact;
  };

  const enqueue = (
    operation: () => Promise<unknown | null>,
  ): Promise<unknown | null> => {
    writeChain = writeChain.then(operation, operation);
    return writeChain;
  };

  return {
    recordMaintenance(observation: unknown): Promise<unknown | null> {
      return enqueue(async () => {
        const previousMaintenance = latestMaintenance;
        // A malformed or non-quiescent callback must invalidate the prior
        // signal. Otherwise a later freshness callback could accidentally
        // combine a new request with stale coordinator state.
        latestMaintenance = null;
        exactKeysWithOptional(
          observation,
          [
            "discoveryGeneration",
            "observedAtMs",
            "workspaceBinding",
            "discoveryEmpty",
            "discoveryInFlight",
            "timerScheduled",
            "pendingRetry",
            "pendingEvent",
            "wakeAckPending",
          ],
          [
            "wakeOutboxDrainInFlight",
            "wakeOutboxDrainSucceeded",
            "wakeOutboxDrainFailed",
            "wakeOutboxPendingRows",
          ],
          "maintenance quiescence observation",
        );
        const record = observation as Record<string, unknown>;
        const observedAtMs = requireObservedAtMs(
          record.observedAtMs,
          "maintenance quiescence observation observedAtMs",
        );
        const binding = requireQuiescenceBinding(
          record.workspaceBinding,
          "maintenance quiescence observation workspaceBinding",
        );
        const discoveryGeneration = record.discoveryGeneration;
        const wakeOutboxKeys = [
          "wakeOutboxDrainInFlight",
          "wakeOutboxDrainSucceeded",
          "wakeOutboxDrainFailed",
          "wakeOutboxPendingRows",
        ];
        const hasWakeOutboxState = wakeOutboxKeys.some((key) =>
          Object.hasOwn(record, key),
        );
        if (
          hasWakeOutboxState &&
          wakeOutboxKeys.some((key) => !Object.hasOwn(record, key))
        ) {
          latestMaintenance = null;
          return null;
        }
        const wakeOutboxDrainInFlight = hasWakeOutboxState
          ? record.wakeOutboxDrainInFlight
          : false;
        const wakeOutboxDrainSucceeded = hasWakeOutboxState
          ? record.wakeOutboxDrainSucceeded
          : true;
        const wakeOutboxDrainFailed = hasWakeOutboxState
          ? record.wakeOutboxDrainFailed
          : false;
        const wakeOutboxPendingRows = hasWakeOutboxState
          ? record.wakeOutboxPendingRows
          : false;
        if (
          !Number.isSafeInteger(discoveryGeneration) ||
          (discoveryGeneration as number) <= 0 ||
          typeof record.discoveryEmpty !== "boolean" ||
          typeof record.discoveryInFlight !== "boolean" ||
          typeof record.timerScheduled !== "boolean" ||
          typeof record.pendingRetry !== "boolean" ||
          typeof record.pendingEvent !== "boolean" ||
          typeof record.wakeAckPending !== "boolean" ||
          typeof wakeOutboxDrainInFlight !== "boolean" ||
          typeof wakeOutboxDrainSucceeded !== "boolean" ||
          typeof wakeOutboxDrainFailed !== "boolean" ||
          typeof wakeOutboxPendingRows !== "boolean"
        ) {
          latestMaintenance = null;
          return null;
        }
        if (
          record.discoveryEmpty !== true ||
          record.discoveryInFlight !== false ||
          record.timerScheduled !== false ||
          record.pendingRetry !== false ||
          record.pendingEvent !== false ||
          record.wakeAckPending !== false ||
          wakeOutboxDrainInFlight !== false ||
          wakeOutboxDrainSucceeded !== true ||
          wakeOutboxDrainFailed !== false ||
          wakeOutboxPendingRows !== false
        ) {
          latestMaintenance = null;
          return null;
        }
        if (
          previousMaintenance &&
          (discoveryGeneration as number) <
            previousMaintenance.discoveryGeneration
        ) {
          return null;
        }
        latestMaintenance = {
          discoveryGeneration: discoveryGeneration as number,
          observedAtMs,
          workspaceBinding: binding,
          discoveryEmpty: true,
          discoveryInFlight: false,
          timerScheduled: false,
          pendingRetry: false,
          pendingEvent: false,
          wakeAckPending: false,
          wakeOutboxDrainInFlight: false,
          wakeOutboxDrainSucceeded: true,
          wakeOutboxDrainFailed: false,
          wakeOutboxPendingRows: false,
        };
        return maybeEmit();
      });
    },
    recordScheduler(observation: unknown): Promise<unknown | null> {
      return enqueue(async () => {
        const previousScheduler = latestScheduler;
        latestScheduler = null;
        exactKeys(
          observation,
          [
            "cycleGeneration",
            "observedAtMs",
            "workspaceBinding",
            "cycleAccepted",
            "queueIdle",
            "inFlight",
            "hasMore",
            "timerScheduled",
          ],
          "maintenance scheduler quiescence observation",
        );
        const record = observation as Record<string, unknown>;
        const observedAtMs = requireObservedAtMs(
          record.observedAtMs,
          "maintenance scheduler quiescence observation observedAtMs",
        );
        const binding = requireQuiescenceBinding(
          record.workspaceBinding,
          "maintenance scheduler quiescence observation workspaceBinding",
        );
        const cycleGeneration = record.cycleGeneration;
        if (
          !Number.isSafeInteger(cycleGeneration) ||
          (cycleGeneration as number) <= 0 ||
          typeof record.queueIdle !== "boolean" ||
          typeof record.inFlight !== "boolean" ||
          typeof record.hasMore !== "boolean" ||
          typeof record.timerScheduled !== "boolean" ||
          typeof record.cycleAccepted !== "boolean"
        ) {
          latestScheduler = null;
          return null;
        }
        if (
          record.cycleAccepted !== true ||
          record.queueIdle !== true ||
          record.inFlight !== false ||
          record.hasMore !== false ||
          record.timerScheduled !== false
        ) {
          latestScheduler = null;
          return null;
        }
        if (
          previousScheduler &&
          (cycleGeneration as number) < previousScheduler.cycleGeneration
        ) {
          return null;
        }
        latestScheduler = {
          cycleGeneration: cycleGeneration as number,
          observedAtMs,
          workspaceBinding: binding,
          queueIdle: true,
          inFlight: false,
          hasMore: false,
          timerScheduled: false,
        };
        return maybeEmit();
      });
    },
    recordFreshness(observation: unknown): Promise<unknown | null> {
      return enqueue(async () => {
        const previousFreshness = latestFreshness;
        latestFreshness = null;
        const rawRecord = observation as Record<string, unknown>;
        const normalizedObservation: Record<string, unknown> = {
          ...rawRecord,
          heldProjectId: rawRecord.heldProjectId ?? null,
          cutoverNotReady: rawRecord.cutoverNotReady ?? false,
        };
        exactKeys(
          normalizedObservation,
          [
            "cycleGeneration",
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
          "freshness quiescence observation",
        );
        const record = normalizedObservation;
        const observedAtMs = requireObservedAtMs(
          record.observedAtMs,
          "freshness quiescence observation observedAtMs",
        );
        const cycleGeneration = record.cycleGeneration;
        if (
          !Number.isSafeInteger(cycleGeneration) ||
          (cycleGeneration as number) <= 0 ||
          typeof record.inFlight !== "boolean" ||
          typeof record.hasMore !== "boolean" ||
          typeof record.noWrite !== "boolean" ||
          (record.heldProjectId !== null &&
            (typeof record.heldProjectId !== "string" ||
              record.heldProjectId.trim() !== record.heldProjectId ||
              record.heldProjectId.length === 0)) ||
          typeof record.cutoverNotReady !== "boolean" ||
          typeof record.wakePending !== "boolean" ||
          typeof record.timerScheduled !== "boolean" ||
          (record.nextCycleGuardStateDigest !== null &&
            typeof record.nextCycleGuardStateDigest !== "string")
        ) {
          latestFreshness = null;
          return null;
        }
        if (
          record.inFlight !== false ||
          record.hasMore !== false ||
          record.noWrite !== true ||
          record.wakePending !== false ||
          record.cutoverNotReady !== (record.heldProjectId !== null)
        ) {
          latestFreshness = null;
          return null;
        }
        const state = requireQuiescenceState(record.quiescenceState);
        if (
          state.freshnessHoldProjectId !== record.heldProjectId ||
          state.heldProjectId !== record.heldProjectId
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
        if (
          previousFreshness &&
          (cycleGeneration as number) < previousFreshness.cycleGeneration
        ) {
          return null;
        }
        latestFreshness = {
          cycleGeneration: cycleGeneration as number,
          observedAtMs,
          inFlight: false,
          hasMore: false,
          noWrite: true,
          heldProjectId: record.heldProjectId as string | null,
          cutoverNotReady: record.cutoverNotReady as boolean,
          wakePending: false,
          timerScheduled: record.timerScheduled as boolean,
          nextCycleGuardStateDigest: record.nextCycleGuardStateDigest as
            | string
            | null,
          quiescenceState: state,
        };
        return maybeEmit();
      });
    },
    dispose(): void {
      disposed = true;
      latestMaintenance = null;
      latestScheduler = null;
      latestFreshness = null;
    },
    setRuntimeStateReader(
      reader: NarrativeMaintenanceCiRuntimeStateReader,
    ): void {
      if (typeof reader !== "function") {
        throw new Error("quiescence runtime state reader must be a function");
      }
      runtimeStateReader = reader;
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
