import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "./product-journey-catalog.mjs";
import {
  FIXED_PRODUCT_JOURNEY_SHARDS,
  aggregateProductJourneyShards,
  runFixedProductJourneyShard,
} from "./product-journey-shards.mjs";

const catalogIds = PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id);
const acceptanceJourneyIds = new Set(
  PRODUCT_JOURNEY_CATALOG.filter(
    (journey) => journey.acceptanceRole !== undefined,
  ).map((journey) => journey.id),
);

function shardRequiresAcceptance(shardNumber) {
  return FIXED_PRODUCT_JOURNEY_SHARDS[shardNumber - 1].some((id) =>
    acceptanceJourneyIds.has(id),
  );
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function candidate() {
  return {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  };
}

function fixtureSummary() {
  return {
    manifestVersion: 1,
    manifestSha256: `sha256:${"1".repeat(64)}`,
    fixtureSha256: `sha256:${"2".repeat(64)}`,
    fixtureSizeBytes: 123,
    semanticContentsDigest: `sha256:${"3".repeat(64)}`,
    contractVersion: 1,
    builderVersion: "test-builder-v1",
    candidateHeadSha: "b".repeat(40),
    candidateTreeSha: "c".repeat(40),
    candidateStatusSha256: `sha256:${"e".repeat(64)}`,
  };
}

async function writeShard(directory, shardNumber, bindings, mutate = () => {}) {
  await mkdir(directory, { recursive: true });
  const ids = [...FIXED_PRODUCT_JOURNEY_SHARDS[shardNumber - 1]];
  const acceptanceRequired = shardRequiresAcceptance(shardNumber);
  const report = {
    version: 5,
    status: "passed",
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    catalogJourneyIds: catalogIds,
    journeyIds: [...ids],
    requiredJourneyIds: [...ids],
    acceptanceRequired,
    rustAcceptanceComplete: true,
    buildReceipt: bindings.buildReceipt,
    acceptanceComplete: acceptanceRequired,
    c2zcRustAcceptance: acceptanceRequired
      ? bindings.rustAcceptance
      : { required: false, verified: false, reason: "not-required" },
    c2zcRestoreFixture: acceptanceRequired ? bindings.fixture : null,
    selectionBinding: {
      catalogJourneyIds: catalogIds,
      journeyIds: [...ids],
      requireAll: false,
      selectionName: `fixed-shard-${shardNumber}`,
      complete: false,
    },
    allPassed: true,
    allClean: true,
    journeys: ids.map((id, index) => ({
      id,
      status: "passed",
      durationMs: index + 1,
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 0,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    })),
  };
  mutate(report);
  const resultsPath = path.join(directory, "results.json");
  const resultsText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(resultsPath, resultsText, "utf8");
  const manifest = {
    version: 1,
    status: report.status,
    catalogDigest: report.catalogDigest,
    journeyIds: [...report.journeyIds],
    requiredJourneyIds: [...report.requiredJourneyIds],
    allPassed: report.allPassed,
    allClean: report.allClean,
    acceptanceRequired: report.acceptanceRequired,
    rustAcceptanceComplete: report.rustAcceptanceComplete,
    buildReceipt: report.buildReceipt,
    acceptanceComplete: report.acceptanceComplete,
    c2zcRustAcceptance: report.c2zcRustAcceptance,
    c2zcRestoreFixture: report.c2zcRestoreFixture,
    results: {
      path: "results.json",
      realPath: resultsPath,
      sha256: sha256(resultsText),
    },
    artifacts: bindings.artifacts,
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { manifest, report };
}

async function setupAggregateFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-shards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, "main.cjs");
  await writeFile(artifactPath, "main", "utf8");
  const artifacts = [
    {
      name: "Electron main",
      path: artifactPath,
      requestedPath: artifactPath,
      realPath: artifactPath,
      size: 4,
      sha256: sha256("main"),
    },
  ];
  const boundCandidate = candidate();
  const buildReceipt = {
    version: 1,
    verified: true,
    source: "local-ci-candidate",
    candidate: boundCandidate,
    artifacts,
  };
  const verifyOutcome = { verifyContractVersion: 1, status: "passed" };
  const rustAcceptance = {
    required: true,
    verified: true,
    receiptPath: path.join(root, "rust-receipt.json"),
    receiptSha256: `sha256:${"4".repeat(64)}`,
    candidate: boundCandidate,
    gates: [],
    verifyOutcome,
    receipt: { candidate: boundCandidate, verifyOutcome },
  };
  const fixture = fixtureSummary();
  const bindings = {
    artifacts,
    buildReceipt,
    fixture,
    rustAcceptance,
  };
  const outputDirectory = path.join(root, "product-journeys");
  const shardDirectories = FIXED_PRODUCT_JOURNEY_SHARDS.map((_, index) =>
    path.join(outputDirectory, `shard-${index + 1}`),
  );
  await Promise.all(
    shardDirectories.map((directory, index) =>
      writeShard(directory, index + 1, bindings),
    ),
  );
  const dependencies = {
    assertArtifacts: async () => ({ artifacts }),
    readBuildReceipt: () => buildReceipt,
    readFixtureEvidence: async () => fixture,
    readRustAcceptance: async () => rustAcceptance,
  };
  return { bindings, dependencies, outputDirectory, root, shardDirectories };
}

