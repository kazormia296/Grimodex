import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
  PRODUCT_JOURNEY_ROLLOUT_MODE,
} from "../electron/scripts/product-journey-catalog.mjs";
import { validateCurrentProductJourneyCoverage } from "../electron/scripts/product-journey-coverage.mjs";

test("shadow coverage backlog registers every currently planned journey and contract", () => {
  assert.equal(PRODUCT_JOURNEY_ROLLOUT_MODE, "shadow");
  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.map((entry) => entry.id),
    [
      "chat-stream-project-switch",
      "chat-stream-workspace-switch",
      "editor-pending-project-switch",
      "mcp-external-write-conflict",
      "chronicle-native-roundtrip",
      "lint-native-roundtrip",
      "map-native-roundtrip",
      "snapshot-native-roundtrip",
    ],
  );
  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.flatMap(
      (entry) => entry.contracts,
    ),
    [
      "scope-transition:chat-stream:project",
      "scope-transition:chat-stream:workspace",
      "scope-transition:editor-pending:project",
      "external-write:mcp:clean",
      "external-write:mcp:dirty",
      "roundtrip:chronicle",
      "roundtrip:lint",
      "roundtrip:map",
      "roundtrip:snapshot",
    ],
  );
});

test("affected execution cannot unlock while backlog coverage is missing", () => {
  const shadow = validateCurrentProductJourneyCoverage();
  assert.equal(shadow.affectedReady, false);
  assert.deepEqual(
    shadow.plannedJourneyIds,
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.map((entry) => entry.id),
  );
  assert.equal(shadow.plannedContractIds.length, 9);

  assert.throws(
    () =>
      validateCurrentProductJourneyCoverage({
        rolloutMode: "affected",
      }),
    /affected.*backlog.*8 planned journeys.*9 contracts/is,
  );
});
