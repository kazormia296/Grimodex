const freezeEntries = (entries) =>
  Object.freeze(
    entries.map((entry) =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(entry).map(([key, value]) => [
            key,
            Array.isArray(value) ? Object.freeze([...value]) : value,
          ]),
        ),
      ),
    ),
  );

export const PRODUCT_JOURNEY_CAPABILITY_ORDER = Object.freeze([
  "electron",
  "napi",
  "mcp",
]);

/**
 * Affected execution is unlocked only while catalog coverage is complete.
 * The coverage ratchet rejects missing journeys, contracts, or interactions.
 */
export const PRODUCT_JOURNEY_ROLLOUT_MODE = "affected";

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
    id: "chat-stream-workspace-switch",
    domains: ["chat", "workspace-lifecycle"],
    interactions: ["workspace-lifecycle->chat"],
    contracts: ["scope-transition:chat-stream:workspace"],
    capabilities: ["electron", "napi"],
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
    domains: ["mcp", "external-write-feed", "editor", "scene-persistence"],
    interactions: ["mcp->sqlite", "sqlite->external-write-feed"],
    contracts: ["external-write:mcp:clean", "external-write:mcp:dirty"],
    capabilities: ["electron", "napi", "mcp"],
  },
  {
    id: "chronicle-native-roundtrip",
    domains: ["chronicle"],
    interactions: ["chronicle->sqlite", "sqlite->chronicle"],
    contracts: ["roundtrip:chronicle"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "lint-native-roundtrip",
    domains: ["lint"],
    interactions: ["lint->sqlite", "sqlite->lint"],
    contracts: ["roundtrip:lint"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "map-native-roundtrip",
    domains: ["map"],
    interactions: ["map->sqlite", "sqlite->map"],
    contracts: ["roundtrip:map"],
    capabilities: ["electron", "napi"],
  },
  {
    id: "snapshot-native-roundtrip",
    domains: ["snapshot"],
    interactions: ["snapshot->sqlite", "sqlite->snapshot"],
    contracts: ["roundtrip:snapshot"],
    capabilities: ["electron", "napi"],
  },
]);

/**
 * Known coverage gaps remain explicit. Entries move into
 * PRODUCT_JOURNEY_CATALOG only when their real runner implementation and
 * contract evidence land together.
 */
export const PRODUCT_JOURNEY_COVERAGE_BACKLOG = freezeEntries([]);

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
      "electron/preload.ts",
      "electron/native/grimodex-node/**",
    ],
    forceAll: true,
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
    id: "chronicle-native-persistence",
    domains: ["chronicle", "native-persistence"],
    paths: [
      "src/features/chronicle/**",
      "src-tauri/crates/grimodex-db/src/chronicle*.rs",
    ],
  },
  {
    id: "lint-native-persistence",
    domains: ["lint", "native-persistence"],
    paths: [
      "src/features/lint/**",
      "src-tauri/crates/grimodex-db/src/lint_*.rs",
    ],
  },
  {
    id: "map-native-persistence",
    domains: ["map", "native-persistence"],
    paths: [
      "src/features/map/**",
      "src-tauri/crates/grimodex-db/src/map_writes.rs",
    ],
  },
  {
    id: "snapshot-native-persistence",
    domains: ["snapshot", "native-persistence"],
    paths: [
      "src/features/revision/**",
      "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
    ],
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
    id: "roundtrip:editor",
    domains: ["editor", "scene-persistence"],
  },
  {
    id: "scope-transition:chat-stream:scene",
    domains: ["chat", "scene-scope"],
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
    id: "scope-transition:chat-stream:workspace",
    domains: ["chat", "workspace-lifecycle"],
  },
  {
    id: "scope-transition:editor-pending:project",
    domains: ["editor", "project-lifecycle"],
  },
  {
    id: "external-write:mcp:clean",
    domains: ["mcp", "external-write-feed", "editor", "scene-persistence"],
  },
  {
    id: "external-write:mcp:dirty",
    domains: ["mcp", "external-write-feed", "editor", "scene-persistence"],
  },
  {
    id: "roundtrip:chronicle",
    domains: ["chronicle", "sqlite"],
  },
  {
    id: "roundtrip:lint",
    domains: ["lint", "sqlite"],
  },
  {
    id: "roundtrip:map",
    domains: ["map", "sqlite"],
  },
  {
    id: "roundtrip:snapshot",
    domains: ["snapshot", "sqlite"],
  },
]);

export const PRODUCT_SCOPE_TRANSITIONS = freezeEntries([
  {
    operation: "chat-stream",
    scope: "scene",
    contractId: "scope-transition:chat-stream:scene",
  },
  {
    operation: "chat-stream",
    scope: "project",
    contractId: "scope-transition:chat-stream:project",
  },
  {
    operation: "chat-stream",
    scope: "workspace",
    contractId: "scope-transition:chat-stream:workspace",
  },
  {
    operation: "editor-pending",
    scope: "project",
    contractId: "scope-transition:editor-pending:project",
  },
  {
    operation: "editor-pending",
    scope: "workspace",
    contractId: "scope-transition:editor-pending:workspace",
  },
]);

export const PRODUCT_NATIVE_PERSISTENCE_DOMAINS = freezeEntries([
  {
    domain: "editor",
    contractId: "roundtrip:editor",
  },
  {
    domain: "chronicle",
    contractId: "roundtrip:chronicle",
  },
  {
    domain: "lint",
    contractId: "roundtrip:lint",
  },
  {
    domain: "map",
    contractId: "roundtrip:map",
  },
  {
    domain: "snapshot",
    contractId: "roundtrip:snapshot",
  },
]);

export const PRODUCT_INTERACTION_REQUIREMENTS = freezeEntries([
  { id: "editor->sqlite", domains: ["editor", "sqlite"] },
  { id: "sqlite->editor", domains: ["sqlite", "editor"] },
  { id: "scene-scope->chat", domains: ["scene-scope", "chat"] },
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
    id: "editor->project-lifecycle",
    domains: ["editor", "project-lifecycle"],
  },
  { id: "mcp->sqlite", domains: ["mcp", "sqlite"] },
  { id: "chronicle->sqlite", domains: ["chronicle", "sqlite"] },
  { id: "sqlite->chronicle", domains: ["sqlite", "chronicle"] },
  { id: "lint->sqlite", domains: ["lint", "sqlite"] },
  { id: "sqlite->lint", domains: ["sqlite", "lint"] },
  { id: "map->sqlite", domains: ["map", "sqlite"] },
  { id: "sqlite->map", domains: ["sqlite", "map"] },
  { id: "snapshot->sqlite", domains: ["snapshot", "sqlite"] },
  { id: "sqlite->snapshot", domains: ["sqlite", "snapshot"] },
]);

/**
 * Exemptions are intentionally empty at foundation time. A temporary entry
 * must name a known contract/interaction and include a reason plus expiry.
 */
export const PRODUCT_CONTRACT_EXEMPTIONS = freezeEntries([]);