test("fixed shards are disjoint and preserve catalog order within all 28 entries", () => {
  assert.deepEqual(
    FIXED_PRODUCT_JOURNEY_SHARDS.map((ids) => ids.length),
    [10, 9, 9],
  );
  assert.deepEqual(FIXED_PRODUCT_JOURNEY_SHARDS, [
    [
      "chat-stream-workspace-switch",
      "lint-native-roundtrip",
      "snapshot-native-roundtrip",
      "chronicle-extract-review-apply-reopen",
      "codex-entity-relation-review-apply-reopen",
      "c2-5b-producer-generation-no-skip",
      "c2-5b-interrupted-run-recovery",
      "c2-5b-foreground-write-workspace-wake",
      "c2-zc-canonical-authority-cutover",
      "c2-zc-renderer-mcp-dml-denial",
    ],
    [
      "cross-feature-authoring",
      "chat-stream-project-switch",
      "editor-pending-project-switch",
      "mcp-external-write-conflict",
      "map-native-roundtrip",
      "c2-5b-schema-backfill-verify",
      "c2-5b-graph-digest-no-skip",
      "c2-5b-rule-digest-no-skip",
      "c2-5b-terminal-failure-inbox",
    ],
    [
      "editor-persistence",
      "chat-authority-isolation",
      "workspace-switch-authority",
      "external-write-conflict",
      "chronicle-native-roundtrip",
      "c2-5b-restore-verify-rebuild-verify",
      "c2-5b-transient-bounded-retry",
      "c2-5b-no-automatic-repair",
      "c2-5b-incremental-liveness",
    ],
  ]);
  assert.equal(new Set(FIXED_PRODUCT_JOURNEY_SHARDS.flat()).size, 28);
  assert.deepEqual(
    new Set(FIXED_PRODUCT_JOURNEY_SHARDS.flat()),
    new Set(catalogIds),
  );
  const catalogIndex = new Map(catalogIds.map((id, index) => [id, index]));
  for (const shard of FIXED_PRODUCT_JOURNEY_SHARDS) {
    const positions = shard.map((id) => catalogIndex.get(id));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
  }
  assert.deepEqual(
    FIXED_PRODUCT_JOURNEY_SHARDS.flatMap((ids, index) =>
      ids.some((id) => acceptanceJourneyIds.has(id)) ? [index + 1] : [],
    ),
    [1],
  );
});

test("fixed shard runner binds its partition and private artifact directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-shard-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let received;
  const marker = {};
  const result = await runFixedProductJourneyShard({
    shard: 3,
    outputDirectory: "artifacts/product-journeys",
    root,
    environment: { GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL: "true" },
    runJourneys: async (options) => {
      received = options;
      return marker;
    },
  });
  const shardDirectory = path.join(root, "artifacts/product-journeys/shard-3");

  assert.equal(result, marker);
  assert.deepEqual(
    received.journeys.map(({ id }) => id),
    FIXED_PRODUCT_JOURNEY_SHARDS[2],
  );
  assert.equal(received.artifactJourneys.length, 28);
  assert.deepEqual(
    received.requiredJourneyIds,
    FIXED_PRODUCT_JOURNEY_SHARDS[2],
  );
  assert.equal(received.requireAll, false);
  assert.equal(received.selectionName, "fixed-shard-3");
  assert.equal(received.resultsPath, path.join(shardDirectory, "results.json"));
  assert.equal(
    received.environment.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR,
    shardDirectory,
  );
});

