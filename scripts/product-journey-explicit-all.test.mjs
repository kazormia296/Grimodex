import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { selectProductJourneys } from "../electron/scripts/product-journey-impact.mjs";

test("explicit all remains explicit even when a release checkout has no comparison diff", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [],
    forceAllReason: "No release comparison base was supplied.",
    mode: "all",
  });

  assert.equal(selection.allSelected, true);
  assert.equal(selection.fallback, false);
  assert.equal(selection.reasonKind, "explicit-all");
  assert.equal(
    selection.reason,
    "Explicit all mode selected the full product journey catalog.",
  );
  assert.deepEqual(
    selection.journeyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
});
