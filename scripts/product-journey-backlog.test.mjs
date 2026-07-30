import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
  PRODUCT_JOURNEY_ROLLOUT_MODE,
} from "../electron/scripts/product-journey-catalog.mjs";
import { validateCurrentProductJourneyCoverage } from "../electron/scripts/product-journey-coverage.mjs";

const EXPECTED_JOURNEY_IDS = [
  "editor-persistence",
  "chat-authority-isolation",
  "workspace-switch-authority",
  "external-write-conflict",
  "cross-feature-authoring",
  "chat-stream-project-switch",
  "chat-stream-workspace-switch",
  "editor-pending-project-switch",
  "mcp-external-write-conflict",
  "chronicle-native-roundtrip",
  "lint-native-roundtrip",
  "map-native-roundtrip",
  "snapshot-native-roundtrip",
];

const NEW_CONTRACT_IDS = [
  "scope-transition:chat-stream:project",
  "scope-transition:chat-stream:workspace",
  "scope-transition:editor-pending:project",
  "external-write:mcp:clean",
  "external-write:mcp:dirty",
  "roundtrip:chronicle",
  "roundtrip:lint",
  "roundtrip:map",
  "roundtrip:snapshot",
];

test("implemented scope, MCP, and native journeys are active catalog entries", () => {
  assert.deepEqual(
    PRODUCT_JOURNEY_CATALOG.map((entry) => entry.id),
    EXPECTED_JOURNEY_IDS,
  );
  assert.deepEqual(
    NEW_CONTRACT_IDS.filter((contractId) =>
      PRODUCT_JOURNEY_CATALOG.some((entry) =>
        entry.contracts.includes(contractId),
      ),
    ),
    NEW_CONTRACT_IDS,
  );
  assert.deepEqual(PRODUCT_JOURNEY_COVERAGE_BACKLOG, []);
});

test("coverage ratchet is complete and affected execution is unlocked", () => {
  assert.equal(PRODUCT_JOURNEY_ROLLOUT_MODE, "affected");
  assert.deepEqual(
    NEW_CONTRACT_IDS.filter((contractId) =>
      PRODUCT_CONTRACT_REQUIREMENTS.some(
        (contract) => contract.id === contractId,
      ),
    ),
    NEW_CONTRACT_IDS,
  );
  const coverage = validateCurrentProductJourneyCoverage();
  assert.equal(coverage.affectedReady, true);
  assert.deepEqual(coverage.plannedJourneyIds, []);
  assert.deepEqual(coverage.plannedContractIds, []);
});
