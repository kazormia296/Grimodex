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
  PRODUCT_JOURNEY_ROLLOUT_MODE,
  PRODUCT_SCOPE_TRANSITIONS,
} from "../electron/scripts/product-journey-catalog.mjs";
import { validateCurrentProductJourneyCoverage } from "../electron/scripts/product-journey-coverage.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

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
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((entry) => entry.id),
];

const IMPLEMENTED_CONTRACT_IDS = [
  "scope-transition:chat-stream:project",
  "scope-transition:chat-stream:workspace",
  "scope-transition:editor-pending:project",
  "external-write:mcp:clean",
  "external-write:mcp:dirty",
  "native-command-roundtrip:chronicle-bulk",
  "native-command-roundtrip:lint-term-dictionary",
  "native-command-roundtrip:map-write-bundle",
  "native-command-roundtrip:project-snapshot",
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (entry) => entry.contracts[0],
  ),
];

const EXEMPTED_CHAT_SCOPE_CONTRACT_IDS = [
  "scope-transition:chat-stream:folder",
  "scope-transition:chat-stream:codex",
  "scope-transition:chat-stream:snippet",
];

const PLANNED_JOURNEY_IDS = [
  "agent-stream-project-switch",
  "agent-stream-workspace-switch",
  "chronicle-ui-roundtrip",
  "lint-ui-roundtrip",
  "map-ui-roundtrip",
  "snapshot-ui-roundtrip",
];

const PLANNED_CONTRACT_IDS = [
  "scope-transition:agent-stream:project",
  "scope-transition:agent-stream:workspace",
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
});

test("tracked scope exemptions and planned journeys keep affected execution locked", () => {
  assert.equal(PRODUCT_JOURNEY_ROLLOUT_MODE, "shadow");
  assert.deepEqual(
    [...IMPLEMENTED_CONTRACT_IDS, ...EXEMPTED_CHAT_SCOPE_CONTRACT_IDS].filter(
      (contractId) =>
        PRODUCT_CONTRACT_REQUIREMENTS.some(
          (contract) => contract.id === contractId,
        ),
    ),
    [...IMPLEMENTED_CONTRACT_IDS, ...EXEMPTED_CHAT_SCOPE_CONTRACT_IDS],
  );
  assert.deepEqual(
    PRODUCT_CONTRACT_EXEMPTIONS.map((exemption) => exemption.targetId),
    EXEMPTED_CHAT_SCOPE_CONTRACT_IDS,
  );
  for (const exemption of PRODUCT_CONTRACT_EXEMPTIONS) {
    assert.equal(exemption.trackingIssue, "#429");
    assert.equal(exemption.expiresOn, "2026-09-30");
    assert.ok(exemption.reason.length > 0);
  }

  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.map((journey) => journey.id),
    PLANNED_JOURNEY_IDS,
  );
  assert.deepEqual(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.flatMap((journey) => journey.contracts),
    PLANNED_CONTRACT_IDS,
  );
  for (const plannedAgentJourney of PRODUCT_JOURNEY_COVERAGE_BACKLOG.filter(
    (journey) => journey.id.startsWith("agent-stream-"),
  )) {
    assert.equal(plannedAgentJourney.trackingIssue, "#429");
    assert.equal(plannedAgentJourney.expiresOn, "2026-09-30");
    assert.ok(plannedAgentJourney.reason.length > 0);
  }

  const coverage = validateCurrentProductJourneyCoverage();
  assert.equal(coverage.affectedReady, false);
  assert.deepEqual(
    coverage.exemptedContracts,
    EXEMPTED_CHAT_SCOPE_CONTRACT_IDS,
  );
  assert.deepEqual(coverage.plannedJourneyIds, PLANNED_JOURNEY_IDS);
  assert.deepEqual(coverage.plannedContractIds, PLANNED_CONTRACT_IDS);
});
