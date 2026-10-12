import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const cloneAndFreeze = (value) => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          cloneAndFreeze(nestedValue),
        ]),
      ),
    );
  }
  return value;
};

const freezeEntries = (entries) =>
  Object.freeze(entries.map((entry) => cloneAndFreeze(entry)));

export const PRODUCT_JOURNEY_CAPABILITY_ORDER = Object.freeze([
  "electron",
  "napi",
  "mcp",
]);

const chatScopeRegistry = JSON.parse(
  readFileSync(
    new URL("../../src/features/chat/chatScopeRegistry.json", import.meta.url),
    "utf8",
  ),
);
if (
  !chatScopeRegistry ||
  typeof chatScopeRegistry !== "object" ||
  Array.isArray(chatScopeRegistry) ||
  Object.keys(chatScopeRegistry).length === 0 ||
  Object.values(chatScopeRegistry).some((enabled) => enabled !== true)
) {
  throw new Error(
    "chatScopeRegistry.json must be a non-empty object whose values are true",
  );
}

export const PRODUCT_CHAT_SCOPES = Object.freeze(
  Object.keys(chatScopeRegistry),
);

/**
 * Affected execution remains locked while tracked exemptions or planned UI
 * coverage exist. Shadow mode still records deterministic recommendations.
 */
export const PRODUCT_JOURNEY_ROLLOUT_MODE = "shadow";

/**
 * C2-5B's durable maintenance acceptance catalog is part of the canonical
 * product catalog.  The runner can still select the eleven-entry C2-5B set
 * explicitly for focused acceptance, while normal canonical execution keeps
 * the IDs visible to impact selection instead of silently omitting the lane.
 */
const NARRATIVE_MAINTENANCE_JOURNEY_SPECS = Object.freeze([
  [
    "schema-backfill-verify",
    "schema migration marker/open -> Backfill -> Verify",
  ],
  [
    "restore-verify-rebuild-verify",
    "restore epoch -> Verify -> Rebuild -> Verify",
  ],
  ["graph-digest-no-skip", "graph digest change -> no skip"],
  ["rule-digest-no-skip", "rule digest change -> no skip"],
  ["producer-generation-no-skip", "producer generation change -> no skip"],
  ["transient-bounded-retry", "transient failure -> bounded retry -> success"],
  ["terminal-failure-inbox", "terminal contract failure -> durable Inbox"],
  ["interrupted-run-recovery", "process interruption -> durable recovery"],
  ["no-automatic-repair", "dependency gap -> Verify/Rebuild without Repair"],
  ["foreground-write-workspace-wake", "foreground write -> workspace wake"],
  ["incremental-liveness", "incremental feed -> restart -> current epoch"],
]);

export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG = freezeEntries(
  NARRATIVE_MAINTENANCE_JOURNEY_SPECS.map(([suffix, description]) => ({
    id: `c2-5b-${suffix}`,
    domains: ["narrative-maintenance"],
    interactions: ["narrative-maintenance->sqlite"],
    contracts: [`c2-5b:${suffix}`],
    capabilities: ["electron", "napi"],
    description,
  })),
);

/**
 * C2-ZC is a separate acceptance boundary from the C2-5B maintenance
 * journeys. Keep its production reachability journey explicit so the
 * canonical-authority cutover cannot disappear behind the broader catalog.
 */
