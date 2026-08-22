import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  resolveSelectedProductJourneys,
} from "../electron/scripts/product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_FAULTS,
  NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
  NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER,
  NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER,
  NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  NARRATIVE_MAINTENANCE_TRIGGERS,
  assertForegroundRunMarker,
  assertTerminalFailureEvidence,
  assertTransientAttemptEvidence,
  foregroundMarkedRuns,
  terminalRetryCandidates,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
} from "../electron/scripts/product-journey-catalog.mjs";
import { PRODUCT_JOURNEY_ELECTRON_PHASES } from "../electron/scripts/product-journey-harness.mjs";
import {
  resolveProductJourneyImpactCatalog,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";
import {
  parseImpactMap,
  selectImpact,
} from "./quality/impact-map.mjs";

test("c2-5b runner set is explicit and preserves stable order", () => {
  const selected = resolveProductJourneySet("c2-5b");
  assert.deepEqual(
    selected.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
  );
  assert.equal(selected.length, 11);
});

test("C2-5B fault and trigger seams are closed enums", () => {
  assert.deepEqual(NARRATIVE_MAINTENANCE_FAULTS, [
    "transient-io",
    "contract-violation",
    "process-interruption",
  ]);
  assert.deepEqual(NARRATIVE_MAINTENANCE_TRIGGERS, [
    "dependency-gap",
    "foreground-workspace-wake",
    "graphContractDigest-changed",
    "ruleRegistryDigest-changed",
    "producerGenerationSetDigest-changed",
  ]);
});

test("C2-5B journey seam constants keep exact durable failure contracts", () => {
  assert.equal(NARRATIVE_MAINTENANCE_TRANSIENT_CODE, "NEX_MAINTENANCE_TRANSIENT");
  assert.equal(
    NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
    "NEX_MAINTENANCE_INTERRUPTED",
  );
  assert.equal(NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS, 1_250);
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    "c2-5b-product-journey-owner-v1",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.jsDigestAuthority,
    "durable native outcome skipEvidence fields",
  );
  assert.equal(NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER, "workspace-opened");
  assert.deepEqual(NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER, [
    "trigger",
    "canonicalWorkKey",
    "authorityId",
    "generation",
    "productJourneyBarrierId",
    "correlation",
  ]);
});

test("foreground marker selects one native Run by immutable barrier, not row order", () => {
  const expected = {
    barrierId: "barrier-unique",
    correlation: "correlation-unique",
    trigger: "workspace-opened",
  };
  const unrelatedFreshness = {
    id: "freshness-unrelated",
    projectId: "project-1",
    runKind: "freshness-evaluation",
    workKey: "incremental-freshness",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({ domain: "freshness" }),
  };
  const markedRun = {
    id: "marked-run",
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: "workspace-opened",
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v2/epoch/epoch-1",
        authorityId: "authority-1",
        generation: 7,
        productJourneyBarrierId: expected.barrierId,
        correlation: expected.correlation,
      },
    }),
  };
  const selected = foregroundMarkedRuns(
    [unrelatedFreshness, markedRun],
    [],
    expected,
  );
  assert.deepEqual(selected.map((run) => run.id), ["marked-run"]);
  assert.equal(
    assertForegroundRunMarker(markedRun, expected).marker.authorityId,
    "authority-1",
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        {
          ...markedRun,
          specJson: JSON.stringify({
            systemWork: {
              ...JSON.parse(markedRun.specJson).systemWork,
              productJourneyBarrierId: "wrong-barrier",
            },
          }),
        },
        expected,
      ),
    /productJourneyBarrierId/,
  );
});

