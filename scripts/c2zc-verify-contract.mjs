import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const POLICY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/narrative-run-kind-policy.json",
);
const RUST_VERIFY_SOURCE_PATH = path.join(
  REPO_ROOT,
  "src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs",
);

const EXPECTED_RUST_VERIFY_CONTRACT_VERSION = "9";
const EXPECTED_DURABLE_CHECK_COUNT = 8;
const EXPECTED_REBUILDABLE_CHECK_COUNT = 5;
const EXPECTED_VERIFY_CHECK_COUNT =
  EXPECTED_DURABLE_CHECK_COUNT + EXPECTED_REBUILDABLE_CHECK_COUNT;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
  } else if (isPlainObject(value)) {
    Object.values(value).forEach(freezeDeep);
  }
  return Object.freeze(value);
}

function readJson(url, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be loaded`, { cause: error });
  }
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactStringList(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} checks`);
  }
  if (
    value.some(
      (check) =>
        typeof check !== "string" ||
        check.length === 0 ||
        check.trim() !== check,
    )
  ) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== expectedLength) {
    throw new Error(`${label} must not contain duplicate checks`);
  }
  return value;
}

function sameOrderedArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function readRustStringArray(source, declaration, expectedLength, label) {
  const declarationPattern = new RegExp(
    `pub\\s+const\\s+${declaration}\\s*:\\s*\\[&str;\\s*${expectedLength}\\]\\s*=\\s*\\[([\\s\\S]*?)\\];`,
    "u",
  );
  const match = source.match(declarationPattern);
  if (!match) {
    throw new Error(`${label} must be declared in restore_rebuild.rs`);
  }
  const values = [...match[1].matchAll(/"([^"\\]*)"/gu)].map(
    ([, value]) => value,
  );
  return exactStringList(values, expectedLength, label);
}

const policy = readJson(POLICY_PATH, "narrative-run-kind-policy.json");
const dependencyVerify = policy.runKinds?.find(
  (entry) => entry?.runKind === "dependency-verify",
);
if (!isPlainObject(dependencyVerify)) {
  throw new Error(
    "narrative-run-kind-policy.json must define dependency-verify",
  );
}

const durableChecks = exactStringList(
  dependencyVerify.verifiesDurableGraph,
  EXPECTED_DURABLE_CHECK_COUNT,
  "dependency-verify.verifiesDurableGraph",
);
const rebuildableChecks = exactStringList(
  dependencyVerify.verifiesRebuildableState,
  EXPECTED_REBUILDABLE_CHECK_COUNT,
  "dependency-verify.verifiesRebuildableState",
);
const verifyChecks = [...durableChecks, ...rebuildableChecks];
if (new Set(verifyChecks).size !== EXPECTED_VERIFY_CHECK_COUNT) {
  throw new Error(
    "dependency-verify durable and rebuildable checks must be one exact 13-check catalogue",
  );
}
if (!isPlainObject(dependencyVerify.verifyCoverage)) {
  throw new Error("dependency-verify.verifyCoverage must be an object");
}
const policyCoverage = dependencyVerify.verifyCoverage;
if (
  policyCoverage.requiredCheckCount !== EXPECTED_VERIFY_CHECK_COUNT ||
  policyCoverage.productionCoverage !== "13/13" ||
  policyCoverage.reductionForbidden !== true
) {
  throw new Error(
    "dependency-verify.verifyCoverage must require 13/13 with reduction forbidden",
  );
}