export const NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG = freezeEntries([
  {
    id: "c2-zc-canonical-authority-cutover",
    required: true,
    acceptanceRole: "required",
    domains: ["narrative-maintenance"],
    interactions: ["narrative-maintenance->sqlite"],
    contracts: ["c2-zc:canonical-authority-cutover"],
    capabilities: ["electron", "napi"],
    description:
      "offline restore fixture -> production Settings UI restore -> durable Verify/conditional Rebuild/confirmation Verify/Freshness -> marker -> typed Generic write -> restart persistence",
    phases: [
      "c2-zc-canonical-authority-cutover/restore-fixture",
      "c2-zc-canonical-authority-cutover/restore",
      "c2-zc-canonical-authority-cutover/open",
      "c2-zc-canonical-authority-cutover/restart",
      "c2-zc-canonical-authority-cutover/typed-write",
      "c2-zc-canonical-authority-cutover/restart-persistence",
    ],
  },
  {
    id: "c2-zc-renderer-mcp-dml-denial",
    required: true,
    acceptanceRole: "auxiliary",
    domains: ["narrative-maintenance", "sqlite"],
    interactions: ["narrative-maintenance->sqlite"],
    contracts: ["c2-zc:boundary-dml-denial"],
    capabilities: ["electron", "napi"],
    description:
      "one-launch, one representative real renderer IPC db_execute DML denial with an unchanged row; all-table, MCP, typed-positive, and direct-corruption proofs are bound to Rust acceptance gates",
    phases: ["c2-zc-renderer-mcp-dml-denial/representative"],
    mcpGeneric: {
      productionToolName: null,
      productionRoute: null,
      status: "not-exposed",
      canonicalRustSource: "src-tauri/crates/grimodex-db/src/execute.rs",
      canonicalRustTest:
        "c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
      origin: "SqlOrigin::McpGeneric",
    },
  },
]);

/**
 * Dependency-free product journey catalog.
 *
 * Keep this file free of Playwright, Electron, YAML, and workspace package
 * imports: CI reads it before pnpm install to decide whether the expensive
 * native/Electron setup is relevant.
 */
