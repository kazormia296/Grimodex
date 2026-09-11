#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { rootDir } from "./build.mjs";
import { createChronicleExtractionJourney } from "./chronicle-extraction-product-journey.mjs";
import {
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "./product-journey-catalog.mjs";
import {
  PRODUCT_JOURNEYS,
  assertBuildArtifacts,
  assertC2ZcProductJourneyFixtureSummary,
  assertProductJourneyArtifactEvidence,
  assertProductJourneySelectionBinding,
  configureWorkspace,
  readC2ZcProductJourneyFixtureEvidence,
  readC2ZcRustAcceptanceEvidence,
  readProductJourneyBuildReceipt,
  refreshProductJourneyOutcome,
  resolveProductJourneyArtifact,
  runProductJourneys,
} from "./product-journeys.mjs";

const IDS = PRODUCT_JOURNEY_CATALOG.map(({ id }) => id);
const ARTIFACT_DIR_ENV = "GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR";
const DIGEST_ENV = "GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST";
const CHRONICLE_ID = "chronicle-extract-review-apply-reopen";
const REPORT_FIELDS = [
  "status",
  "catalogDigest",
  "journeyIds",
  "requiredJourneyIds",
  "allPassed",
  "allClean",
  "acceptanceRequired",
  "rustAcceptanceComplete",
  "buildReceipt",
  "acceptanceComplete",
  "c2zcRustAcceptance",
  "c2zcRestoreFixture",
];

if (
  IDS.length !== 27 ||
  PRODUCT_JOURNEY_CATALOG.some(
    (entry) =>
      entry.required === false || entry.acceptanceRole === "diagnostic",
  )
)
  throw new Error("fixed product journey shards need rebalancing");

export const FIXED_PRODUCT_JOURNEY_SHARDS = Object.freeze([
  Object.freeze([
    "editor-persistence",
    "chat-stream-workspace-switch",
    "lint-native-roundtrip",
    "snapshot-native-roundtrip",
    "c2-5b-restore-verify-rebuild-verify",
    "c2-5b-rule-digest-no-skip",
    "c2-5b-transient-bounded-retry",
    "c2-zc-canonical-authority-cutover",
    "c2-zc-renderer-mcp-dml-denial",
  ]),
  Object.freeze([
    "chat-stream-project-switch",
    "editor-pending-project-switch",
    "mcp-external-write-conflict",
    "map-native-roundtrip",
    "chronicle-extract-review-apply-reopen",
    "c2-5b-schema-backfill-verify",
    "c2-5b-producer-generation-no-skip",
    "c2-5b-interrupted-run-recovery",
    "c2-5b-incremental-liveness",
  ]),
  Object.freeze([
    "chat-authority-isolation",
    "workspace-switch-authority",
    "external-write-conflict",
    "cross-feature-authoring",
    "chronicle-native-roundtrip",
    "c2-5b-graph-digest-no-skip",
    "c2-5b-terminal-failure-inbox",
    "c2-5b-no-automatic-repair",
    "c2-5b-foreground-write-workspace-wake",
  ]),
]);

const acceptanceJourneyIds = new Set(
  PRODUCT_JOURNEY_CATALOG.filter(
    ({ acceptanceRole }) => acceptanceRole !== undefined,
  ).map(({ id }) => id),
);
const fixedIds = FIXED_PRODUCT_JOURNEY_SHARDS.flat();
const acceptanceShardNumbers = FIXED_PRODUCT_JOURNEY_SHARDS.flatMap(
  (ids, index) =>
    ids.some((id) => acceptanceJourneyIds.has(id)) ? [index + 1] : [],
);
if (
  FIXED_PRODUCT_JOURNEY_SHARDS.length !== 3 ||
  FIXED_PRODUCT_JOURNEY_SHARDS.some(
    (ids) =>
      ids.length !== 9 ||
      !isDeepStrictEqual(
        ids,
        IDS.filter((id) => ids.includes(id)),
      ),
  ) ||
  fixedIds.length !== IDS.length ||
  new Set(fixedIds).size !== IDS.length ||
  fixedIds.some((id) => !IDS.includes(id)) ||
  IDS.some((id) => !fixedIds.includes(id)) ||
  acceptanceJourneyIds.size === 0 ||
  acceptanceShardNumbers.length !== 1
) {
  throw new Error("fixed product journey shards need rebalancing");
}
const ACCEPTANCE_SHARD_NUMBER = acceptanceShardNumbers[0];

function same(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(`${label} is invalid`);
}

function resolveOutput(value, root) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("product journey shard output directory is required");
  }
  const repository = path.resolve(root);
  const output = path.resolve(repository, value);
  const relative = path.relative(repository, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(
      "product journey shard output must stay below the repository root",
    );
  }
  return output;
}

