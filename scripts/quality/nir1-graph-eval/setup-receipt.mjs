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
export const SETUP_RECEIPT_SCHEMAS = Object.freeze([DEV_SETUP_RECEIPT_SCHEMA]);
const FIXTURE_KINDS = new Set(["dev", "frozen"]);
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
  if (!SETUP_RECEIPT_SCHEMAS.includes(value?.schemaVersion))
    problems.push("schemaVersion");
  if (value?.status !== "setup-complete") problems.push("status");
  if (!FIXTURE_KINDS.has(value?.fixture?.kind)) problems.push("fixture.kind");
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
