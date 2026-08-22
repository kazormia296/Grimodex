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
  NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  NARRATIVE_MAINTENANCE_TRIGGERS,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
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
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.jsDigestAuthority,
    "durable native outcome skipEvidence fields",
  );
});

test("every actual C2-5B Electron launch phase is registered for diagnostics", () => {
  const requiredPhases = [
    "c2-5b-schema-backfill-verify/open",
    "c2-5b-restore-verify-rebuild-verify/open",
    "c2-5b-graph-digest-no-skip/baseline",
    "c2-5b-graph-digest-no-skip/changed",
    "c2-5b-rule-digest-no-skip/baseline",
    "c2-5b-rule-digest-no-skip/changed",
    "c2-5b-producer-generation-no-skip/baseline",
    "c2-5b-producer-generation-no-skip/changed",
    "c2-5b-transient-bounded-retry/open",
    "c2-5b-terminal-failure-inbox/open",
    "c2-5b-terminal-failure-inbox/reopened",
    "c2-5b-interrupted-run-recovery/interrupted",
    "c2-5b-interrupted-run-recovery/recovered",
    "c2-5b-no-automatic-repair/open",
    "c2-5b-foreground-write-workspace-wake/authoring",
    "c2-5b-incremental-liveness/before-restart",
    "c2-5b-incremental-liveness/after-restart",
  ];
  for (const phase of requiredPhases) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
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
  const impactMap = parseImpactMap(
    await readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
  );
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const ownerPaths = [
    "electron/main/index.ts",
    "electron/main/narrativeMaintenance.ts",
    "electron/main/narrativeMaintenance.test.ts",
    "electron/main/narrativeMaintenanceTriggers.ts",
    "electron/main/narrativeMaintenanceTriggers.test.ts",
    "src-tauri/crates/grimodex-db/src/migrate.rs",
    "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
    "src-tauri/crates/grimodex-db/src/backup_restore.rs",
  ];
  for (const changedPath of ownerPaths) {
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