function shardDirectory(output, number) {
  return path.join(output, `shard-${number}`);
}

function assertCanonical(environment) {
  if (environment.GRIMODEX_PRODUCT_JOURNEY_IDS) {
    throw new Error("fixed shards reject arbitrary product journey IDs");
  }
  if (environment.GRIMODEX_PRODUCT_JOURNEY_SET) {
    throw new Error("fixed shards reject alternate product journey sets");
  }
  if (
    environment[DIGEST_ENV] &&
    environment[DIGEST_ENV] !== PRODUCT_JOURNEY_CATALOG_DIGEST
  ) {
    throw new Error("fixed product journey catalog digest mismatch");
  }
}

/** Run one fixed partition in this process and its own artifact directory. */
export async function runFixedProductJourneyShard({
  shard,
  outputDirectory,
  root = rootDir,
  environment = process.env,
  runJourneys = runProductJourneys,
} = {}) {
  assertCanonical(environment);
  const number = Number(shard);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > FIXED_PRODUCT_JOURNEY_SHARDS.length
  ) {
    throw new Error("fixed product journey shard must be 1, 2, or 3");
  }
  const artifactDirectory = shardDirectory(
    resolveOutput(outputDirectory, root),
    number,
  );
  const ids = FIXED_PRODUCT_JOURNEY_SHARDS[number - 1];
  const selected = new Set(ids);
  const journeys = PRODUCT_JOURNEYS.filter(({ id }) => selected.has(id)).map(
    (journey) =>
      journey.id === CHRONICLE_ID
        ? createChronicleExtractionJourney({
            configureWorkspace,
            evidenceDirectory: artifactDirectory,
          })
        : journey,
  );
  same(
    journeys.map(({ id }) => id),
    [...ids],
    `fixed shard ${number} runner selection`,
  );
  return runJourneys({
    artifactJourneys: PRODUCT_JOURNEYS,
    catalog: PRODUCT_JOURNEY_CATALOG,
    environment: { ...environment, [ARTIFACT_DIR_ENV]: artifactDirectory },
    expectedCatalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    journeys,
    requireAll: false,
    requiredJourneyIds: [...ids],
    resultsPath: path.join(artifactDirectory, "results.json"),
    root,
    selectionName: `fixed-shard-${number}`,
  });
}

async function readShard(output, number) {
  const resultsPath = path.join(shardDirectory(output, number), "results.json");
  const manifestPath = path.join(
    shardDirectory(output, number),
    "manifest.json",
  );
  const [resultsBytes, manifestBytes] = await Promise.all([
    readFile(resultsPath),
    readFile(manifestPath),
  ]);
  return {
    number,
    report: JSON.parse(resultsBytes),
    manifest: JSON.parse(manifestBytes),
    resultsBytes,
    resultsPath,
  };
}