test("aggregate accepts three clean bound shards and writes the canonical v5 result and v1 manifest", async (t) => {
  const fixture = await setupAggregateFixture(t);
  const report = await aggregateProductJourneyShards({
    ...fixture,
    ...fixture.dependencies,
    environment: {},
  });

  assert.equal(report.version, 5);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.journeyIds, catalogIds);
  assert.deepEqual(
    report.journeys.map((journey) => journey.id),
    catalogIds,
  );
  assert.equal(report.allPassed, true);
  assert.equal(report.allClean, true);
  assert.equal(report.acceptanceComplete, true);

  const resultsPath = path.join(fixture.outputDirectory, "results.json");
  const manifest = JSON.parse(
    await readFile(path.join(fixture.outputDirectory, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.journeyIds, catalogIds);
  assert.equal(manifest.results.path, "results.json");
  assert.equal(manifest.results.realPath, resultsPath);
  assert.equal(manifest.results.sha256, sha256(await readFile(resultsPath)));
  assert.deepEqual(manifest.artifacts, fixture.bindings.artifacts);
});

test("aggregate rejects missing, duplicate, extra, unclean, and unbound shard evidence", async (t) => {
  const cases = [
    {
      name: "missing ID",
      mutate: (report) => {
        report.journeyIds.pop();
        report.requiredJourneyIds.pop();
        report.selectionBinding.journeyIds.pop();
        report.journeys.pop();
      },
      pattern: /missing/i,
    },
    {
      name: "duplicate ID",
      mutate: (report) => {
        const duplicate = FIXED_PRODUCT_JOURNEY_SHARDS[0].at(-1);
        report.journeyIds[0] = duplicate;
        report.requiredJourneyIds[0] = duplicate;
        report.selectionBinding.journeyIds[0] = duplicate;
        report.journeys[0].id = duplicate;
      },
      pattern: /duplicate/i,
    },
    {
      name: "extra ID",
      mutate: (report) => {
        report.journeyIds.push("not-in-catalog");
        report.requiredJourneyIds.push("not-in-catalog");
        report.selectionBinding.journeyIds.push("not-in-catalog");
        report.journeys.push({
          id: "not-in-catalog",
          status: "passed",
          rendererErrorCount: 0,
          pageErrors: [],
          unallowedMainErrors: [],
          mainCleanPass: true,
          cleanPass: true,
        });
      },
      pattern: /extra/i,
    },
    {
      name: "unclean lane",
      mutate: (report) => {
        report.allClean = false;
        report.journeys[0].cleanPass = false;
      },
      pattern: /clean/i,
    },
    {
      name: "selection binding",
      mutate: (report) => {
        report.selectionBinding.selectionName = "forged";
      },
      pattern: /selection/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await setupAggregateFixture(t);
      await writeShard(
        fixture.shardDirectories[1],
        2,
        fixture.bindings,
        scenario.mutate,
      );
      await assert.rejects(
        aggregateProductJourneyShards({
          ...fixture,
          ...fixture.dependencies,
          environment: {},
        }),
        scenario.pattern,
      );
    });
  }

  await t.test("manifest result hash", async (t) => {
    const fixture = await setupAggregateFixture(t);
    const manifestPath = path.join(
      fixture.shardDirectories[0],
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.results.sha256 = `sha256:${"f".repeat(64)}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      aggregateProductJourneyShards({
        ...fixture,
        ...fixture.dependencies,
        environment: {},
      }),
      /hash|digest|sha256/i,
    );
  });
});

test("aggregate rejects shard evidence that does not match live acceptance inputs", async (t) => {
  const reportCases = [
    {
      name: "fabricated Rust receipt",
      shard: 1,
      mutate: (report) => {
        report.c2zcRustAcceptance.receiptSha256 = `sha256:${"f".repeat(64)}`;
      },
    },
    {
      name: "mismatched fixture",
      shard: 1,
      mutate: (report) => {
        report.c2zcRestoreFixture.fixtureSha256 = `sha256:${"f".repeat(64)}`;
      },
    },
    {
      name: "mismatched build receipt",
      shard: 2,
      mutate: (report) => {
        report.buildReceipt.candidate.worktreeFingerprint = "f".repeat(64);
      },
    },
  ];

  for (const scenario of reportCases) {
    await t.test(scenario.name, async (t) => {
      const fixture = await setupAggregateFixture(t);
      await writeShard(
        fixture.shardDirectories[scenario.shard - 1],
        scenario.shard,
        structuredClone(fixture.bindings),
        scenario.mutate,
      );
      await assert.rejects(
        aggregateProductJourneyShards({
          ...fixture,
          ...fixture.dependencies,
          environment: {},
        }),
        /bound|fixture/i,
      );
    });
  }

  await t.test("nonexistent Rust receipt", async (t) => {
    const fixture = await setupAggregateFixture(t);
    await assert.rejects(
      aggregateProductJourneyShards({
        ...fixture,
        ...fixture.dependencies,
        environment: {},
        readRustAcceptance: async () => {
          throw new Error("Rust receipt does not exist");
        },
      }),
      /Rust receipt does not exist/i,
    );
  });

  await t.test("mismatched live artifact", async (t) => {
    const fixture = await setupAggregateFixture(t);
    const manifestPath = path.join(
      fixture.shardDirectories[0],
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts[0].sha256 = `sha256:${"f".repeat(64)}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      aggregateProductJourneyShards({
        ...fixture,
        ...fixture.dependencies,
        environment: {},
      }),
      /artifact|sha256|mismatch/i,
    );
  });
});