const rustVerifySource = readFileSync(RUST_VERIFY_SOURCE_PATH, "utf8");
const rustVersionMatch = rustVerifySource.match(
  /pub\(crate\)\s+const\s+VERIFY_CONTRACT_VERSION:\s*&str\s*=\s*"([^"]+)";/u,
);
if (!rustVersionMatch) {
  throw new Error(
    "restore_rebuild.rs must declare VERIFY_CONTRACT_VERSION for the production Verify contract",
  );
}
if (rustVersionMatch[1] !== EXPECTED_RUST_VERIFY_CONTRACT_VERSION) {
  throw new Error(
    `restore_rebuild.rs VERIFY_CONTRACT_VERSION must remain ${EXPECTED_RUST_VERIFY_CONTRACT_VERSION}`,
  );
}
const rustCoveredChecks = readRustStringArray(
  rustVerifySource,
  "PRODUCTION_VERIFY_COVERED_CHECKS",
  EXPECTED_VERIFY_CHECK_COUNT,
  "PRODUCTION_VERIFY_COVERED_CHECKS",
);
if (!sameOrderedArray(rustCoveredChecks, verifyChecks)) {
  throw new Error(
    "PRODUCTION_VERIFY_COVERED_CHECKS must match the policy catalogue in canonical order",
  );
}

export const C2ZC_RUST_VERIFY_CONTRACT_VERSION =
  EXPECTED_RUST_VERIFY_CONTRACT_VERSION;
export const C2ZC_RUST_VERIFY_DURABLE_CHECKS = Object.freeze([
  ...durableChecks,
]);
export const C2ZC_RUST_VERIFY_REBUILDABLE_CHECKS = Object.freeze([
  ...rebuildableChecks,
]);
export const C2ZC_RUST_VERIFY_CHECKS = Object.freeze([...verifyChecks]);
export const C2ZC_RUST_VERIFY_COMPILED_CHECKS = Object.freeze([
  ...rustCoveredChecks,
]);
export const C2ZC_RUST_VERIFY_COVERAGE_COUNT = EXPECTED_VERIFY_CHECK_COUNT;
export const C2ZC_RUST_VERIFY_COVERAGE = freezeDeep({
  complete: true,
  required: [...verifyChecks],
  covered: [...verifyChecks],
  missing: [],
});

function exactObjectKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

export function assertC2ZcRustVerifyContractVersion(
  value,
  label = "C2-ZC Rust Verify outcome verifyContractVersion",
) {
  if (value !== C2ZC_RUST_VERIFY_CONTRACT_VERSION) {
    throw new Error(
      `${label} must be exactly ${C2ZC_RUST_VERIFY_CONTRACT_VERSION}`,
    );
  }
  return value;
}

export function assertC2ZcRustVerifyCoverage(
  value,
  label = "C2-ZC Rust Verify checkCoverage",
) {
  exactObjectKeys(value, ["complete", "required", "covered", "missing"], label);
  if (
    value.complete !== true ||
    !Array.isArray(value.required) ||
    !Array.isArray(value.covered) ||
    !Array.isArray(value.missing)
  ) {
    throw new Error(`${label} must be complete with arrays`);
  }
  exactStringList(
    value.required,
    C2ZC_RUST_VERIFY_COVERAGE_COUNT,
    `${label} required`,
  );
  exactStringList(
    value.covered,
    C2ZC_RUST_VERIFY_COVERAGE_COUNT,
    `${label} covered`,
  );
  if (value.missing.length !== 0) {
    throw new Error(`${label} missing must be empty`);
  }
  if (!sameOrderedArray(value.required, C2ZC_RUST_VERIFY_CHECKS)) {
    throw new Error(`${label} required does not match the policy catalogue`);
  }
  if (!sameOrderedArray(value.covered, C2ZC_RUST_VERIFY_CHECKS)) {
    throw new Error(`${label} covered does not match the policy catalogue`);
  }
  return value;
}

export function assertC2ZcRustVerifyOutcome(
  value,
  label = "C2-ZC Rust Verify outcome",
) {
  exactObjectKeys(value, ["verifyContractVersion", "checkCoverage"], label);
  assertC2ZcRustVerifyContractVersion(
    value.verifyContractVersion,
    `${label} verifyContractVersion`,
  );
  assertC2ZcRustVerifyCoverage(value.checkCoverage, `${label} checkCoverage`);
  return value;
}