test("transient and terminal validators reject fallback and same-millisecond false greens", () => {
  assert.throws(
    () =>
      assertTransientAttemptEvidence({
        terminalReasonCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: null,
        attemptCount: 2,
        maxAttemptNumber: 2,
      }),
    /exact NEX_MAINTENANCE_TRANSIENT/,
  );
  assert.throws(
    () =>
      assertTerminalFailureEvidence({
        status: "failed",
        terminalReasonCode: NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
        completedAt: null,
      }),
    /completedAt/,
  );
  const failed = {
    id: "failed-run",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
  };
  assert.deepEqual(
    terminalRetryCandidates(
      [
        failed,
        { ...failed, id: "same-ms-retry" },
        {
          ...failed,
          id: "other-work",
          workKey: "different-work",
        },
      ],
      failed,
    ).map((run) => run.id),
    ["same-ms-retry"],
  );
});

test("every actual C2-5B Electron launch phase is registered for diagnostics", () => {
  assert.equal(
    new Set(NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES).size,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES.length,
    "C2-5B launch phases must be unique",
  );
  for (const phase of NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
  const registeredC2Phases = PRODUCT_JOURNEY_ELECTRON_PHASES.filter((phase) =>
    phase.startsWith("c2-5b-"),
  );
  assert.deepEqual(
    registeredC2Phases,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
    "C2-5B launch phase registry must stay in parity with the runner",
  );
});

test("c2-5b runner IDs are wired to the central catalog and impact selector", () => {
  assert.deepEqual(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  const selection = selectProductJourneys({
    catalog: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [
      "electron/scripts/narrative-maintenance-product-journeys.mjs",
    ],
    mode: "all",
  });
  assert.deepEqual(
    selection.journeyIds,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(selection.allSelected, true);
});

test("maintenance source changes select the executable C2-5B journey subset", () => {
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  for (const changedPath of [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
    "electron/native/grimodex-node/src/lib.rs",
    "electron/main/narrativeFreshness.ts",
    "policies/narrative/narrative-run-kind-policy.json",
  ]) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(
      expectedIds.filter((id) => selection.journeyIds.includes(id)),
      expectedIds,
      changedPath,
    );
  }
});

test("C2-5B runtime/semantic impact is direct for every launch owner path", async () => {
  const [impactSource, qualityManifest] = await Promise.all([
    readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const impactMap = parseImpactMap(impactSource);
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const ownerPaths = [
    ...NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
    "src-tauri/crates/grimodex-db/src/migrate.rs",
    "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
    "src-tauri/crates/grimodex-db/src/backup_restore.rs",
  ];
  for (const changedPath of ownerPaths) {
    assert.ok(
      qualityManifest.includes(`- ${changedPath}`),
      `${changedPath} must remain traceable in the quality manifest`,
    );
    const productSelection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(productSelection.journeyIds, expectedIds, changedPath);
    assert.equal(productSelection.fallback, false, changedPath);
    assert.equal(productSelection.allSelected, false, changedPath);
    assert.ok(
      productSelection.matchedRuleIds.includes(
        "narrative-maintenance-product-journeys",
      ),
      changedPath,
    );

    const qualitySelection = selectImpact(impactMap, [changedPath]);
    assert.equal(qualitySelection.fallback, false, changedPath);
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-runtime-authority"),
      changedPath,
    );
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-semantic-contract"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-runtime"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-semantic-contract"),
      changedPath,
    );
  }
});

test("central impact catalog emits C2-5B IDs that the Electron runner can execute", () => {
  const reportCatalog = resolveProductJourneyImpactCatalog("c2-5b");
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  assert.deepEqual(
    reportCatalog.map((journey) => journey.id),
    expectedIds,
  );
});

test("c2-5b selector executes only explicitly selected durable journeys", () => {
  const set = resolveProductJourneySet("c2-5b");
  const selected = resolveSelectedProductJourneys(
    set,
    JSON.stringify([
      "c2-5b-terminal-failure-inbox",
      "c2-5b-incremental-liveness",
    ]),
  );
  assert.deepEqual(
    selected.map((journey) => journey.id),
    ["c2-5b-terminal-failure-inbox", "c2-5b-incremental-liveness"],
  );
});
