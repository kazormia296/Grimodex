import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID,
  CODEX_ENTITY_RELATION_REVIEW_REQUIRED_INTERACTIONS,
  CODEX_ENTITY_RELATION_REVIEW_SELECTORS,
  createCodexEntityRelationReviewJourney,
} from "../electron/scripts/codex-entity-relation-product-journey.mjs";
import { PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function selectorContractHarness() {
  const calls = [];
  return {
    calls,
    async waitForSelector(selector) {
      calls.push(selector);
    },
  };
}

test("Entity/Relation Journey has one dependency-free mocked selector sequence", async () => {
  const mock = selectorContractHarness();
  for (const selector of CODEX_ENTITY_RELATION_REVIEW_SELECTORS) {
    await mock.waitForSelector(selector);
  }
  assert.deepEqual(mock.calls, [...CODEX_ENTITY_RELATION_REVIEW_SELECTORS]);
  assert.deepEqual(CODEX_ENTITY_RELATION_REVIEW_REQUIRED_INTERACTIONS, [
    "create-folder-through-scenes-toolbar",
    "create-single-scene-through-folder-row",
    "create-two-codex-entries-through-codex-panel",
    "create-typed-relation-through-relations-tab",
    "select-direct-typed-scope-and-material",
    "inspect-native-typed-draft-evidence",
    "approve-typed-revision-through-ui",
    "close-and-relaunch-electron",
    "restore-dedicated-typed-run-through-ui",
  ]);
});

test("Journey factory is production-dispatchable without importing Electron", () => {
  const journey = createCodexEntityRelationReviewJourney({
    configureWorkspace() {},
  });
  assert.equal(journey.id, CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID);
  assert.equal(typeof journey.run, "function");
  const catalogEntry = PRODUCT_JOURNEY_CATALOG.find(
    (entry) => entry.id === CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID,
  );
  assert.deepEqual(catalogEntry?.capabilities, ["electron", "napi"]);
  assert.deepEqual(catalogEntry?.contracts, [
    "codex:entity-relation-review-apply-reopen",
  ]);
});

test("runner source pins the normal UI path and keeps typed payload reads out of generic review", async () => {
  const source = await readFile(
    path.join(repoRoot, "electron/scripts/product-journeys.mjs"),
    "utf8",
  );
  const journeySource = await readFile(
    path.join(
      repoRoot,
      "electron/scripts/codex-entity-relation-product-journey.mjs",
    ),
    "utf8",
  );
  assert.match(source, /createCodexEntityRelationReviewJourney/);
  for (const selector of [
    "codex-typed-relations-open-nir1-review",
    "codex-typed-relation-target",
    "codex-typed-relation-add",
    "nir1-entity-relation-prepare-dialog",
    "nir1-typed-scene-scope",
    "nir1-entity-relation-review-panel",
    "nir1-typed-approve",
  ]) {
    assert.ok(
      journeySource.includes(selector),
      `runner must use ${selector}`,
    );
  }
  assert.equal(
    journeySource.includes("get_run_review_bundle"),
    true,
    "typed journey must observe generic review bundle only before the typed panel boundary",
  );
  assert.equal(
    journeySource.includes("captureJournalBoundary"),
    true,
    "typed journey must capture the journal phase/line boundary at the typed panel",
  );
  assert.equal(
    journeySource.includes("genericReviewBundleReadsAfterTypedPanel"),
    true,
    "typed journey must reject generic review bundle reads after the typed panel",
  );
  assert.equal(
    journeySource.includes("typed review runId"),
    true,
    "typed journey must assert a non-empty renderer runId",
  );
  for (const evidence of [
    "readTypedRuntimeMetadata",
    "typed-runtime-bound",
    "savedDecisionCount",
    "restoredRunId",
    "genericReviewBundleReadBeforeTypedPanelCount",
  ]) {
    assert.ok(
      journeySource.includes(evidence),
      `typed journey must bind ${evidence} to saved runtime evidence`,
    );
  }
  assert.equal(
    journeySource.includes("VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW"),
    false,
    "typed journey must not depend on a DEV-only flag",
  );
});
