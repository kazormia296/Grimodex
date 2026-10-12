import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PRODUCT_CHAT_SCOPES,
  PRODUCT_CONTRACT_EXEMPTIONS,
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_ROLLOUT_MODE,
  PRODUCT_SCOPE_TRANSITIONS,
} from "../electron/scripts/product-journey-catalog.mjs";
import { validateCurrentProductJourneyCoverage } from "../electron/scripts/product-journey-coverage.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const EXPECTED_JOURNEY_IDS = [
  "editor-persistence",
  "chat-authority-isolation",
  "chat-stream-folder-switch",
  "chat-stream-snippet-switch",
  "chat-stream-codex-switch",
  "workspace-switch-authority",
  "external-write-conflict",
  "cross-feature-authoring",
  "chat-stream-project-switch",
  "agent-stream-project-switch",
  "chat-stream-workspace-switch",
  "agent-stream-workspace-switch",
  "editor-pending-project-switch",
  "mcp-external-write-conflict",
  "chronicle-native-roundtrip",
  "lint-native-roundtrip",
  "map-native-roundtrip",
  "snapshot-native-roundtrip",
  "chronicle-extract-review-apply-reopen",
  "codex-entity-relation-review-apply-reopen",
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((entry) => entry.id),
  ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map((entry) => entry.id),
];

const IMPLEMENTED_CONTRACT_IDS = [
  "scope-transition:chat-stream:folder",
  "scope-transition:chat-stream:snippet",
  "scope-transition:chat-stream:codex",
  "scope-transition:chat-stream:project",
  "scope-transition:agent-stream:project",
  "scope-transition:chat-stream:workspace",
  "scope-transition:agent-stream:workspace",
  "scope-transition:editor-pending:project",
  "d2a:mcp:pre-dispatch-denial",
  "native-command-roundtrip:chronicle-bulk",
  "native-command-roundtrip:lint-term-dictionary",
  "native-command-roundtrip:map-write-bundle",
  "native-command-roundtrip:project-snapshot",
  "codex:entity-relation-review-apply-reopen",
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (entry) => entry.contracts[0],
  ),
  ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.flatMap((entry) => entry.contracts),
];

const PLANNED_JOURNEY_IDS = [
  "chronicle-ui-roundtrip",
  "lint-ui-roundtrip",
  "map-ui-roundtrip",
  "snapshot-ui-roundtrip",
];

const PLANNED_CONTRACT_IDS = [
  "ui-roundtrip:chronicle",
  "ui-roundtrip:lint",
  "ui-roundtrip:map",
  "ui-roundtrip:snapshot",
];

test("implemented scope, MCP, and native-command journeys are active catalog entries", () => {
  assert.deepEqual(
    PRODUCT_JOURNEY_CATALOG.map((entry) => entry.id),
    EXPECTED_JOURNEY_IDS,
  );
  assert.deepEqual(
    IMPLEMENTED_CONTRACT_IDS.filter((contractId) =>
      PRODUCT_JOURNEY_CATALOG.some((entry) =>
        entry.contracts.includes(contractId),
      ),
    ),
    IMPLEMENTED_CONTRACT_IDS,
  );
});

test("ChatScope is derived from one registry and has exact ratchet parity", async () => {
  assert.deepEqual(PRODUCT_CHAT_SCOPES, [
    "scene",
    "folder",
    "project",
    "codex",
    "snippet",
  ]);

  const registry = JSON.parse(
    await readFile(
      path.join(repoRoot, "src/features/chat/chatScopeRegistry.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(registry), PRODUCT_CHAT_SCOPES);

  const source = await readFile(
    path.join(repoRoot, "src/features/chat/chatScope.ts"),
    "utf8",
  );
  assert.match(source, /from ["']\.\/chatScopeRegistry\.json["']/);
  assert.match(source, /type ChatScope = keyof typeof chatScopeRegistry/);
  assert.match(source, /Object\.keys\(chatScopeRegistry\)/);

  const declaredChatScopes = PRODUCT_SCOPE_TRANSITIONS.filter(
    (transition) =>
      transition.authority === "chat-scope" &&
      transition.operation === "chat-stream",
  ).map((transition) => transition.scope);
  assert.deepEqual(declaredChatScopes, PRODUCT_CHAT_SCOPES);

  assert.deepEqual(
    PRODUCT_SCOPE_TRANSITIONS.filter(
      (transition) =>
        transition.operation === "chat-stream" &&
        transition.scope === "workspace",
    ).map((transition) => transition.authority),
    ["lifecycle"],
  );
  assert.deepEqual(
    PRODUCT_SCOPE_TRANSITIONS.filter(
      (transition) =>
        transition.operation === "agent-stream" &&
        ["project", "workspace"].includes(transition.scope),
    ).map((transition) => transition.authority),
    ["lifecycle", "lifecycle"],
  );
});

test("implemented scope contracts are active and remaining planned journeys stay visible", () => {
  assert.equal(PRODUCT_JOURNEY_ROLLOUT_MODE, "shadow");
  assert.deepEqual(
    IMPLEMENTED_CONTRACT_IDS.filter((contractId) =>
      PRODUCT_CONTRACT_REQUIREMENTS.some(
        (contract) => contract.id === contractId,
      ),
    ),
    IMPLEMENTED_CONTRACT_IDS,
  );
  assert.deepEqual(PRODUCT_CONTRACT_EXEMPTIONS, []);

  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.map((journey) => journey.id),
    PLANNED_JOURNEY_IDS,
  );
  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.flatMap((journey) => journey.contracts),
    PLANNED_CONTRACT_IDS,
  );
  const coverage = validateCurrentProductJourneyCoverage();
  assert.equal(coverage.affectedReady, false);
  assert.deepEqual(coverage.exemptedContracts, []);
  assert.deepEqual(coverage.plannedJourneyIds, PLANNED_JOURNEY_IDS);
  assert.deepEqual(coverage.plannedContractIds, PLANNED_CONTRACT_IDS);
});
