import assert from "node:assert/strict";
import test from "node:test";

import * as canonicalContract from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import * as productRunner from "../electron/scripts/product-journeys.mjs";
import { NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";

test("canonical contract exposes only the required lifecycle authority surface", () => {
  assert.equal(
    typeof canonicalContract.runC2ZcCanonicalAuthorityJourney,
    "function",
  );
  assert.equal("runC2ZcPostMarkerLifecycleJourney" in canonicalContract, false);
  assert.equal("assertC2ZcPreMarkerHeldEvidence" in canonicalContract, false);
  assert.equal(
    "assertC2ZcTwoProjectConvergenceGate" in canonicalContract,
    false,
  );
});

test("canonical and representative DML lanes are required, with DML auxiliary", () => {
  const [canonical, dml] = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG;
  assert.deepEqual(
    [canonical.id, dml.id],
    ["c2-zc-canonical-authority-cutover", "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.equal(canonical.required, true);
  assert.equal(dml.required, true);
  assert.equal(dml.acceptanceRole, "auxiliary");
});

test("Rust/build completion cannot turn a failed canonical lane into acceptance", () => {
  const report = {
    status: "passed",
    journeyIds: [
      "c2-zc-canonical-authority-cutover",
      "c2-zc-renderer-mcp-dml-denial",
    ],
    journeys: [
      {
        id: "c2-zc-canonical-authority-cutover",
        status: "failed",
        cleanPass: false,
      },
      {
        id: "c2-zc-renderer-mcp-dml-denial",
        status: "passed",
        cleanPass: true,
      },
    ],
    acceptanceRequired: true,
    c2zcRustAcceptance: { required: true, verified: true },
    buildReceipt: { verified: true, candidate: null, artifacts: [] },
  };
  productRunner.refreshProductJourneyOutcome(report);
  assert.equal(report.allPassed, false);
  assert.equal(report.allClean, false);
  assert.equal(report.acceptanceComplete, false);
});
