import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { restoreBackupThroughSettingsUi } from "./narrative-maintenance-product-journeys.mjs";

/**
 * C2-ZC is one stateful lifecycle.  The runner owns only observations and
 * typed product calls; restore, Verify, Rebuild, Freshness, marker, and
 * workspace authority remain production-owned.
 */
export const C2ZC_PRODUCT_JOURNEY_ID = "c2-zc-canonical-authority-cutover";
export const C2ZC_RESTORE_FIXTURE_ENV = "GRIMODEX_C2ZC_RESTORE_FIXTURE";
export const C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION = 1;
export const C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION = 1;
export const C2ZC_RESTORE_FIXTURE_BUILDER_VERSION =
  "c2zc-restore-fixture-builder/v1";
export const C2ZC_VERIFY_COVERAGE_COUNT = 13;
export const C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES = Object.freeze([
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
]);

export const C2ZC_SEMANTIC_INDEX_ZERO_COUNTS = Object.freeze({
  metadataRows: 0,
  activeD1HeadRows: 0,
  v1EdgeRows: 0,
  consumerFreshnessRows: 0,
});

export const C2ZC_CANONICAL_FRESHNESS_CONTRACT = Object.freeze({
  authority: "GenericConsumerFreshness",
  rustSource:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_canonical_cutover.rs",
  rustReadFunction: "canonical_application_freshness",
  requiredEvidence: Object.freeze([
    "applicationId",
    "evidenceFreshness",
    "buildAction",
    "semanticEpochId",
    "lastEvaluatedRunId",
    "dependencySetDigest",
    "updatedAt",
  ]),
  noLegacyFallback: true,
  missingGenericError: "NEX_C2ZC_GENERIC_FRESHNESS_MISSING",
});

const C2ZC_CUTOVER_MIGRATION_ID = "narrative-c2-canonical-freshness-v1";
const C2ZC_CUTOVER_CONTRACT_VERSION = 1;
const C2ZC_FRESHNESS_CONSUMER_KIND = "application";
const C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID =
  "narrative-incremental-freshness/v1";
const C2ZC_WAIT_MS = 60_000;
const C2ZC_FIXTURE_GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const C2ZC_FIXTURE_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const C2ZC_RESTORE_FIXTURE_MANIFEST_KEYS = Object.freeze([
  "manifestVersion",
  "contractVersion",
  "schemaVersion",
  "databaseSchemaVersion",
  "c2zcMarkerPresent",
  "candidate",
  "builderVersion",
  "builderCommand",
  "exactBuilderCommand",
  "artifacts",
  "fixtureSha256",
  "fixtureSizeBytes",
  "semantic",
]);
const C2ZC_RESTORE_FIXTURE_CANDIDATE_KEYS = Object.freeze([
  "requested",
  "resolvedHeadSha",
  "resolvedTreeSha",
  "headSha",
  "treeSha",
  "clean",
  "statusSha256",
]);
const C2ZC_RESTORE_FIXTURE_ARTIFACT_KEYS = Object.freeze([
  "path",
  "sha256",
  "sizeBytes",
]);
const C2ZC_RESTORE_FIXTURE_SEMANTIC_KEYS = Object.freeze([
  "projectId",
  "sceneId",
  "ownerRunId",
  "projectCount",
  "e0Count",
  "completedBackfillCount",
  "dependencyEdgeCount",
  "edgeStateCount",
  "ownerFreshnessCount",
  "cursorSettled",
  "semanticIndexRows",
  "sceneSourceRevision",
  "edgeSourceObjectIdentity",
  "edgeReadSetJson",
  "project",
  "projectDigest",
  "scene",
  "sceneDigest",
  "epoch",
  "epochDigest",
  "backfill",
  "backfillDigest",
  "edge",
  "edgeDigest",
  "feedCursor",
  "feedCursorDigest",
  "derivedStateGap",
  "semanticIndex",
  "expectedRestoreLifecycle",
  "contentsDigest",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  }
  if (!isObject(parsed)) throw new Error(`${label} must be an object`);
  return parsed;
}

function parseArray(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function requireText(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function rows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function outcomeOf(value, label) {
  if (value?.outcomeSummaryJson !== undefined) {
    return parseObject(value.outcomeSummaryJson, `${label} outcomeSummaryJson`);
  }
  if (value?.outcome !== undefined) {
    return parseObject(value.outcome, `${label} outcome`);
  }
  return parseObject(value, `${label} outcome`);
}

function reportOf(value, label) {
  const outcome = outcomeOf(value, label);
  const report = outcome.report ?? value?.report;
  if (!isObject(report)) {
    throw new Error(`${label} must contain the production Verify report`);
  }
  return { outcome, report };
}

function expectedCoverageOf(value, label) {
  const candidate = value?.checkCoverage ?? value?.coverage ?? value;
  const coverage = parseObject(candidate, `${label} check coverage`);
  assertExactKeys(
    coverage,
    ["complete", "required", "covered", "missing"],
    label,
  );
  return coverage;
}

/**
 * Compare the persisted machine-readable values with the Rust Verify outcome.
 * The JavaScript contract deliberately does not reproduce Rust's check list.
 */
export function assertC2ZcVerifyCoverage(
  run,
  rustOutcome,
  label = "C2-ZC Verify",
) {
  const { outcome } = reportOf(run, label);
  if (run?.status !== undefined && run.status !== "completed") {
    throw new Error(`${label} must be a completed production Verify Run`);
  }
  const actual = expectedCoverageOf(outcome, `${label} persisted`);
  if (
    actual.complete !== true ||
    !Array.isArray(actual.required) ||
    !Array.isArray(actual.covered) ||
    !Array.isArray(actual.missing) ||
    actual.required.length !== C2ZC_VERIFY_COVERAGE_COUNT ||
    actual.covered.length !== C2ZC_VERIFY_COVERAGE_COUNT ||
    actual.missing.length !== 0
  ) {
    throw new Error(`${label} does not contain complete 13/13 coverage`);
  }
  if (rustOutcome !== undefined && rustOutcome !== null) {
    const expected = expectedCoverageOf(rustOutcome, "Rust Verify outcome");
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error(`${label} coverage values differ from the Rust outcome`);
    }
  }
  return { outcome, checkCoverage: actual };
}

export function assertC2ZcSemanticIndexZero(
  value,
  label = "C2-ZC Semantic Index",
) {
  const { report } = reportOf(value, label);
  for (const field of [
    "semanticIndexDependencySetDigest",
    "semanticIndexGenerationCorrespondence",
  ]) {
    const check = report[field];
    if (!isObject(check))
      throw new Error(`${label} check '${field}' is missing`);
    if (
      stableJson(check.observedCounts) !==
      stableJson(C2ZC_SEMANTIC_INDEX_ZERO_COUNTS)
    ) {
      throw new Error(`${label} reserved Semantic Index surfaces are not zero`);
    }
    if (
      check.completed !== true ||
      check.passed !== true ||
      stableJson(check.issues) !== "[]" ||
      stableJson(check.incomplete) !== "[]"
    ) {
      throw new Error(`${label} check '${field}' is not complete and passed`);
    }
  }
  return C2ZC_SEMANTIC_INDEX_ZERO_COUNTS;
}

function markerRowsOf(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.markerRows)) return snapshot.markerRows;
  if (snapshot?.marker) return [snapshot.marker];
  return [];
}

