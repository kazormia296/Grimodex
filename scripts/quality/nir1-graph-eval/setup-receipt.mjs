// CP-4 S1f レビュー P2-1: the setup receipt, read from its file and sealed.
//
// The R5 gate (seed-pin.mjs) takes the logical → runtime map and the cold
// DB's identity from here, never from values the caller hands in: a sealed
// receipt is the object this module returned for a file it read (module
// WeakSet, deep-frozen), the same binding as admission-facts.mjs.
//
// Pure apart from reading the one file.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** The setup driver's receipt (setup-driver.mjs writes it). */
export const DEV_SETUP_RECEIPT_SCHEMA = "nir1-cp4-dev-setup/1";
/** S1i: the frozen G-case setup's receipt (frozen-setup-driver.mjs). */
export const FROZEN_SETUP_RECEIPT_SCHEMA = "nir1-cp4-frozen-setup/1";
export const SETUP_RECEIPT_SCHEMAS = Object.freeze([
  DEV_SETUP_RECEIPT_SCHEMA,
  FROZEN_SETUP_RECEIPT_SCHEMA,
]);
/** The fixture kind each schema carries (a frozen setup never uses dev's). */
const KIND_OF_SCHEMA = Object.freeze({
  [DEV_SETUP_RECEIPT_SCHEMA]: "dev",
  [FROZEN_SETUP_RECEIPT_SCHEMA]: "frozen",
});
/**
 * S1i: where a setup stopped and the status a finished setup records. `seed-pin`
 * is ① the R5 check run (the setup through the SP/1 seed pin step and its
 * SP-P2 record; the workspace is discarded); `complete` is the whole setup.
 */
export const SETUP_STATUS_BY_STOP = Object.freeze({
  complete: "setup-complete",
  "seed-pin": "setup-through-seed-pin",
});
const SHA256 = /^[0-9a-f]{64}$/u;
/**
 * Review P3 (e): the openings of one seam session a complete setup may use
 * (the first and `B_SEAL_REOPENS` = 2 reopens of frozen-setup-driver.mjs).
 */
export const SEAL_OPENINGS_MAX = 3;
/** P-5: the author session's openings (the first and 2 reopens). */
export const MAINTENANCE_OPENINGS_MAX = 3;
const INDEX_STATES = ["usable", "unusable"];

/** The complete frozen setup's fields ④⑤ read (measurement point, seal, Main). */
function completeSetupFields(value) {
  const point = value?.measurementPoint;
  return {
    measurementPoint: point
      ? {
          declared: {
            graph: point.declared?.graph ?? null,
            chronicle: point.declared?.chronicle ?? null,
          },
          probe: {
            graph: point.probe?.graph ?? null,
            chronicle: point.probe?.chronicle ?? null,
            bGeneration: point.probe?.metadata?.b?.generation ?? null,
            chronicleGeneration:
              point.probe?.metadata?.chronicle?.generation ?? null,
          },
        }
      : null,
    sealAttempts: Array.isArray(value?.sealAttempts)
      ? value.sealAttempts.map((row) => ({
          session: row?.session ?? null,
          attempt: row?.attempt ?? null,
          outcome: row?.outcome ?? null,
        }))
      : null,
    setupMainSha256: value?.setupMain?.sha256 ?? null,
    // Re-review P3 (b): a variant with a hold session records the index
    // state before its first mutation.
    hasHoldSession: Array.isArray(value?.plan?.sessions)
      ? value.plan.sessions.some((row) => row?.label === "hold")
      : false,
    preMutationIndexState: value?.preMutationIndexState
      ? {
          b: value.preMutationIndexState.metadata?.b?.generation ?? null,
          chronicle:
            value.preMutationIndexState.metadata?.chronicle?.generation ?? null,
        }
      : null,
    maintenanceAttempts: Array.isArray(value?.maintenanceAttempts)
      ? value.maintenanceAttempts.map((row) => ({
          attempt: row?.attempt ?? null,
          outcome: row?.outcome ?? null,
        }))
      : null,
  };
}

function completeSetupProblems(fields) {
  const problems = [];
  const point = fields?.measurementPoint;
  if (
    !point ||
    !INDEX_STATES.includes(point.declared.graph) ||
    !INDEX_STATES.includes(point.declared.chronicle) ||
    point.probe.graph !== point.declared.graph ||
    point.probe.chronicle !== point.declared.chronicle
  )
    problems.push("measurementPoint");
  const attempts = fields?.sealAttempts;
  const sessions = new Map();
  for (const row of attempts ?? []) {
    if (!sessions.has(row.session)) sessions.set(row.session, []);
    sessions.get(row.session).push(row);
  }
  if (
    !attempts ||
    !sessions.has("seal") ||
    [...sessions.values()].some(
      (rows) =>
        rows.length > SEAL_OPENINGS_MAX || rows.at(-1).outcome !== "sealed",
    )
  )
    problems.push("sealAttempts");
  if (!SHA256.test(fields?.setupMainSha256 ?? "")) problems.push("setupMain");
  const maintenance = fields?.maintenanceAttempts;
  if (
    !maintenance ||
    maintenance.length === 0 ||
    maintenance.length > MAINTENANCE_OPENINGS_MAX ||
    maintenance.at(-1).outcome !== "reached"
  )
    problems.push("maintenanceAttempts");
  if (fields?.hasHoldSession && !fields?.preMutationIndexState)
    problems.push("preMutationIndexState");
  return problems;
}
const LOADED = new WeakSet();

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const isMap = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((row) => typeof row === "string");

