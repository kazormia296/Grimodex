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
  return sealed;
}