function assertExactUnion(shards) {
  const ids = shards.flatMap(({ report }) => report.journeyIds ?? []);
  const duplicates = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  ];
  if (duplicates.length)
    throw new Error(`duplicate product journey IDs: ${duplicates.join(", ")}`);
  const known = new Set(IDS);
  const extras = ids.filter((id) => !known.has(id));
  if (extras.length)
    throw new Error(`extra product journey IDs: ${extras.join(", ")}`);
  const observed = new Set(ids);
  const missing = IDS.filter((id) => !observed.has(id));
  if (missing.length)
    throw new Error(`missing product journey IDs: ${missing.join(", ")}`);
}

async function assertShard(
  shard,
  { artifacts, buildReceipt, rustAcceptance, fixture },
) {
  const { number, report, manifest, resultsBytes, resultsPath } = shard;
  const ids = [...FIXED_PRODUCT_JOURNEY_SHARDS[number - 1]];
  same(report.catalogJourneyIds, IDS, `fixed shard ${number} catalog order`);
  same(report.journeyIds, ids, `fixed shard ${number} partition`);
  same(report.requiredJourneyIds, ids, `fixed shard ${number} required IDs`);
  same(
    report.selectionBinding,
    {
      catalogJourneyIds: IDS,
      journeyIds: ids,
      requireAll: false,
      selectionName: `fixed-shard-${number}`,
      complete: false,
    },
    `fixed shard ${number} selection binding`,
  );
  same(
    report.journeys?.map(({ id }) => id),
    ids,
    `fixed shard ${number} result order`,
  );
  const c2 = number === ACCEPTANCE_SHARD_NUMBER;
  const refreshed = refreshProductJourneyOutcome(structuredClone(report));
  if (
    report.version !== 5 ||
    report.status !== "passed" ||
    report.catalogDigest !== PRODUCT_JOURNEY_CATALOG_DIGEST ||
    report.acceptanceRequired !== c2 ||
    !isDeepStrictEqual(report.buildReceipt, buildReceipt) ||
    (c2 && !isDeepStrictEqual(report.c2zcRustAcceptance, rustAcceptance)) ||
    (!c2 && report.c2zcRestoreFixture !== null) ||
    "error" in report ||
    "auditManifestError" in report ||
    report.journeys.some(
      (result) =>
        result.status !== "passed" ||
        result.cleanPass !== true ||
        "error" in result ||
        "cleanupError" in result,
    ) ||
    !refreshed.allClean ||
    refreshed.acceptanceComplete !== c2
  ) {
    throw new Error(`fixed shard ${number} is not clean or correctly bound`);
  }
  if (c2) {
    assertC2ZcProductJourneyFixtureSummary(
      report.c2zcRestoreFixture,
      fixture,
      `fixed shard ${number} C2 fixture`,
    );
  }
  if (manifest.version !== 1)
    throw new Error(`fixed shard ${number} manifest version is invalid`);
  for (const field of REPORT_FIELDS) {
    same(
      manifest[field],
      report[field],
      `fixed shard ${number} manifest ${field}`,
    );
  }
  if (
    manifest.results?.path !== "results.json" ||
    manifest.results?.realPath !== (await realpath(resultsPath)) ||
    manifest.results?.sha256 !==
      `sha256:${createHash("sha256").update(resultsBytes).digest("hex")}`
  ) {
    throw new Error(`fixed shard ${number} manifest results hash is invalid`);
  }
  assertProductJourneyArtifactEvidence(
    manifest.artifacts,
    artifacts,
    `fixed shard ${number} manifest artifacts`,
  );
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function publish(output, report, artifacts, root) {
  const resultsPath = path.join(output, "results.json");
  await atomicJson(resultsPath, report);
  const results = await resolveProductJourneyArtifact(resultsPath, { root });
  await atomicJson(path.join(output, "manifest.json"), {
    version: 1,
    ...Object.fromEntries(REPORT_FIELDS.map((field) => [field, report[field]])),
    results: {
      path: "results.json",
      realPath: results.realPath,
      sha256: results.sha256,
    },
    artifacts,
  });
}

/** Merge three fixed shard reports into the unchanged canonical v5 contract. */
export async function aggregateProductJourneyShards({
  outputDirectory,
  root = rootDir,
  environment = process.env,
  assertArtifacts = assertBuildArtifacts,
  readBuildReceipt = readProductJourneyBuildReceipt,
  readRustAcceptance = readC2ZcRustAcceptanceEvidence,
  readFixtureEvidence = readC2ZcProductJourneyFixtureEvidence,
} = {}) {
  assertCanonical(environment);
  const output = resolveOutput(outputDirectory, root);
  const shards = await Promise.all(
    FIXED_PRODUCT_JOURNEY_SHARDS.map((_, index) =>
      readShard(output, index + 1),
    ),
  );
  assertExactUnion(shards);
  const { artifacts } = await assertArtifacts(PRODUCT_JOURNEYS, {
    catalog: PRODUCT_JOURNEY_CATALOG,
    root,
    env: environment,
  });
  const buildReceipt = readBuildReceipt(environment);
  const rustAcceptance = await readRustAcceptance({
    required: true,
    root,
    environment,
  });
  const fixture = await readFixtureEvidence({
    root,
    environment,
    candidate: rustAcceptance?.candidate ?? null,
  });
  if (!Array.isArray(artifacts) || !buildReceipt || !fixture) {
    throw new Error("aggregate build artifacts or receipt are missing");
  }
  assertProductJourneyArtifactEvidence(
    buildReceipt.artifacts,
    artifacts,
    "aggregate build receipt artifacts",
  );
  const liveEvidence = { artifacts, buildReceipt, rustAcceptance, fixture };
  for (const shard of shards) await assertShard(shard, liveEvidence);

  const acceptanceReport = shards[ACCEPTANCE_SHARD_NUMBER - 1].report;
  const byId = new Map(
    shards.flatMap(({ report }) => report.journeys).map((row) => [row.id, row]),
  );
  const report = {
    ...acceptanceReport,
    catalogJourneyIds: IDS,
    journeyIds: IDS,
    requiredJourneyIds: IDS,
    buildReceipt,
    c2zcRustAcceptance: rustAcceptance,
    c2zcRestoreFixture: fixture,
    acceptanceComplete: false,
    selectionBinding: assertProductJourneySelectionBinding({
      catalog: PRODUCT_JOURNEY_CATALOG,
      journeys: PRODUCT_JOURNEYS,
      requireAll: true,
      selectionName: "",
    }),
    allPassed: false,
    allClean: false,
    journeys: IDS.map((id) => byId.get(id)),
  };
  refreshProductJourneyOutcome(report);
  if (!report.allPassed || !report.allClean || !report.acceptanceComplete) {
    throw new Error(
      "fixed product journey aggregate is not complete and clean",
    );
  }
  await publish(output, report, artifacts, root);
  return report;
}

function parseCli(args) {
  if (
    args[0] === "run" &&
    args.length === 5 &&
    args[1] === "--shard" &&
    args[3] === "--output-dir"
  ) {
    return { action: "run", shard: args[2], outputDirectory: args[4] };
  }
  if (
    args[0] === "aggregate" &&
    args.length === 3 &&
    args[1] === "--output-dir"
  ) {
    return { action: "aggregate", outputDirectory: args[2] };
  }
  throw new Error(
    "usage: product-journey-shards.mjs run --shard 1|2|3 --output-dir DIR; or aggregate --output-dir DIR",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[electron:product-shards] FAIL: ${error.message}`);
    process.exitCode = 1;
  }
  if (options) {
    const operation =
      options.action === "run"
        ? runFixedProductJourneyShard(options)
        : aggregateProductJourneyShards(options);
    operation.then(
      () => console.log(`[electron:product-shards] ${options.action}: PASS`),
      (error) => {
        console.error(
          `[electron:product-shards] FAIL: ${error?.stack ?? error}`,
        );
        process.exitCode = 1;
      },
    );
  }
}