export function assertC2ZcMarkerExactlyOnce(snapshot, label = "C2-ZC marker") {
  const markerRows = markerRowsOf(snapshot);
  if (markerRows.length !== 1) {
    throw new Error(`${label} must contain exactly one persisted marker row`);
  }
  const marker = markerRows[0];
  if (
    marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(marker?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION ||
    typeof marker?.appliedAt !== "string" ||
    marker.appliedAt.trim() === ""
  ) {
    throw new Error(`${label} is not the current C2-ZC marker`);
  }
  return marker;
}

export function assertC2ZcFindingInboxEmpty(
  snapshot,
  label = "C2-ZC findings",
) {
  const findings = snapshot?.unresolvedFindings ?? snapshot?.findings ?? [];
  const inbox = snapshot?.inboxEntries ?? snapshot?.inbox ?? [];
  if (!Array.isArray(findings) || !Array.isArray(inbox)) {
    throw new Error(`${label} must expose findings and inbox arrays`);
  }
  if (findings.length !== 0 || inbox.length !== 0) {
    throw new Error(`${label} contains unresolved findings or Inbox entries`);
  }
  return true;
}

export function assertC2ZcLegacyProjectionStable(
  before,
  after,
  label = "C2-ZC Legacy projection",
) {
  if (stableJson(before) !== stableJson(after)) {
    throw new Error(`${label} changed across the lifecycle boundary`);
  }
  return after;
}

export function assertC2ZcGenericRowsComplete(
  snapshot,
  label = "C2-ZC Generic storage",
) {
  const genericRows = rows(snapshot?.genericRows, `${label} rows`);
  for (const [index, row] of genericRows.entries()) {
    for (const field of C2ZC_CANONICAL_FRESHNESS_CONTRACT.requiredEvidence) {
      if (
        row[field] === undefined ||
        row[field] === null ||
        row[field] === ""
      ) {
        throw new Error(`${label} row ${index} is missing ${field}`);
      }
    }
    if (row.consumerKind !== C2ZC_FRESHNESS_CONSUMER_KIND) {
      throw new Error(
        `${label} row ${index} is not an Application Consumer row`,
      );
    }
  }
  return genericRows;
}

export function assertC2ZcGenericFreshnessStorage(
  snapshot,
  { projectId, applicationId, epochId } = {},
  label = "C2-ZC Generic storage",
) {
  requireText(projectId, `${label} projectId`);
  requireText(applicationId, `${label} applicationId`);
  requireText(epochId, `${label} epochId`);
  const candidates = rows(snapshot?.genericRows, `${label} rows`).filter(
    (row) =>
      row.projectId === projectId &&
      row.consumerKind === C2ZC_FRESHNESS_CONSUMER_KIND &&
      row.consumerKey === applicationId,
  );
  if (candidates.length !== 1) {
    throw new Error(`${label} must contain exactly one targeted Generic row`);
  }
  const row = candidates[0];
  if (row.semanticEpochId !== epochId) {
    throw new Error(`${label} row is not bound to the current Semantic Epoch`);
  }
  assertC2ZcGenericRowsComplete({ genericRows: [row] }, label);
  return row;
}

export function assertC2ZcFeedCursorSettled(
  snapshot,
  { epochId } = {},
  label = "C2-ZC Change Feed cursor",
) {
  const cursor = snapshot?.feedCursor;
  if (!isObject(cursor)) throw new Error(`${label} is missing its cursor`);
  if (
    cursor.lastError !== null &&
    cursor.lastError !== undefined &&
    cursor.lastError !== ""
  ) {
    throw new Error(`${label} has a persisted error`);
  }
  if (
    Number(cursor.acknowledgedThrough) !== Number(cursor.feedHead) ||
    cursor.reservedThrough !== null ||
    cursor.activeRunId !== null
  ) {
    throw new Error(`${label} is not fully acknowledged`);
  }
  if (epochId !== undefined && cursor.semanticEpochId !== null) {
    throw new Error(`${label} retains an active Semantic Epoch`);
  }
  return cursor;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertFixtureGitObjectId(value, label) {
  if (typeof value !== "string" || !C2ZC_FIXTURE_GIT_OBJECT_ID.test(value)) {
    throw new Error(`${label} must be a lowercase Git object ID`);
  }
  return value;
}

function assertFixtureSha256(value, label) {
  if (typeof value !== "string" || !C2ZC_FIXTURE_SHA256.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function assertFixtureArtifactPath(value, label) {
  requireText(value, label);
  if (
    path.isAbsolute(value) ||
    value !== path.basename(value) ||
    value === "." ||
    value === ".." ||
    value.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a relative file name`);
  }
  return value;
}

function assertC2ZcFixtureCandidate(candidate, label) {
  if (!isObject(candidate)) throw new Error(`${label} must be an object`);
  assertExactKeys(candidate, C2ZC_RESTORE_FIXTURE_CANDIDATE_KEYS, label);
  requireText(candidate.requested, `${label}.requested`);
  for (const field of [
    "resolvedHeadSha",
    "resolvedTreeSha",
    "headSha",
    "treeSha",
  ]) {
    assertFixtureGitObjectId(candidate[field], `${label}.${field}`);
  }
  if (
    candidate.resolvedHeadSha !== candidate.headSha ||
    candidate.resolvedTreeSha !== candidate.treeSha
  ) {
    throw new Error(`${label} head/tree aliases do not match resolved values`);
  }
  if (candidate.clean !== true) {
    throw new Error(`${label}.clean must be true`);
  }
  assertFixtureSha256(candidate.statusSha256, `${label}.statusSha256`);
  return candidate;
}

function assertC2ZcFixtureArtifact(artifact, label) {
  if (!isObject(artifact)) throw new Error(`${label} must be an object`);
  assertExactKeys(artifact, C2ZC_RESTORE_FIXTURE_ARTIFACT_KEYS, label);
  assertFixtureArtifactPath(artifact.path, `${label}.path`);
  assertFixtureSha256(artifact.sha256, `${label}.sha256`);
  assertNonNegativeInteger(artifact.sizeBytes, `${label}.sizeBytes`);
  return artifact;
}

function assertC2ZcFixtureSemantic(semantic, label) {
  if (!isObject(semantic)) throw new Error(`${label} must be an object`);
  assertExactKeys(semantic, C2ZC_RESTORE_FIXTURE_SEMANTIC_KEYS, label);
  for (const field of ["projectId", "sceneId", "ownerRunId"]) {
    requireText(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "projectCount",
    "e0Count",
    "completedBackfillCount",
    "dependencyEdgeCount",
    "edgeStateCount",
    "ownerFreshnessCount",
    "semanticIndexRows",
  ]) {
    assertNonNegativeInteger(semantic[field], `${label}.${field}`);
  }
  if (
    semantic.projectCount !== 1 ||
    semantic.e0Count !== 1 ||
    semantic.completedBackfillCount !== 1 ||
    semantic.dependencyEdgeCount !== 1 ||
    semantic.edgeStateCount !== 0 ||
    semantic.ownerFreshnessCount !== 0 ||
    semantic.semanticIndexRows !== 0 ||
    semantic.cursorSettled !== true
  ) {
    throw new Error(
      `${label} is not the required pre-cutover derived-state gap`,
    );
  }
  for (const field of [
    "sceneSourceRevision",
    "edgeSourceObjectIdentity",
    "edgeReadSetJson",
  ]) {
    requireText(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "projectDigest",
    "sceneDigest",
    "epochDigest",
    "backfillDigest",
    "edgeDigest",
    "feedCursorDigest",
    "contentsDigest",
  ]) {
    assertFixtureSha256(semantic[field], `${label}.${field}`);
  }
  for (const field of [
    "project",
    "epoch",
    "backfill",
    "edge",
    "feedCursor",
    "derivedStateGap",
    "semanticIndex",
    "expectedRestoreLifecycle",
  ]) {
    if (!isObject(semantic[field])) {
      throw new Error(`${label}.${field} must be an object`);
    }
  }
  return semantic;
}

/** Validate the exact output contract of the Rust offline fixture builder. */
export function assertC2ZcRestoreFixtureManifest(
  manifest,
  label = "C2-ZC restore fixture manifest",
) {
  if (!isObject(manifest)) throw new Error(`${label} must be an object`);
  assertExactKeys(manifest, C2ZC_RESTORE_FIXTURE_MANIFEST_KEYS, label);
  if (manifest.manifestVersion !== C2ZC_RESTORE_FIXTURE_MANIFEST_VERSION) {
    throw new Error(`${label} manifestVersion is unsupported`);
  }
  if (manifest.contractVersion !== C2ZC_RESTORE_FIXTURE_CONTRACT_VERSION) {
    throw new Error(`${label} contractVersion is unsupported`);
  }
  assertPositiveInteger(manifest.schemaVersion, `${label}.schemaVersion`);
  if (manifest.databaseSchemaVersion !== manifest.schemaVersion) {
    throw new Error(
      `${label} databaseSchemaVersion does not match schemaVersion`,
    );
  }
  if (manifest.c2zcMarkerPresent !== false) {
    throw new Error(`${label} must be a pre-cutover image without the marker`);
  }
  assertC2ZcFixtureCandidate(manifest.candidate, `${label}.candidate`);
  if (manifest.builderVersion !== C2ZC_RESTORE_FIXTURE_BUILDER_VERSION) {
    throw new Error(`${label} builderVersion is unsupported`);
  }
  if (
    !Array.isArray(manifest.builderCommand) ||
    manifest.builderCommand.length === 0 ||
    manifest.builderCommand.some((value) => typeof value !== "string") ||
    !Array.isArray(manifest.exactBuilderCommand) ||
    manifest.exactBuilderCommand.length === 0 ||
    manifest.exactBuilderCommand.some((value) => typeof value !== "string") ||
    stableJson(manifest.builderCommand) !==
      stableJson(manifest.exactBuilderCommand)
  ) {
    throw new Error(`${label} builder command is invalid`);
  }
  if (!isObject(manifest.artifacts)) {
    throw new Error(`${label}.artifacts must be an object`);
  }
  assertExactKeys(
    manifest.artifacts,
    ["fixture", "database"],
    `${label}.artifacts`,
  );
  assertC2ZcFixtureArtifact(
    manifest.artifacts.fixture,
    `${label}.artifacts.fixture`,
  );
  assertC2ZcFixtureArtifact(
    manifest.artifacts.database,
    `${label}.artifacts.database`,
  );
  assertFixtureSha256(manifest.fixtureSha256, `${label}.fixtureSha256`);
  assertNonNegativeInteger(
    manifest.fixtureSizeBytes,
    `${label}.fixtureSizeBytes`,
  );
  if (
    manifest.fixtureSha256 !== manifest.artifacts.fixture.sha256 ||
    manifest.fixtureSizeBytes !== manifest.artifacts.fixture.sizeBytes
  ) {
    throw new Error(
      `${label} top-level fixture digest disagrees with artifact`,
    );
  }
  assertC2ZcFixtureSemantic(manifest.semantic, `${label}.semantic`);
  return manifest;
}

/**
 * Narrow boundary between the fixture builder and this journey. The builder
 * owns the offline SQLite image; this runner only stages the verified image
 * and uses the production Settings restore route.
 */
export function assertC2ZcRestoreFixtureInput(
  input,
  label = "C2-ZC restore fixture",
) {
  if (!isObject(input)) throw new Error(`${label} must be an object`);
  assertExactKeys(input, ["path", "manifest"], label);
  if (
    typeof input.path !== "string" ||
    !path.isAbsolute(input.path) ||
    input.path.includes("\u0000")
  ) {
    throw new Error(`${label} path must be absolute and NUL-free`);
  }
  if (typeof input.manifest === "string") {
    if (!path.isAbsolute(input.manifest) || input.manifest.includes("\u0000")) {
      throw new Error(`${label} manifest path must be absolute and NUL-free`);
    }
    return input;
  }
  assertC2ZcRestoreFixtureManifest(
    parseObject(input.manifest, `${label} manifest`),
    `${label} manifest`,
  );
  return input;
}

export function resolveC2ZcRestoreFixtureInput(
  input,
  environment = process.env,
) {
  let value = input;
  if (value === undefined || value === null || value === "") {
    value = environment[C2ZC_RESTORE_FIXTURE_ENV];
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(`${C2ZC_RESTORE_FIXTURE_ENV} must be JSON`, {
        cause: error,
      });
    }
  }
  return assertC2ZcRestoreFixtureInput(value);
}

async function stageC2ZcRestoreFixture(workspace, fixture) {
  const sourceMetadata = await lstat(fixture.path);
  if (!sourceMetadata.isFile()) {
    throw new Error("C2-ZC restore fixture path must be a regular file");
  }
  const sourcePath = await realpath(fixture.path);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile())
    throw new Error("C2-ZC restore fixture path must be a file");
  const backupDirectory = path.join(workspace, "backups");
  await mkdir(backupDirectory, { recursive: true });
  const targetPath = path.join(
    backupDirectory,
    fixture.manifest.artifacts.fixture.path,
  );
  await copyFile(sourcePath, targetPath);
  await assertFixtureArtifactDigest(
    targetPath,
    fixture.manifest.artifacts.fixture,
    "C2-ZC staged restore fixture",
  );
  return { targetPath, sourcePath, manifest: fixture.manifest };
}

async function assertFixtureArtifactDigest(filePath, expected, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  const bytes = await readFile(filePath);
  const actualSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualSha256 !== expected.sha256 || bytes.length !== expected.sizeBytes) {
    throw new Error(`${label} bytes do not match its manifest digest`);
  }
  return { sha256: actualSha256, sizeBytes: bytes.length };
}

export async function loadC2ZcRestoreFixtureInput(
  input,
  environment = process.env,
) {
  const fixture = resolveC2ZcRestoreFixtureInput(input, environment);
  let manifestPath = null;
  const manifest =
    typeof fixture.manifest === "string"
      ? ((manifestPath = fixture.manifest),
        parseObject(
          JSON.parse(await readFile(fixture.manifest, "utf8")),
          "C2-ZC restore fixture manifest",
        ))
      : fixture.manifest;
  assertC2ZcRestoreFixtureManifest(manifest);
  const manifestBase = path.dirname(manifestPath ?? fixture.path);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const artifactPath = path.resolve(manifestBase, artifact.path);
    const resolvedInput = path.resolve(fixture.path);
    if (path.resolve(artifactPath) !== resolvedInput && name === "fixture") {
      throw new Error("C2-ZC fixture path does not match manifest artifact");
    }
    await assertFixtureArtifactDigest(
      artifactPath,
      artifact,
      `C2-ZC ${name} artifact`,
    );
  }
  return {
    path: fixture.path,
    manifest,
    manifestPath,
  };
}

function observedCandidateOf(value, label) {
  const candidate = value?.receipt?.candidate ?? value?.candidate ?? value;
  if (!isObject(candidate)) {
    throw new Error(`${label} must expose the candidate-bound Rust receipt`);
  }
  return candidate;
}

/**
 * Re-bind the fixture's candidate/head/tree evidence to the live Rust receipt.
 * The Rust receipt uses a richer candidate shape; only equivalent fields are
 * compared here, while the fixture's status and byte digests are checked
 * against their own manifest artifacts above.
 */
export function assertC2ZcFixtureCandidateBinding(
  manifestCandidate,
  observedCandidate,
  label = "C2-ZC fixture candidate",
) {
  const fixtureCandidate = assertC2ZcFixtureCandidate(manifestCandidate, label);
  const candidate = observedCandidateOf(observedCandidate, label);
  const requested = candidate.requestedHead ?? candidate.requested;
  const resolvedHeadSha = candidate.resolvedHeadSha;
  const resolvedTreeSha =
    candidate.resolvedHeadTreeSha ?? candidate.resolvedTreeSha;
  const currentHeadSha = candidate.currentHeadSha ?? candidate.headSha;
  const worktreeClean = candidate.worktreeClean ?? candidate.clean;
  if (
    typeof requested !== "string" ||
    typeof resolvedHeadSha !== "string" ||
    typeof resolvedTreeSha !== "string" ||
    typeof currentHeadSha !== "string" ||
    worktreeClean !== true
  ) {
    throw new Error(`${label} does not expose a complete candidate binding`);
  }
  if (requested !== fixtureCandidate.requested) {
    throw new Error(
      `${label} requested candidate does not match the Rust receipt`,
    );
  }
  if (resolvedHeadSha !== fixtureCandidate.resolvedHeadSha) {
    throw new Error(`${label} resolved HEAD does not match the Rust receipt`);
  }
  if (resolvedTreeSha !== fixtureCandidate.resolvedTreeSha) {
    throw new Error(`${label} resolved tree does not match the Rust receipt`);
  }
  if (currentHeadSha !== fixtureCandidate.headSha) {
    throw new Error(`${label} current HEAD does not match the fixture`);
  }
  if (
    candidate.fixtureStatusSha256 !== undefined &&
    candidate.fixtureStatusSha256 !== fixtureCandidate.statusSha256
  ) {
    throw new Error(`${label} status digest does not match the fixture`);
  }
  const observedStatusSha256 =
    candidate.fixtureStatusSha256 ??
    candidate.worktreeStatusHash ??
    candidate.statusSha256;
  if (typeof observedStatusSha256 === "string") {
    const normalizedStatusSha256 = observedStatusSha256.startsWith("sha256:")
      ? observedStatusSha256
      : `sha256:${observedStatusSha256}`;
    if (normalizedStatusSha256 !== fixtureCandidate.statusSha256) {
      throw new Error(`${label} status digest does not match the fixture`);
    }
  }
  return fixtureCandidate;
}

async function queryRows(harness, page, sql, params = []) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
  );
}

async function readInbox(harness, page, projectId) {
  const result = await harness.invokeOk(
    page,
    "narrative_maintenance_inbox_list",
    {
      payload: { projectId },
    },
  );
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.entries)) return result.entries;
  throw new Error("C2-ZC maintenance Inbox did not return an array");
}

export async function readC2ZcRunLedger(
  harness,
  page,
  projectId,
  existingRuns,
) {
  if (Array.isArray(existingRuns)) return existingRuns;
  return queryRows(
    harness,
    page,
    `SELECT id, project_id AS projectId,
            run_kind AS runKind, work_key AS workKey, status,
            semantic_epoch_id AS semanticEpochId,
            outcome_summary_json AS outcomeSummaryJson,
            created_at AS createdAt, started_at AS startedAt,
            completed_at AS completedAt, version
       FROM narrative_extraction_runs
      WHERE project_id = ?
      ORDER BY created_at, id`,
    [projectId],
  );
}

/** Read live durable values without inventing a second maintenance engine. */
export async function readC2ZcAuthoritySnapshot(harness, page, projectId) {
  const [
    markerRows,
    epochs,
    runs,
    genericRows,
    legacyProjection,
    feedCursorRows,
    applications,
    codexEntries,
    projectInventory,
    findingRows,
    inboxEntries,
  ] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT migration_id AS migrationId,
              contract_version AS contractVersion,
              applied_at AS appliedAt
         FROM schema_data_migrations
        WHERE migration_id = ?`,
      [C2ZC_CUTOVER_MIGRATION_ID],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId,
              epoch_number AS epochNumber, reason,
              created_at AS createdAt
         FROM narrative_semantic_epochs
        WHERE project_id = ?
        ORDER BY epoch_number, id`,
      [projectId],
    ),
    readC2ZcRunLedger(harness, page, projectId),
    queryRows(
      harness,
      page,
      `SELECT project_id AS projectId,
              consumer_kind AS consumerKind,
              consumer_key AS consumerKey,
              evidence_freshness AS evidenceFreshness,
              build_action AS buildAction,
              semantic_epoch_id AS semanticEpochId,
              last_evaluated_run_id AS lastEvaluatedRunId,
              dependency_set_digest AS dependencySetDigest,
              updated_at AS updatedAt
         FROM narrative_consumer_freshness
        WHERE project_id = ? AND consumer_kind = ?
        ORDER BY consumer_key`,
      [projectId, C2ZC_FRESHNESS_CONSUMER_KIND],
    ),
    queryRows(
      harness,
      page,
      `SELECT application.id AS applicationId,
              freshness.status AS status,
              freshness.reason_json AS reasonJson,
              freshness.version AS version,
              freshness.updated_at AS updatedAt
         FROM narrative_projection_freshness freshness
         JOIN narrative_proposal_applications application
           ON application.id = freshness.application_id
         JOIN narrative_apply_commits commit_row
           ON commit_row.id = application.commit_id
        WHERE commit_row.project_id = ?
        ORDER BY application.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT COALESCE(MAX(canonical_sequence), 0) AS feedHead,
              (SELECT acknowledged_through_sequence
                 FROM narrative_change_cursors
                WHERE project_id = ? AND consumer_id = ?
                LIMIT 1) AS acknowledgedThrough,
              (SELECT reserved_through_sequence
                 FROM narrative_change_cursors
                WHERE project_id = ? AND consumer_id = ?
                LIMIT 1) AS reservedThrough,
              (SELECT active_run_id
                 FROM narrative_change_cursors
                WHERE project_id = ? AND consumer_id = ?
                LIMIT 1) AS activeRunId,
              (SELECT semantic_epoch_id
                 FROM narrative_change_cursors
                WHERE project_id = ? AND consumer_id = ?
                LIMIT 1) AS semanticEpochId,
              (SELECT last_error
                 FROM narrative_change_cursors
                WHERE project_id = ? AND consumer_id = ?
                LIMIT 1) AS lastError
         FROM narrative_change_events
        WHERE project_id = ?`,
      [
        projectId,
        C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        projectId,
        C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        projectId,
        C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        projectId,
        C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        projectId,
        C2ZC_INCREMENTAL_FRESHNESS_CONSUMER_ID,
        projectId,
      ],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS applicationId, commit_id AS commitId,
              proposal_id AS proposalId, revision_id AS revisionId,
              applied_entity_kind AS appliedEntityKind,
              applied_entity_id AS appliedEntityId, created_at AS createdAt
         FROM narrative_proposal_applications application
         JOIN narrative_apply_commits commit_row
           ON commit_row.id = application.commit_id
        WHERE commit_row.project_id = ?
        ORDER BY application.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id AS entryId, project_id AS projectId, name, type_slug AS typeSlug
         FROM codex_entries
        WHERE project_id = ?
        ORDER BY id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      "SELECT id AS projectId FROM projects ORDER BY id",
    ),
    queryRows(
      harness,
      page,
      `SELECT id, finding_identity AS findingIdentity,
              lifecycle_state AS lifecycleState,
              semantic_epoch_id AS semanticEpochId
         FROM narrative_maintenance_finding_lifecycle
        WHERE project_id = ?
        ORDER BY id`,
      [projectId],
    ),
    readInbox(harness, page, projectId),
  ]);
  const feedCursor = feedCursorRows[0] ?? null;
  const currentEpoch = epochs.at(-1) ?? null;
  return {
    projectId,
    projectInventory,
    markerRows,
    marker: markerRows[0] ?? null,
    epochs,
    currentEpochId: currentEpoch?.id ?? null,
    runs,
    genericRows,
    legacyProjection,
    feedCursor,
    applications,
    codexEntries,
    findingRows,
    inboxEntries,
    projectSettled:
      runs.length > 0 && runs.every((run) => run.status === "completed"),
  };
}

function initialEpoch(epochs, label) {
  const values = rows(epochs, `${label} epochs`);
  const epoch = values.find((candidate) => Number(candidate.epochNumber) === 0);
  if (!epoch || epoch.reason !== "initial" || typeof epoch.id !== "string") {
    throw new Error(`${label} must retain an initial E0 epoch`);
  }
  return epoch;
}

function restoredEpoch(epochs, label) {
  const values = rows(epochs, `${label} epochs`);
  const e0 = initialEpoch(values, label);
  const e1 = values.find((candidate) => Number(candidate.epochNumber) === 1);
  if (!e1 || e1.reason !== "restore" || e1.id === e0.id) {
    throw new Error(`${label} must contain restored E1 after E0`);
  }
  return { e0, e1 };
}

function assertSameEpochLineage(before, after, label) {
  const left = rows(before, `${label} before epochs`);
  const right = rows(after, `${label} after epochs`);
  if (
    left.length !== right.length ||
    left.some((epoch, index) => stableJson(epoch) !== stableJson(right[index]))
  ) {
    throw new Error(`${label} changed the persisted Semantic Epoch lineage`);
  }
  return right;
}

/** Verify -> optional Rebuild -> confirmation Verify -> Freshness. */
export function assertC2ZcRestoreLifecycleOrder(
  runValues,
  { currentEpochId, restoreEpochId, rustOutcome } = {},
  label = "C2-ZC restore lifecycle",
) {
  const runsValue = rows(runValues, `${label} runs`);
  const completed = runsValue.filter((run) => run.status === "completed");
  const verifyRuns = completed.filter(
    (run) => run.runKind === "dependency-verify",
  );
  if (verifyRuns.length === 0) throw new Error(`${label} is missing Verify`);
  const firstVerify = verifyRuns[0];
  if (
    restoreEpochId !== undefined &&
    firstVerify.semanticEpochId !== restoreEpochId
  ) {
    throw new Error(
      `${label} first Verify is not bound to the restored E1 Semantic Epoch`,
    );
  }
  const firstReport = reportOf(firstVerify, `${label} first Verify`).report;
  const firstCoverage = assertC2ZcVerifyCoverage(
    firstVerify,
    rustOutcome,
    `${label} first Verify`,
  );
  let finalVerify = firstVerify;
  let endIndex = runsValue.indexOf(firstVerify);
  if (firstReport.rebuildRequired === true) {
    const rebuild = completed.find(
      (run) =>
        runsValue.indexOf(run) > endIndex &&
        run.runKind === "semantic-index-rebuild",
    );
    if (!rebuild) throw new Error(`${label} requires a conditional Rebuild`);
    const rebuildIndex = runsValue.indexOf(rebuild);
    finalVerify = completed.find(
      (run) =>
        runsValue.indexOf(run) > rebuildIndex &&
        run.runKind === "dependency-verify",
    );
    if (!finalVerify) {
      throw new Error(`${label} is missing the confirmation Verify`);
    }
    endIndex = runsValue.indexOf(finalVerify);
  }
  const finalReport = reportOf(finalVerify, `${label} final Verify`).report;
  if (
    restoreEpochId !== undefined &&
    finalVerify.semanticEpochId !== restoreEpochId
  ) {
    throw new Error(
      `${label} confirmation Verify is not bound to the restored E1 Semantic Epoch`,
    );
  }
  if (finalReport.rebuildRequired !== false) {
    throw new Error(`${label} final Verify still requests Rebuild`);
  }
  const finalCoverage = assertC2ZcVerifyCoverage(
    finalVerify,
    rustOutcome ?? firstCoverage.outcome,
    `${label} final Verify`,
  );
  const freshness = completed.find(
    (run) =>
      runsValue.indexOf(run) > endIndex &&
      run.runKind === "freshness-evaluation" &&
      (currentEpochId === undefined || run.semanticEpochId === currentEpochId),
  );
  if (!freshness) throw new Error(`${label} is missing post-Verify Freshness`);
  return {
    firstVerify,
    rebuild:
      firstReport.rebuildRequired === true
        ? completed.find(
            (run) =>
              runsValue.indexOf(run) > runsValue.indexOf(firstVerify) &&
              run.runKind === "semantic-index-rebuild",
          )
        : null,
    finalVerify,
    firstCoverage,
    finalCoverage,
    freshness,
  };
}

export function assertC2ZcRestartInvariants({
  before,
  restart,
  label = "C2-ZC first restart",
} = {}) {
  if (!before || !restart) throw new Error(`${label} requires both snapshots`);
  if (before.projectId !== restart.projectId) {
    throw new Error(`${label} changed the project authority`);
  }
  assertC2ZcMarkerExactlyOnce(before, `${label} before marker`);
  assertC2ZcMarkerExactlyOnce(restart, `${label} after marker`);
  if (stableJson(before.markerRows) !== stableJson(restart.markerRows)) {
    throw new Error(`${label} changed the persisted authority marker`);
  }
  assertSameEpochLineage(before.epochs, restart.epochs, label);
  if (
    before.currentEpochId !== undefined &&
    before.currentEpochId !== restart.currentEpochId
  ) {
    throw new Error(`${label} changed the current Semantic Epoch authority`);
  }
  assertC2ZcLegacyProjectionStable(
    before.legacyProjection,
    restart.legacyProjection,
    `${label} Legacy projection`,
  );
  const beforeIds = new Set(
    rows(before.runs, `${label} before runs`).map((run) => run.id),
  );
  const restartRuns = rows(restart.runs, `${label} restart runs`);
  if ([...beforeIds].some((id) => !restartRuns.some((run) => run.id === id))) {
    throw new Error(`${label} lost a durable Run identity`);
  }
  if (
    restartRuns.some(
      (run) =>
        run.runKind === "backfill" &&
        run.semanticEpochId === restart.epochs.at(-1)?.id,
    )
  ) {
    throw new Error(`${label} minted an E1 Backfill on restart`);
  }
  return restart;
}

export function assertC2ZcFinalRestartPersistence({
  before,
  restart,
  application,
  label = "C2-ZC final restart",
} = {}) {
  assertC2ZcRestartInvariants({ before, restart, label });
  if (!application?.applicationId) {
    throw new Error(`${label} requires the typed Application identity`);
  }
  assertC2ZcGenericFreshnessStorage(
    restart,
    {
      projectId: application.projectId,
      applicationId: application.applicationId,
      epochId: restart.currentEpochId ?? restart.epochs.at(-1)?.id,
    },
    `${label} Generic storage`,
  );
  if (
    !restart.applications.some(
      (row) => row.applicationId === application.applicationId,
    ) ||
    !restart.codexEntries.some((row) => row.entryId === application.entryId)
  ) {
    throw new Error(`${label} lost the typed Application or Generic entity`);
  }
  return restart;
}

function stablePayloadDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

async function captureWorkspaceBinding(harness, page, workspace, label) {
  const binding = await harness.invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspace },
  );
  if (
    !isObject(binding) ||
    typeof binding.authorityId !== "string" ||
    binding.authorityId.trim() === "" ||
    !Number.isSafeInteger(Number(binding.generation)) ||
    Number(binding.generation) <= 0 ||
    typeof binding.authorityInstanceId !== "string" ||
    binding.authorityInstanceId.trim() === ""
  ) {
    throw new Error(`${label} returned an invalid Native workspace binding`);
  }
  return {
    authorityId: binding.authorityId,
    generation: Number(binding.generation),
    authorityInstanceId: binding.authorityInstanceId,
  };
}

/** One real typed producer/Application write after the canonical marker. */
export async function createTypedApplicationAfterMarker(
  harness,
  page,
  workspace,
  projectId,
) {
  const workspaceBinding = await captureWorkspaceBinding(
    harness,
    page,
    workspace,
    "C2-ZC typed Application",
  );
  const runId = `c2-zc-typed-run-${randomUUID()}`;
  const taskId = `${runId}-task`;
  const snapshot = { kind: "c2-zc-typed-source@1", projectId, runId };
  const snapshotDigest = stablePayloadDigest(snapshot);
  const specJson = { kind: "c2-zc-typed-application@1", version: 1, projectId };
  const createdRun = await harness.invokeOk(
    page,
    "narrative_extraction_create_run",
    {
      payload: {
        runId,
        projectId,
        surfacePathId: "c2-zc-typed-application",
        scopeJson: { projectId },
        specJson,
        specDigest: stablePayloadDigest(specJson),
        snapshotDigest,
        catalogDigest: null,
        registryDigest: null,
        coverageJson: null,
        tasks: [
          {
            taskId,
            taskKind: "c2-zc-typed-application",
            inputJson: snapshot,
            priority: 1,
          },
        ],
      },
      workspaceBinding,
    },
  );
  if (createdRun?.runId !== runId || createdRun?.status !== "running") {
    throw new Error(
      `C2-ZC typed Application Run was not created: ${JSON.stringify(createdRun)}`,
    );
  }
  const leaseOwner = `c2-zc-typed-journey:${randomUUID()}`;
  const claimed = await harness.invokeOk(
    page,
    "narrative_extraction_claim_task",
    {
      payload: {
        runId,
        projectId,
        leaseOwner,
        leaseDurationSecs: 60,
        taskKinds: ["c2-zc-typed-application"],
      },
      workspaceBinding,
    },
  );
  if (
    claimed?.claimed !== true ||
    claimed.task?.taskId !== taskId ||
    typeof claimed.task?.attemptId !== "string"
  ) {
    throw new Error(
      `C2-ZC typed Application Task was not claimed: ${JSON.stringify(claimed)}`,
    );
  }
  const attemptId = claimed.task.attemptId;
  const proposalSetId = `${runId}-proposal-set`;
  const proposalId = `${runId}-proposal`;
  const entryId = `${runId}-entry`;
  const entryPayload = {
    entryId,
    typeSlug: "character",
    name: "C2-ZC canonical lifecycle entry",
    summary: "Typed mutation after marker",
    aliases: [],
    parentId: null,
    content: '{"type":"doc","content":[]}',
    narrativeEntityId: `${runId}-entity`,
  };
  const readSet = [
    {
      inputRef: `snapshot:${runId}`,
      kind: "snapshot-document",
      sourceKind: "snapshot-document",
      revisionToken: snapshotDigest,
    },
  ];
  const revisionEnvelope = {
    schemaVersion: 1,
    runId,
    taskId,
    reconcilerId: "c2-zc-canonical-lifecycle",
    reconcilerVersion: "1",
    proposalSchemaId: "codex.entry.create",
    proposalSchemaVersion: "1",
    sourceBasis: [
      {
        sourceKind: "snapshot-document",
        sourceKey: `snapshot:${runId}`,
        revisionToken: snapshotDigest,
      },
    ],
    evidenceSet: [],
    readSet,
    readSetDigest: stablePayloadDigest(readSet),
    changeKind: "add",
  };
  const savedSet = await harness.invokeOk(
    page,
    "narrative_extraction_save_proposal_set",
    {
      payload: {
        runId,
        projectId,
        proposalSetId,
        setKind: "c2-zc.canonical-lifecycle@1",
        summaryJson: { kind: "c2-zc-typed-application@1" },
        proposals: [
          {
            proposalId,
            proposalKey: `${runId}:entry-create`,
            kind: "codex.entry.create",
            payloadJson: entryPayload,
            reconciliationEnvelope: revisionEnvelope,
          },
        ],
      },
      workspaceBinding,
    },
  );
  const savedProposal = savedSet?.proposals?.[0];
  if (
    savedSet?.proposalSetId !== proposalSetId ||
    savedProposal?.proposalId !== proposalId ||
    typeof savedProposal?.revisionId !== "string"
  ) {
    throw new Error(
      `C2-ZC typed ProposalSet was not persisted: ${JSON.stringify(savedSet)}`,
    );
  }
  const revisionId = savedProposal.revisionId;
  await harness.invokeOk(page, "narrative_extraction_append_human_decision", {
    payload: {
      runId,
      projectId,
      proposalId,
      revisionId,
      decision: "approved",
      decisionJson: {},
      createdBy: "c2-zc-product-journey",
    },
  });
  const requestId = `${runId}-apply-request`;
  const prepared = await harness.invokeOk(
    page,
    "narrative_extraction_prepare_commit",
    {
      payload: {
        projectId,
        runId,
        proposalSetId,
        requestId,
        planDigest: stablePayloadDigest({ runId, proposalId, revisionId }),
        sessionId: C2ZC_PRODUCT_JOURNEY_ID,
        surface: "narrative-extraction",
        operations: [
          {
            kind: "codex.entry.create",
            payload: entryPayload,
            proposalId,
            revisionId,
          },
        ],
        applications: [{ proposalId, revisionId }],
        expectedTailOrdinal: null,
        entityBindings: [],
        expectedCalendarVersion: null,
      },
    },
  );
  if (typeof prepared?.preparedCommitId !== "string") {
    throw new Error(
      `C2-ZC typed Commit was not prepared: ${JSON.stringify(prepared)}`,
    );
  }
  const applied = await harness.invokeOk(
    page,
    "narrative_extraction_apply_commit",
    {
      payload: {
        projectId,
        preparedCommitId: prepared.preparedCommitId,
        requestId,
        sessionId: C2ZC_PRODUCT_JOURNEY_ID,
        expectedVersion: prepared.version ?? 0,
      },
    },
  );
  const commitId = applied?.commitId ?? applied?.id;
  if (typeof commitId !== "string" || commitId.trim() === "") {
    throw new Error(
      `C2-ZC typed Commit did not apply: ${JSON.stringify(applied)}`,
    );
  }
  const applicationRows = await queryRows(
    harness,
    page,
    `SELECT id AS applicationId
       FROM narrative_proposal_applications
      WHERE commit_id = ?
      ORDER BY id`,
    [commitId],
  );
  if (applicationRows.length !== 1) {
    throw new Error(
      `C2-ZC typed Commit did not create one Application: ${JSON.stringify(applicationRows)}`,
    );
  }
  const applicationId = applicationRows[0].applicationId;
  const finished = await harness.invokeOk(
    page,
    "narrative_extraction_finish_task",
    {
      payload: {
        runId,
        projectId,
        taskId,
        attemptId,
        leaseOwner,
        outputJson: {
          kind: "c2-zc-typed-application-completed@1",
          commitId,
          applicationId,
        },
      },
      workspaceBinding,
    },
  );
  if (
    finished?.status !== "completed" ||
    finished.task?.status !== "completed"
  ) {
    throw new Error(
      `C2-ZC typed Application Task did not finish: ${JSON.stringify(finished)}`,
    );
  }
  return {
    projectId,
    runId,
    taskId,
    attemptId,
    proposalSetId,
    proposalId,
    revisionId,
    entryId,
    commitId,
    applicationId,
  };
}

async function waitForProjectId(
  harness,
  page,
  expectedProjectId,
  { requireExpected = false } = {},
) {
  return harness.waitUntil(
    async () => {
      const projects = await queryRows(
        harness,
        page,
        "SELECT id AS projectId FROM projects ORDER BY id",
      );
      const match = projects.find((row) => row.projectId === expectedProjectId);
      if (requireExpected && !match) return null;
      return match?.projectId ?? projects[0]?.projectId ?? null;
    },
    "C2-ZC restored project hydration",
    C2ZC_WAIT_MS,
    250,
  );
}

async function waitForLifecycle(
  harness,
  page,
  projectId,
  { restoreEpochId, rustOutcome } = {},
) {
  return harness.waitUntil(
    async () => {
      const snapshot = await readC2ZcAuthoritySnapshot(
        harness,
        page,
        projectId,
      );
      try {
        const lifecycle = assertC2ZcRestoreLifecycleOrder(snapshot.runs, {
          currentEpochId: snapshot.currentEpochId,
          restoreEpochId,
          rustOutcome,
        });
        assertC2ZcMarkerExactlyOnce(snapshot);
        assertC2ZcFindingInboxEmpty(snapshot);
        assertC2ZcGenericRowsComplete(snapshot);
        assertC2ZcFeedCursorSettled(snapshot, {
          epochId: snapshot.currentEpochId,
        });
        return { snapshot, lifecycle };
      } catch {
        return null;
      }
    },
    "C2-ZC canonical restore lifecycle settlement",
    C2ZC_WAIT_MS,
    250,
  );
}

async function closeLaunch(harness, launch, reason) {
  if (!launch) return;
  await harness.close(launch.app, launch.page, reason);
}

/**
 * Run the complete stateful lifecycle.  `options.restoreFixture` is the
 * narrow programmatic injection; `GRIMODEX_C2ZC_RESTORE_FIXTURE` carries the
 * same `{path, manifest}` object for the product runner.
 */
export async function runC2ZcCanonicalAuthorityJourney(
  harness,
  configureWorkspace,
  options = {},
) {
  const fixture = await loadC2ZcRestoreFixtureInput(options.restoreFixture);
  const rustOutcome = options.rustOutcome;
  const rustAcceptance =
    options.candidate ??
    harness.c2zcRustAcceptanceEvidence?.candidate ??
    harness.c2zcRustAcceptanceEvidence?.receipt?.candidate;
  assertC2ZcFixtureCandidateBinding(fixture.manifest.candidate, rustAcceptance);
  const workspace = harness.workspacePath(C2ZC_PRODUCT_JOURNEY_ID);
  await configureWorkspace(harness, workspace);
  const staged = await stageC2ZcRestoreFixture(workspace, fixture);
  harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`, {
    backupName: fixture.manifest.artifacts.fixture.path,
    manifestVersion: fixture.manifest.manifestVersion,
    fixtureSha256: fixture.manifest.fixtureSha256,
    fixtureSizeBytes: fixture.manifest.fixtureSizeBytes,
    stagedPath: staged.targetPath,
  });

  let restoreLaunch = null;
  let projectId = fixture.manifest.semantic.projectId;
  let restoredSnapshot;
  try {
    restoreLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/restore`);
    projectId = await waitForProjectId(harness, restoreLaunch.page, projectId);
    const beforeRestore = await readC2ZcAuthoritySnapshot(
      harness,
      restoreLaunch.page,
      projectId,
    );
    await restoreBackupThroughSettingsUi(
      { page: restoreLaunch.page, harness },
      fixture.manifest.artifacts.fixture.path,
    );
    projectId = await waitForProjectId(
      harness,
      restoreLaunch.page,
      fixture.manifest.semantic.projectId,
      { requireExpected: true },
    );
    restoredSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restoreLaunch.page,
          projectId,
        );
        try {
          restoredEpoch(snapshot.epochs, "C2-ZC restored Settings UI image");
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC restored E1 observation",
      C2ZC_WAIT_MS,
      250,
    );
    restoredEpoch(restoredSnapshot.epochs, "C2-ZC restored Settings UI image");
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restore`, {
      projectId,
      beforeRunCount: beforeRestore.runs.length,
      restoredEpoch: restoredSnapshot.currentEpochId,
      restoreObservedThrough: "production-settings-ui",
    });
  } finally {
    await closeLaunch(
      harness,
      restoreLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
    );
  }

  let openLaunch = null;
  let openSnapshot;
  let lifecycle;
  try {
    openLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/open`);
    projectId = await waitForProjectId(harness, openLaunch.page, projectId);
    const settled = await waitForLifecycle(
      harness,
      openLaunch.page,
      projectId,
      {
        restoreEpochId: restoredSnapshot.currentEpochId,
        rustOutcome,
      },
    );
    openSnapshot = settled.snapshot;
    lifecycle = settled.lifecycle;
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/open`, {
      projectId,
      verifyRunIds: [lifecycle.firstVerify.id, lifecycle.finalVerify.id],
      rebuildRunId: lifecycle.rebuild?.id ?? null,
      freshnessRunId: lifecycle.freshness.id,
      markerCount: openSnapshot.markerRows.length,
    });
  } finally {
    await closeLaunch(harness, openLaunch, `${C2ZC_PRODUCT_JOURNEY_ID}/open`);
  }

  let restartLaunch = null;
  let firstRestartSnapshot;
  let afterTypedWrite;
  let application;
  try {
    restartLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/restart`);
    projectId = await waitForProjectId(harness, restartLaunch.page, projectId);
    firstRestartSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restartLaunch.page,
          projectId,
        );
        try {
          assertC2ZcMarkerExactlyOnce(snapshot);
          assertC2ZcRestartInvariants({
            before: openSnapshot,
            restart: snapshot,
          });
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC first restart authority invariants",
      C2ZC_WAIT_MS,
      250,
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restart`, {
      projectId,
      markerCount: firstRestartSnapshot.markerRows.length,
      epochCount: firstRestartSnapshot.epochs.length,
    });
    application = await createTypedApplicationAfterMarker(
      harness,
      restartLaunch.page,
      workspace,
      projectId,
    );
    afterTypedWrite = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          restartLaunch.page,
          projectId,
        );
        try {
          assertC2ZcGenericFreshnessStorage(snapshot, {
            projectId,
            applicationId: application.applicationId,
            epochId: snapshot.currentEpochId,
          });
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC typed write Generic storage",
      C2ZC_WAIT_MS,
      250,
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`, {
      projectId,
      applicationId: application.applicationId,
      producerRunId: application.runId,
    });
  } finally {
    await closeLaunch(
      harness,
      restartLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`,
    );
  }

  let finalLaunch = null;
  let finalSnapshot;
  try {
    finalLaunch = await harness.launch(
      `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
    );
    projectId = await waitForProjectId(harness, finalLaunch.page, projectId);
    finalSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readC2ZcAuthoritySnapshot(
          harness,
          finalLaunch.page,
          projectId,
        );
        try {
          assertC2ZcFinalRestartPersistence({
            before: afterTypedWrite,
            restart: snapshot,
            application,
          });
          return snapshot;
        } catch {
          return null;
        }
      },
      "C2-ZC final restart persistence",
      C2ZC_WAIT_MS,
      250,
    );
    harness.recordTimeline?.(`${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`, {
      projectId,
      markerCount: finalSnapshot.markerRows.length,
      applicationId: application.applicationId,
      noLegacyFallback: C2ZC_CANONICAL_FRESHNESS_CONTRACT.noLegacyFallback,
    });
  } finally {
    await closeLaunch(
      harness,
      finalLaunch,
      `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
    );
  }

  return {
    journeyId: C2ZC_PRODUCT_JOURNEY_ID,
    projectId,
    restoreFixture: {
      backupName: fixture.manifest.artifacts.fixture.path,
      manifestVersion: fixture.manifest.manifestVersion,
      manifestPath: fixture.manifestPath,
      fixtureSha256: fixture.manifest.fixtureSha256,
      fixtureSizeBytes: fixture.manifest.fixtureSizeBytes,
      stagedPath: staged.targetPath,
    },
    lifecycle: {
      verifyRunIds: [lifecycle.firstVerify.id, lifecycle.finalVerify.id],
      rebuildRunId: lifecycle.rebuild?.id ?? null,
      freshnessRunId: lifecycle.freshness.id,
    },
    markerCount: finalSnapshot.markerRows.length,
    application,
  };
}