export const PRODUCT_JOURNEY_CATALOG = freezeEntries([
  {
    id: "editor-persistence",
    domains: ["editor", "scene-persistence"],
    interactions: ["editor->sqlite", "sqlite->editor"],
    contracts: ["roundtrip:editor"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "chat-authority-isolation",
    domains: ["chat", "editor", "scene-persistence"],
    interactions: ["scene-scope->chat", "chat->sqlite"],
    contracts: ["scope-transition:chat-stream:scene"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "chat-stream-folder-switch",
    domains: ["chat", "scene-scope"],
    interactions: ["scene-scope->chat", "chat->sqlite"],
    contracts: ["scope-transition:chat-stream:folder"],
    capabilities: ["electron", "napi"],
    description:
      "real folder picker -> pending regular chat stream -> captured folder session and correlated terminal audit persist without new-folder leakage",
  },
  {
    id: "chat-stream-snippet-switch",
    domains: ["chat", "snippet"],
    interactions: ["snippet->chat", "chat->sqlite"],
    contracts: ["scope-transition:chat-stream:snippet"],
    capabilities: ["electron", "napi"],
    description:
      "real snippet picker -> pending regular chat stream -> captured snippet session and correlated terminal audit persist without new-snippet leakage",
  },
  {
    id: "chat-stream-codex-switch",
    domains: ["chat", "codex"],
    interactions: ["codex->chat", "chat->sqlite"],
    contracts: ["scope-transition:chat-stream:codex"],
    capabilities: ["electron", "napi"],
    description:
      "real Codex picker -> pending regular chat stream -> Codex A transcript, prompt and audit ownership persist without Codex B leakage",
  },
  {
    id: "workspace-switch-authority",
    domains: ["workspace-lifecycle", "editor", "scene-persistence"],
    interactions: [
      "editor->workspace-lifecycle",
      "editor->sqlite",
      "sqlite->editor",
    ],
    contracts: ["scope-transition:editor-pending:workspace"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "external-write-conflict",
    domains: ["external-write-feed", "editor", "history", "scene-persistence"],
    interactions: [
      "sqlite->external-write-feed",
      "external-write-feed->editor",
      "external-write-feed->history",
    ],
    contracts: [
      "external-write:renderer-equivalent:clean",
      "external-write:renderer-equivalent:dirty",
    ],
    capabilities: ["electron", "napi"],
  },
  {
    id: "cross-feature-authoring",
    domains: [
      "codex",
      "chat",
      "editor",
      "attribution",
      "history",
      "scene-persistence",
    ],
    interactions: [
      "codex->chat",
      "chat->editor",
      "editor->history",
      "editor->sqlite",
      "sqlite->editor",
    ],
    contracts: [
      "authoring:codex-chat-editor-history-restart",
      "roundtrip:editor",
    ],
    capabilities: ["electron", "napi"],
  },
  {
    id: "chat-stream-project-switch",
    domains: ["chat", "project-lifecycle"],
    interactions: ["project-lifecycle->chat"],
    contracts: ["scope-transition:chat-stream:project"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "agent-stream-project-switch",
    domains: ["chat", "project-lifecycle"],
    interactions: ["project-lifecycle->chat"],
    contracts: ["scope-transition:agent-stream:project"],
    capabilities: ["electron", "napi"],
    description:
      "Agent-mode send_agent_message -> strict project quiescence -> old-project transcript/audit persistence",
  },
  {
    id: "chat-stream-workspace-switch",
    domains: ["chat", "workspace-lifecycle"],
    interactions: ["workspace-lifecycle->chat"],
    contracts: ["scope-transition:chat-stream:workspace"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "agent-stream-workspace-switch",
    domains: ["chat", "workspace-lifecycle"],
    interactions: ["workspace-lifecycle->chat"],
    contracts: ["scope-transition:agent-stream:workspace"],
    capabilities: ["electron", "napi"],
    description:
      "Agent-mode send_agent_message -> strict workspace quiescence -> old-workspace transcript/audit persistence",
  },
  {
    id: "editor-pending-project-switch",
    domains: ["editor", "project-lifecycle"],
    interactions: ["editor->project-lifecycle"],
    contracts: ["scope-transition:editor-pending:project"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "mcp-external-write-conflict",
    name: "MCP D2a egress denial",
    domains: ["mcp"],
    interactions: ["mcp->sqlite"],
    contracts: ["d2a:mcp:pre-dispatch-denial"],
    capabilities: ["electron", "napi", "mcp"],
    description:
      "standalone MCP propose_scene_body is denied before handler dispatch, DB mutation, or external-write feed",
  },
  {
    id: "chronicle-native-roundtrip",
    domains: ["chronicle-bulk"],
    interactions: ["chronicle-bulk->sqlite", "sqlite->chronicle-bulk"],
    contracts: ["native-command-roundtrip:chronicle-bulk"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "lint-native-roundtrip",
    domains: ["lint-term-dictionary"],
    interactions: [
      "lint-term-dictionary->sqlite",
      "sqlite->lint-term-dictionary",
    ],
    contracts: ["native-command-roundtrip:lint-term-dictionary"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "map-native-roundtrip",
    domains: ["map-write-bundle"],
    interactions: ["map-write-bundle->sqlite", "sqlite->map-write-bundle"],
    contracts: ["native-command-roundtrip:map-write-bundle"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "snapshot-native-roundtrip",
    domains: ["project-snapshot"],
    interactions: ["project-snapshot->sqlite", "sqlite->project-snapshot"],
    contracts: ["native-command-roundtrip:project-snapshot"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "chronicle-extract-review-apply-reopen",
    domains: ["chronicle-extraction"],
    interactions: [
      "chronicle-extraction->sqlite",
      "sqlite->chronicle-extraction",
    ],
    contracts: ["chronicle:extract-review-apply-reopen"],
    capabilities: ["electron", "napi"],
    description:
      "fixed provider response -> production extraction and quote display -> human review -> Native V2 Prepare/Apply -> restart without duplicate Events",
  },
  {
    id: "codex-entity-relation-review-apply-reopen",
    domains: ["codex", "scene-persistence", "workspace-lifecycle"],
    interactions: ["codex->sqlite", "sqlite->codex"],
    contracts: ["codex:entity-relation-review-apply-reopen"],
    capabilities: ["electron", "napi"],
    description:
      "normal Codex entry creation -> typed Entity/Relation relation selection -> direct scope/material -> Native evidence review -> explicit approval -> target-bound cold reopen",
  },
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
]);

/**
 * The A2 Entity/Relation journey is also runnable as an isolated Heavy
 * evaluation. Keep the subset catalog explicit so its required IDs and
 * catalog digest describe the one journey that actually ran.
 */
export const NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG = freezeEntries(
  PRODUCT_JOURNEY_CATALOG.filter(
    ({ id }) => id === "codex-entity-relation-review-apply-reopen",
  ),
);

/**
 * Bind acceptance evidence to the exact catalog that selected and executed
 * the journeys. JSON.stringify is deterministic here because the catalog is
 * source-defined and freezeEntries preserves entry and field order.
 */
export function digestProductJourneyCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("product journey catalog must be a non-empty array");
  }
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(catalog))
    .digest("hex")}`;
}

export const PRODUCT_JOURNEY_CATALOG_DIGEST = digestProductJourneyCatalog(
  PRODUCT_JOURNEY_CATALOG,
);

export const NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG_DIGEST =
  digestProductJourneyCatalog(NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG);

/**
 * Known coverage gaps remain explicit. Entries move into
 * PRODUCT_JOURNEY_CATALOG only when their real runner implementation and
 * contract evidence land together.
 */
export const PRODUCT_JOURNEY_COVERAGE_BACKLOG = freezeEntries([
  {
    id: "chronicle-ui-roundtrip",
    domains: ["chronicle-ui"],
    interactions: [],
    contracts: ["ui-roundtrip:chronicle"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "lint-ui-roundtrip",
    domains: ["lint-ui"],
    interactions: [],
    contracts: ["ui-roundtrip:lint"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "map-ui-roundtrip",
    domains: ["map-ui"],
    interactions: [],
    contracts: ["ui-roundtrip:map"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "snapshot-ui-roundtrip",
    domains: ["snapshot-ui"],
    interactions: [],
    contracts: ["ui-roundtrip:snapshot"],
    capabilities: ["electron", "napi"],
  },
]);

/**
 * Every main-process maintenance owner is a direct C2-5B impact source.  The
 * trigger and reacceptance paths are listed even when their production seam is
 * still landing on the integration branch, so an isolated change cannot fall
 * through to an unrelated/default selector.
 */
export const NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS = Object.freeze([
  "electron/main/index.ts",
  "electron/main/foregroundBarrierRelease.test.ts",
  "electron/main/narrativeMaintenance.ts",
  "electron/main/narrativeMaintenanceAttempt.ts",
  "electron/main/narrativeMaintenanceAttempt.test.ts",
  "electron/main/narrativeMaintenance.test.ts",
  "electron/main/narrativeMaintenance.phase1.test.ts",
  "electron/main/narrativeMaintenance.followup.test.ts",
  "electron/main/narrativeMaintenance.review-fixes.test.ts",
  "electron/main/narrativeMaintenance.reacceptance.test.ts",
  "electron/main/narrativeMaintenance.reacceptance.wire.test.ts",
  "electron/main/narrativeMaintenance.wiring.test.ts",
  "electron/main/narrativeMaintenance.electronRoute.test.ts",
  "electron/main/narrativeMaintenanceBootstrap.ts",
  "electron/main/narrativeMaintenanceBootstrap.test.ts",
  "electron/main/narrativeMaintenanceCiSeam.ts",
  "electron/main/narrativeMaintenanceCiSeam.test.ts",
  "electron/main/narrativeMaintenanceShutdown.ts",
  "electron/main/narrativeMaintenanceShutdown.test.ts",
  "electron/main/narrativeMaintenanceDelivery.ts",
  "electron/main/narrativeMaintenanceDelivery.test.ts",
  "electron/main/narrativeMaintenanceTriggers.ts",
  "electron/main/narrativeMaintenanceTriggers.test.ts",
]);
export const NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB =
  "electron/main/narrativeMaintenance*.ts";
export const NARRATIVE_MAINTENANCE_FOREGROUND_OWNER_GLOB =
  "electron/main/foregroundBarrier*.ts";

/**
 * Rules are deliberately explicit. A path is safe to skip only when it
 * matches a neutral rule; every unknown path falls back to the full catalog.
 */
export const PRODUCT_DOMAIN_RULES = freezeEntries([
  {
    id: "product-journey-infrastructure",
    domains: [],
    paths: [
      "electron/scripts/product-journey-*.mjs",
      "electron/scripts/product-journeys.mjs",
      "electron/main/productJourneyAi.ts",
      "electron/main/productJourneyAi.test.ts",
      "electron/main/productJourneyChronicleAi*.ts",
      "electron/shared/productJourneyChronicleFixture.json",
      "electron/scripts/chronicle-extraction-product-journey.mjs",
      "scripts/chronicle-extraction-product-journey.test.mjs",
      "scripts/product-journey-*.test.mjs",
      "scripts/electron-product-journey-*.test.mjs",
      "scripts/electron-product-journeys.test.mjs",
      "scripts/impact/**",
      "scripts/quality/impact-map.mjs",
      ".github/workflows/**",
      "package.json",
      "pnpm-lock.yaml",
      "AGENTS.md",
      ".agents/**",
    ],
    forceAll: true,
  },
  {
    id: "shared-native-boundary",
    domains: ["sqlite"],
    paths: [
      "electron/main/backend.ts",
      "electron/shared/ipcContract.ts",
      "electron/preload/**",
      "electron/native/grimodex-node/**",
    ],
    forceAll: true,
  },
  {
    id: "narrative-maintenance-product-journeys",
    domains: ["narrative-maintenance"],
    paths: [
      "electron/scripts/narrative-maintenance-product-journeys.mjs",
      "electron/scripts/c2zc-canonical-product-journey.mjs",
      "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
      "electron/scripts/product-journeys.mjs",
      "scripts/c2-5b-product-journeys.test.mjs",
      "scripts/c2zc-product-journeys.test.mjs",
      "scripts/c2zc-renderer-mcp-dml-denial.test.mjs",
      "scripts/product-journey-phase1.test.mjs",
      "electron/main/narrativeFreshness.ts",
      "electron/main/narrativeFreshness.test.ts",
      NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB,
      NARRATIVE_MAINTENANCE_FOREGROUND_OWNER_GLOB,
      ...NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
      "electron/native/grimodex-node/**",
      "src-tauri/crates/grimodex-db/src/execute.rs",
      "src-tauri/crates/grimodex-db/src/migrate.rs",
      "src-tauri/crates/grimodex-db/src/backup_restore.rs",
      "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
      "src-tauri/crates/grimodex-db/src/narrative_extraction/**",
      "src-tauri/crates/grimodex-db/tests/narrative_*",
      "src/features/narrative-extraction/maintenance/**",
      "policies/narrative/narrative-run-kind-policy.json",
      "policies/narrative/narrative-failure-policy.json",
    ],
  },
  {
    id: "editor",
    domains: ["editor"],
    paths: ["src/features/editor/**", "src/application/editor/**"],
  },
  {
    id: "chat",
    domains: ["chat"],
    paths: ["src/features/chat/**", "src/application/chat/**"],
  },
  {
    id: "scene-scope",
    domains: ["scene-scope"],
    paths: [
      "src/features/chat/chatScope.ts",
      "src/features/chat/chatScopeRegistry.json",
      "src/application/chat/chatSessionAuthority.ts",
    ],
  },
  {
    id: "codex",
    domains: ["codex"],
    paths: ["src/features/codex/**", "src/application/codex/**"],
  },
  {
    id: "attribution",
    domains: ["attribution"],
    paths: ["src/features/attribution/**"],
  },
  {
    id: "history",
    domains: ["history"],
    paths: ["src/features/history/**", "src/store/globalHistoryStore.*"],
  },
  {
    id: "workspace-lifecycle",
    domains: ["workspace-lifecycle"],
    paths: [
      "src/features/workspace/**",
      "src/application/workspace/**",
      "src/application/lifecycle/**",
      "src/lib/quiescenceProviders.ts",
    ],
  },
  {
    id: "project-lifecycle",
    domains: ["project-lifecycle"],
    paths: ["src/features/project/**", "src/application/project/**"],
  },
  {
    id: "chat-project-scope-picker",
    domains: ["project-lifecycle"],
    contracts: ["scope-transition:chat-stream:project"],
    paths: ["src/features/tree/ScopeTreePicker.tsx"],
  },
  {
    id: "external-write-feed",
    domains: ["external-write-feed"],
    paths: [
      "src/features/concurrency/externalWriteFeed.*",
      "src/application/externalWrites/**",
      "src/application/composition/projectRuntimeComposition.ts",
    ],
  },
  {
    id: "scene-persistence",
    domains: ["scene-persistence"],
    paths: [
      "src/features/tree/**",
      "src/application/tree/**",
      "src/features/editor/editorProjection.ts",
      "src-tauri/crates/grimodex-db/src/scene_body.rs",
    ],
  },
  {
    id: "chronicle-ui",
    domains: ["chronicle-ui"],
    paths: ["src/features/chronicle/**"],
  },
  {
    id: "chronicle-extraction",
    domains: ["chronicle-extraction"],
    contracts: ["chronicle:extract-review-apply-reopen"],
    paths: [
      "src/features/chronicle/ChronicleExtractDialog.*",
      "src/features/chronicle/ChronicleEvidencePane.*",
      "src/features/chronicle/ChronicleProposalReview.*",
      "src/features/chronicle/ChronicleProposalCard.*",
      "src/features/chronicle/chronicleExtraction*",
      "src/features/chronicle/extraction/**",
      "src/application/narrative-extraction/extractionCoordinator.*",
      "src/application/narrative-extraction/chronicleV2Production.*",
      "src/application/narrative-extraction/aiTasks/runObservationExtractionTask.*",
      "src/application/narrative-extraction/aiTasks/runEventSynthesisTask.*",
    ],
  },
  {
    id: "lint-ui",
    domains: ["lint-ui"],
    paths: ["src/features/lint/**"],
  },
  {
    id: "map-ui",
    domains: ["map-ui"],
    paths: ["src/features/map/**"],
  },
  {
    id: "snapshot-ui",
    domains: ["snapshot-ui"],
    paths: ["src/features/revision/**"],
  },
  {
    id: "chronicle-bulk-feature-api",
    domains: ["chronicle-bulk"],
    paths: ["src/features/agent-writes/chronicleBulk.ts"],
  },
  {
    id: "lint-term-dictionary-feature-api",
    domains: ["lint-term-dictionary"],
    paths: ["src/features/lint/termDictionaryRepository.ts"],
  },
  {
    id: "map-write-bundle-feature-api",
    domains: ["map-write-bundle"],
    paths: [
      "src/features/map/mapApi.ts",
      "src/features/map/causalityBoard.ts",
      "src/features/map/correlationBoard.ts",
    ],
  },
  {
    id: "project-snapshot-feature-api",
    domains: ["project-snapshot"],
    paths: ["src/features/revision/projectSnapshotNative.ts"],
  },
  {
    id: "chronicle-bulk-native-persistence",
    domains: ["chronicle-bulk", "native-persistence"],
    paths: ["src-tauri/crates/grimodex-db/src/chronicle_bulk.rs"],
  },
  {
    id: "lint-term-dictionary-native-persistence",
    domains: ["lint-term-dictionary", "native-persistence"],
    paths: ["src-tauri/crates/grimodex-db/src/lint_terms.rs"],
  },
  {
    id: "map-write-bundle-native-persistence",
    domains: ["map-write-bundle", "native-persistence"],
    paths: ["src-tauri/crates/grimodex-db/src/map_writes.rs"],
  },
  {
    id: "project-snapshot-native-persistence",
    domains: ["project-snapshot", "native-persistence"],
    paths: ["src-tauri/crates/grimodex-db/src/project_snapshots.rs"],
  },
  {
    id: "mcp",
    domains: ["mcp"],
    paths: ["src-tauri/crates/grimodex-mcp/**"],
  },
  {
    id: "documentation-only",
    domains: [],
    paths: ["docs/**", "*.md", "public/RELEASE_NOTES/**"],
    neutral: true,
  },
  {
    id: "offline-experiments",
    domains: [],
    paths: ["experiments/**"],
    neutral: true,
  },
]);

export const PRODUCT_CONTRACT_REQUIREMENTS = freezeEntries([
  {
    id: "chronicle:extract-review-apply-reopen",
    domains: ["chronicle-extraction"],
  },
  {
    id: "codex:entity-relation-review-apply-reopen",
    domains: ["codex", "sqlite", "scene-persistence", "workspace-lifecycle"],
  },
  {
    id: "roundtrip:editor",
    domains: ["editor", "scene-persistence"],
  },
  {
    id: "scope-transition:chat-stream:scene",
    domains: ["chat", "scene-scope"],
  },
  {
    id: "scope-transition:chat-stream:folder",
    domains: ["chat", "scene-scope"],
  },
  {
    id: "scope-transition:chat-stream:codex",
    domains: ["chat", "codex"],
  },
  {
    id: "scope-transition:chat-stream:snippet",
    domains: ["chat", "snippet"],
  },
  {
    id: "scope-transition:editor-pending:workspace",
    domains: ["editor", "workspace-lifecycle"],
  },
  {
    id: "external-write:renderer-equivalent:clean",
    domains: ["external-write-feed", "editor"],
  },
  {
    id: "external-write:renderer-equivalent:dirty",
    domains: ["external-write-feed", "editor", "history"],
  },
  {
    id: "authoring:codex-chat-editor-history-restart",
    domains: [
      "codex",
      "chat",
      "editor",
      "history",
      "attribution",
      "scene-persistence",
    ],
  },
  {
    id: "scope-transition:chat-stream:project",
    domains: ["chat", "project-lifecycle"],
  },
  {
    id: "scope-transition:agent-stream:project",
    domains: ["chat", "project-lifecycle"],
  },
  {
    id: "scope-transition:chat-stream:workspace",
    domains: ["chat", "workspace-lifecycle"],
  },
  {
    id: "scope-transition:agent-stream:workspace",
    domains: ["chat", "workspace-lifecycle"],
  },
  {
    id: "scope-transition:editor-pending:project",
    domains: ["editor", "project-lifecycle"],
  },
  {
    id: "d2a:mcp:pre-dispatch-denial",
    domains: ["mcp", "sqlite"],
  },
  {
    id: "native-command-roundtrip:chronicle-bulk",
    domains: ["chronicle-bulk", "sqlite"],
  },
  {
    id: "native-command-roundtrip:lint-term-dictionary",
    domains: ["lint-term-dictionary", "sqlite"],
  },
  {
    id: "native-command-roundtrip:map-write-bundle",
    domains: ["map-write-bundle", "sqlite"],
  },
  {
    id: "native-command-roundtrip:project-snapshot",
    domains: ["project-snapshot", "sqlite"],
  },
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => ({
    id: journey.contracts[0],
    domains: ["narrative-maintenance"],
  })),
  ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.flatMap((journey) =>
    journey.contracts.map((id) => ({
      id,
      domains: ["narrative-maintenance"],
    })),
  ),
]);

export const PRODUCT_SCOPE_TRANSITIONS = freezeEntries([
  {
    authority: "chat-scope",
    operation: "chat-stream",
    scope: "scene",
    contractId: "scope-transition:chat-stream:scene",
  },
  {
    authority: "chat-scope",
    operation: "chat-stream",
    scope: "folder",
    contractId: "scope-transition:chat-stream:folder",
  },
  {
    authority: "chat-scope",
    operation: "chat-stream",
    scope: "project",
    contractId: "scope-transition:chat-stream:project",
  },
  {
    authority: "chat-scope",
    operation: "chat-stream",
    scope: "codex",
    contractId: "scope-transition:chat-stream:codex",
  },
  {
    authority: "chat-scope",
    operation: "chat-stream",
    scope: "snippet",
    contractId: "scope-transition:chat-stream:snippet",
  },
  {
    authority: "lifecycle",
    operation: "chat-stream",
    scope: "workspace",
    contractId: "scope-transition:chat-stream:workspace",
  },
  {
    authority: "lifecycle",
    operation: "agent-stream",
    scope: "project",
    contractId: "scope-transition:agent-stream:project",
  },
  {
    authority: "lifecycle",
    operation: "agent-stream",
    scope: "workspace",
    contractId: "scope-transition:agent-stream:workspace",
  },
  {
    authority: "lifecycle",
    operation: "editor-pending",
    scope: "project",
    contractId: "scope-transition:editor-pending:project",
  },
  {
    authority: "lifecycle",
    operation: "editor-pending",
    scope: "workspace",
    contractId: "scope-transition:editor-pending:workspace",
  },
]);

export const PRODUCT_NATIVE_PERSISTENCE_DOMAINS = freezeEntries([
  {
    domain: "chronicle-bulk",
    contractId: "native-command-roundtrip:chronicle-bulk",
  },
  {
    domain: "lint-term-dictionary",
    contractId: "native-command-roundtrip:lint-term-dictionary",
  },
  {
    domain: "map-write-bundle",
    contractId: "native-command-roundtrip:map-write-bundle",
  },
  {
    domain: "project-snapshot",
    contractId: "native-command-roundtrip:project-snapshot",
  },
]);

export const PRODUCT_INTERACTION_REQUIREMENTS = freezeEntries([
  {
    id: "chronicle-extraction->sqlite",
    domains: ["chronicle-extraction", "sqlite"],
  },
  {
    id: "sqlite->chronicle-extraction",
    domains: ["sqlite", "chronicle-extraction"],
  },
  { id: "editor->sqlite", domains: ["editor", "sqlite"] },
  { id: "sqlite->editor", domains: ["sqlite", "editor"] },
  { id: "scene-scope->chat", domains: ["scene-scope", "chat"] },
  { id: "snippet->chat", domains: ["snippet", "chat"] },
  { id: "chat->sqlite", domains: ["chat", "sqlite"] },
  {
    id: "editor->workspace-lifecycle",
    domains: ["editor", "workspace-lifecycle"],
  },
  {
    id: "sqlite->external-write-feed",
    domains: ["sqlite", "external-write-feed"],
  },
  {
    id: "external-write-feed->editor",
    domains: ["external-write-feed", "editor"],
  },
  {
    id: "external-write-feed->history",
    domains: ["external-write-feed", "history"],
  },
  { id: "codex->chat", domains: ["codex", "chat"] },
  { id: "codex->sqlite", domains: ["codex", "sqlite"] },
  { id: "sqlite->codex", domains: ["sqlite", "codex"] },
  { id: "chat->editor", domains: ["chat", "editor"] },
  { id: "editor->history", domains: ["editor", "history"] },
  {
    id: "project-lifecycle->chat",
    domains: ["project-lifecycle", "chat"],
  },
  {
    id: "workspace-lifecycle->chat",
    domains: ["workspace-lifecycle", "chat"],
  },
  {
    id: "narrative-maintenance->sqlite",
    domains: ["narrative-maintenance", "sqlite"],
  },
  {
    id: "editor->project-lifecycle",
    domains: ["editor", "project-lifecycle"],
  },
  { id: "mcp->sqlite", domains: ["mcp", "sqlite"] },
  {
    id: "chronicle-bulk->sqlite",
    domains: ["chronicle-bulk", "sqlite"],
  },
  {
    id: "sqlite->chronicle-bulk",
    domains: ["sqlite", "chronicle-bulk"],
  },
  {
    id: "lint-term-dictionary->sqlite",
    domains: ["lint-term-dictionary", "sqlite"],
  },
  {
    id: "sqlite->lint-term-dictionary",
    domains: ["sqlite", "lint-term-dictionary"],
  },
  {
    id: "map-write-bundle->sqlite",
    domains: ["map-write-bundle", "sqlite"],
  },
  {
    id: "sqlite->map-write-bundle",
    domains: ["sqlite", "map-write-bundle"],
  },
  {
    id: "project-snapshot->sqlite",
    domains: ["project-snapshot", "sqlite"],
  },
  {
    id: "sqlite->project-snapshot",
    domains: ["sqlite", "project-snapshot"],
  },
]);

/**
 * Temporary gaps must remain tracked and expiring. Active exemptions keep
 * affected execution locked in shadow mode.
 */
export const PRODUCT_CONTRACT_EXEMPTIONS = freezeEntries([]);