function realOrResolved(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function isLoadedSetupReceipt(value) {
  return value !== null && typeof value === "object" && LOADED.has(value);
}

/**
 * Reads one setup receipt and returns the sealed fields the R5 gate uses:
 * the receipt's path and digest, the fixture kind and (for a frozen G-case
 * setup) its case and variant, the project, the logical → runtime maps of
 * Scenes and Entities, and the cold DB's resolved path and digest.
 * `[precheck]` when the file is not a complete setup receipt.
 */
export function loadSetupReceipt({ root = process.cwd(), file }) {
  const absolute = path.resolve(root, file);
  let bytes;
  let value;
  try {
    bytes = readFileSync(absolute);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`[precheck] the setup receipt ${file} cannot be read`);
  }
  const map = value?.logicalToRuntime;
  const cold = value?.coldDatabase;
  const problems = [];
  const kind = KIND_OF_SCHEMA[value?.schemaVersion];
  if (kind === undefined) problems.push("schemaVersion");
  else if (value?.fixture?.kind !== kind) problems.push("fixture.kind");
  // A dev setup always runs to the end; a frozen one names where it stopped.
  const stopsAt = kind === "frozen" ? value?.stopsAt : "complete";
  if (!Object.hasOwn(SETUP_STATUS_BY_STOP, stopsAt ?? ""))
    problems.push("stopsAt");
  else if (value?.status !== SETUP_STATUS_BY_STOP[stopsAt])
    problems.push("status");
  if (
    kind === "frozen" &&
    !["caseId", "variantId"].every(
      (field) =>
        typeof value?.fixture?.[field] === "string" &&
        value.fixture[field].length > 0,
    )
  )
    problems.push("fixture.caseId/variantId");
  // S1j P2-4: a ① setup names the R5 check run it belongs to; a complete
  // setup (④⑤) never carries one.
  const r5CheckRunId = value?.r5CheckRun?.id;
  if (kind === "frozen" && stopsAt === "seed-pin") {
    if (typeof r5CheckRunId !== "string" || r5CheckRunId.length === 0)
      problems.push("r5CheckRun.id");
  } else if (value?.r5CheckRun !== undefined) problems.push("r5CheckRun");
  if (typeof map?.projectId !== "string" || map.projectId.length === 0)
    problems.push("logicalToRuntime.projectId");
  if (!isMap(map?.scenes)) problems.push("logicalToRuntime.scenes");
  if (!isMap(map?.entities)) problems.push("logicalToRuntime.entities");
  if (typeof cold?.path !== "string" || !SHA256.test(cold?.sha256 ?? ""))
    problems.push("coldDatabase");
  if (problems.length > 0)
    throw new Error(
      `[precheck] the setup receipt ${file} is not a complete setup receipt (${problems.join(", ")})`,
    );
  const sealed = deepFreeze({
    path: absolute,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    schemaVersion: value.schemaVersion,
    status: value.status,
    stopsAt,
    r5CheckRunId: typeof r5CheckRunId === "string" ? r5CheckRunId : null,
    fixtureKind: value.fixture.kind,
    caseId: value.fixture.caseId ?? null,
    variantId: value.fixture.variantId ?? null,
    projectId: map.projectId,
    querySceneId:
      typeof map.querySceneId === "string" ? map.querySceneId : null,
    // Review P3 (e): a complete frozen setup's measurement point, seal
    // openings and setup-only Main (S5 reads B's generation from here).
    completeSetup:
      kind === "frozen" && stopsAt === "complete"
        ? completeSetupFields(value)
        : null,
    scenes: { ...map.scenes },
    entities: { ...map.entities },
    coldDatabase: {
      path: realOrResolved(path.resolve(root, cold.path)),
      sha256: cold.sha256,
    },
  });
  LOADED.add(sealed);
  return sealed;
}

/**
 * S1i (S2 `r5CheckWorkspace`): ④ and ⑤ set up their own workspace on the S5
 * candidate; a receipt of ① (stopped at the seed pin step) is never reused.
 * `[precheck]` unless the receipt is a sealed, complete setup.
 */
export function assertCompleteSetupReceipt(sealed) {
  if (!isLoadedSetupReceipt(sealed))
    throw new Error(
      "[precheck] the setup receipt is not one loadSetupReceipt read",
    );
  if (
    sealed.stopsAt !== "complete" ||
    sealed.status !== "setup-complete" ||
    sealed.r5CheckRunId !== null
  )
    throw new Error(
      `[precheck] the setup receipt ${sealed.path} stopped at ${sealed.stopsAt} (${sealed.status}); ④ and ⑤ need a complete setup, and the R5 check run's workspace is discarded`,
    );
  if (sealed.fixtureKind === "frozen") {
    const problems = completeSetupProblems(sealed.completeSetup);
    if (problems.length > 0)
      throw new Error(
        `[precheck] the setup receipt ${sealed.path} is not a complete setup with its measurement point, seal openings, maintenance openings and setup-only Main (${problems.join(", ")})`,
      );
  }
  return sealed;
}
