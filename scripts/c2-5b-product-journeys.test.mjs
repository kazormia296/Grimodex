import assert from "node:assert/strict";
import test from "node:test";

import {
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  resolveSelectedProductJourneys,
} from "../electron/scripts/product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_FAULTS,
  NARRATIVE_MAINTENANCE_TRIGGERS,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
} from "../electron/scripts/product-journey-catalog.mjs";
import {
  resolveProductJourneyImpactCatalog,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";

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
