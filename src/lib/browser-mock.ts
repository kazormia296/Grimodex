// Use ASM.js build (pure JS, no WASM) to avoid Emscripten WASM loader errors in Vite dev
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlValue } from "sql.js";
import schemaContract from "@/db/generated/schema-contract.json";
import {
  resolveActiveOpenaiCompatibleEndpoint,
  type AiProvider,
  type AiSettings,
  type ToolProtocolMode,
} from "@/features/chat/types";
import { isAinoveristV1Model } from "@/features/chat/aiNovelist";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import {
  createBrowserAiTransport,
  browserProviderRequiresApiKey,
  fetchModels,
  testConnection,
  sendChatWithTools,
  type BrowserAiOperation,
  type BrowserAiRequest,
  type BrowserAiStreamSink,
  type BrowserAiTransport,
} from "@/lib/browser-ai";
import { lintTextBrowser } from "@/lib/browser-lint";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
} from "@/features/chat/agent/agentTypes";
import {
  getScreenshotLanguage,
  isScreenshotStagingActive,
} from "@/screenshot-scenes/screenshotMode";
import { SCREENSHOT_SEED_CONTENT } from "@/screenshot-scenes/screenshotSeedContent";
import {
  bytesToHex,
  computeEventHash,
  GENESIS_HASH,
  hexToBytes,
} from "@/features/timelapse/hashChain";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import sampleProjectJa from "../../src-tauri/resources/sample_project/v1.json";
import sampleProjectEn from "../../src-tauri/resources/sample_project/v1_en.json";

type BrowserSchemaTable = {
  kind: string;
  columns: Record<string, unknown>;
  createSql: string;
};

type BrowserSchemaIndex = {
  table: string;
  createSql: string;
};

type BrowserSchemaContract = {
  tables: Record<string, BrowserSchemaTable>;
  indexes: Record<string, BrowserSchemaIndex>;
  triggers: Record<string, string>;
};

type BrowserPlotThreadSnapshot = {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: string;
  startNodeId: string | null;
  endNodeId: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserPlotLinkSnapshot = {
  id: string;
  threadId: string;
  nodeId: string;
  phaseType: string;
  note: string | null;
  sortOrder: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserPlotBranchSnapshot = {
  id: string;
  projectId: string;
  fromThreadId: string;
  toThreadId: string;
  atNodeId: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
};

type BrowserPlotBranchTransition = {
  before: BrowserPlotBranchSnapshot | null;
  after: BrowserPlotBranchSnapshot | null;
};

// Keep this list aligned with the native-only contract surfaces asserted by
// src/db/schema.contract.test.ts. BrowserMock uses every other canonical
// CREATE statement so browser editing exercises the same renderer schema.
const RUST_ONLY_BROWSER_TABLES = new Set([
  "chat_message_chunks",
  "event_chunks",
  "fts_meta",
  "codex_fts",
  "codex_fts_en",
  "snippets_fts",
  "snippets_fts_en",
  "chat_messages_fts",
  "chat_messages_fts_en",
  "tree_nodes_fts",
  "tree_nodes_fts_en",
  "post_effect_annotations_fts",
  "post_effect_annotations_fts_en",
  "undo_journal",
]);

function executableCreateSql(createSql: string, columnNames: string[]): string {
  // sqlite_master preserves line comments, while the generated contract
  // normalizes their line breaks to spaces. Remove only those comments so the
  // canonical statement remains executable after normalization.
  if (!createSql.includes("--")) return createSql;
  const escapedColumnNames = columnNames.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const nextSqlToken = [
    ...escapedColumnNames.map(
      (name) => `${name}\\s+(?:TEXT|INTEGER|REAL|BLOB)\\b`,
    ),
    "FOREIGN KEY\\b",
    "PRIMARY KEY\\b",
    "UNIQUE\\b",
    "CHECK\\b",
  ].join("|");
  return createSql.replace(
    new RegExp(`-- .*?(?=(?:${nextSqlToken}))`, "giu"),
    "",
  );
}

function buildBrowserSchemaDdl(contract: BrowserSchemaContract): string {
  const tables = Object.entries(contract.tables).filter(
    ([name, table]) =>
      table.kind === "table" && !RUST_ONLY_BROWSER_TABLES.has(name),
  );
  const tableStatements = tables.map(([, table]) =>
    executableCreateSql(table.createSql, Object.keys(table.columns)),
  );
  const indexStatements = Object.values(contract.indexes)
    .filter((index) => !RUST_ONLY_BROWSER_TABLES.has(index.table))
    .map((index) => index.createSql);
  const triggerStatements = Object.values(contract.triggers).filter(
    (createSql) =>
      ![...RUST_ONLY_BROWSER_TABLES].some((tableName) =>
        new RegExp(
          `\\b${tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "u",
        ).test(createSql),
      ),
  );
  return `${[...tableStatements, ...indexStatements, ...triggerStatements].join(
    ";\n",
  )};`;
}

type BrowserDbStatementResult = {
  rows: Record<string, unknown>[];
  mutated: boolean;
};

function executeBrowserDbStatement(
  db: Database,
  sql: string,
  params: SqlValue[],
): BrowserDbStatementResult {
  const stmt = db.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  let mutated = false;
  db.updateHook(() => {
    mutated = true;
  });
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
  } finally {
    db.updateHook(null);
    stmt.free();
  }
  return { rows, mutated };
}

function methodAssumesMutation(method: unknown): boolean {
  // Drizzle uses `run` for non-returning writes. Returning writes use a row
  // method (`all`/`get`) and are detected by SQLite's update hook instead.
  return method === "run";
}

const SCHEMA_DDL = buildBrowserSchemaDdl(
  schemaContract as unknown as BrowserSchemaContract,
);
const IDEMPOTENCY_LEDGER_MIGRATION_DDL = `
  CREATE TABLE IF NOT EXISTS idempotency_requests (
    domain TEXT NOT NULL,
    request_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL,
    tombstone_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (domain, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_idempotency_requests_project_created
    ON idempotency_requests(project_id, created_at);
`;
const GLOBAL_SETTINGS_KEY = "grimodex:global-settings";
const ROLE_PROVIDERS_SETTING_KEY = "aiModel.roleProviders";
const ROLE_MODEL_SETTING_PREFIX = "aiModel.role.";
const BROWSER_AI_PROVIDERS = new Set<AiProvider>(BROWSER_DIRECT_AI_PROVIDERS);
const BROWSER_WORKSPACE_PATH = "/dev/workspace";
const TUTORIAL_PROJECT_ID = "grimodex-tutorial-project";

interface BrowserSampleSeed {
  project: {
    title: string;
    genre?: string | null;
    ai_instructions?: string | null;
  };
  tree_nodes: Array<{
    id: string;
    parent_id?: string | null;
    node_type: string;
    title: string;
    synopsis?: string | null;
    sort_order: string;
    status?: string | null;
    content?: string | null;
    story_time_order?: string | null;
    story_time_label?: string | null;
  }>;
  codex_entries: Array<{
    id: string;
    type: string;
    name: string;
    aliases?: string | null;
    summary?: string | null;
    content?: string | null;
    notes?: string | null;
    context_mode?: string | null;
  }>;
  chat_sessions: Array<{
    id: string;
    node_id?: string | null;
    title: string;
    model: string;
  }>;
  chat_messages: Array<{
    id: string;
    session_id: string;
    role: string;
    content: string;
  }>;
  foreshadows: Array<{
    id: string;
    title: string;
    intent?: string | null;
    notes?: string | null;
    payoff_scene_id?: string | null;
  }>;
  snippets: Array<{
    id: string;
    title: string;
    content: string;
    content_source?: string | null;
  }>;
  foreshadow_setups: Array<{
    id: string;
    foreshadow_id: string;
    scene_id: string;
    from_pos: number;
    to_pos: number;
    kind: string;
    strength?: string | null;
    attribution: string;
  }>;
  authorship_spans: Array<{
    id: string;
    node_id: string;
    from_pos: number;
    to_pos: number;
    source: string;
    model?: string | null;
    timestamp?: string | null;
  }>;
}

const SAMPLE_PROJECT_JA = sampleProjectJa as BrowserSampleSeed;
const SAMPLE_PROJECT_EN = sampleProjectEn as BrowserSampleSeed;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Old Web Editor builds exposed desktop provider routing. Keep supported BYOK /
 * local role selections, but remove hidden cross-provider routes that the
 * editor-only browser runtime cannot execute. The paired model is removed too:
 * without its provider it could otherwise be sent to the active provider under
 * a foreign model id.
 */
function normalizeBrowserGlobalSettings(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(value.userPreferences)) return value;
  const preferences = value.userPreferences;
  const rawRoleProviders = preferences[ROLE_PROVIDERS_SETTING_KEY];
  if (typeof rawRoleProviders !== "string") return value;

  let parsedRoleProviders: unknown;
  try {
    parsedRoleProviders = JSON.parse(rawRoleProviders);
  } catch {
    return value;
  }
  if (!isRecord(parsedRoleProviders)) return value;

  const nextRoleProviders = { ...parsedRoleProviders };
  const nextPreferences = { ...preferences };
  let changed = false;
  for (const [role, override] of Object.entries(parsedRoleProviders)) {
    if (!isRecord(override) || typeof override.provider !== "string") {
      continue;
    }
    const provider = override.provider.trim() as AiProvider;
    if (!provider || BROWSER_AI_PROVIDERS.has(provider)) continue;
    delete nextRoleProviders[role];
    delete nextPreferences[`${ROLE_MODEL_SETTING_PREFIX}${role}`];
    changed = true;
  }
  if (!changed) return value;

  nextPreferences[ROLE_PROVIDERS_SETTING_KEY] =
    JSON.stringify(nextRoleProviders);
  return { ...value, userPreferences: nextPreferences };
}

function defaultBrowserGlobalSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    recentWorkspaces: [],
    lastActiveWorkspace: null,
    theme: "system",
    uiLanguage: "ja",
    uiScale: 100,
    showLauncherOnStartup: false,
    trustedWorkspaces: [],
    hasSeenWelcome: false,
  };
  if (!isScreenshotStagingActive()) return settings;

  return {
    ...settings,
    recentWorkspaces: [
      {
        path: BROWSER_WORKSPACE_PATH,
        lastOpened: new Date().toISOString(),
      },
    ],
    lastActiveWorkspace: BROWSER_WORKSPACE_PATH,
  };
}

function seedBrowserTutorialProject(
  db: Database,
  language: string,
  aiPolicy: string,
): void {
  const isEnglish = language === "en";
  const seed = isEnglish ? SAMPLE_PROJECT_EN : SAMPLE_PROJECT_JA;
  const sampleLanguage = isEnglish ? "en" : "ja";
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const emptyDoc = '{"type":"doc","content":[]}';
  // A project switch can leave a pending renderer write that republishes an
  // old tutorial entity under the user's active Project. Never delete that
  // user-owned row or reuse its global primary key: each tutorial restart gets
  // a fresh entity generation instead.
  const entityPrefix = `${TUTORIAL_PROJECT_ID}:${crypto.randomUUID()}`;
  const entityId = (seedId: string) => `${entityPrefix}:${seedId}`;

  db.run("BEGIN IMMEDIATE");
  try {
    // The browser runtime owns one persistent database. Recreate only its
    // dedicated tutorial Project so existing manuscripts remain untouched.
    // codex entries/field definitions have RESTRICT composite FKs to
    // codex_types, while all three tables cascade from projects. Remove both
    // dependants first so SQLite never has to choose an unsafe cascade order
    // during a tutorial restart.
    db.run("DELETE FROM codex_detail_definitions WHERE project_id = ?", [
      TUTORIAL_PROJECT_ID,
    ]);
    db.run("DELETE FROM codex_entries WHERE project_id = ?", [
      TUTORIAL_PROJECT_ID,
    ]);
    db.run("DELETE FROM projects WHERE id = ?", [TUTORIAL_PROJECT_ID]);
    db.run(
      `INSERT INTO projects
        (id, title, genre, language, ai_instructions, ai_policy, is_sample, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        TUTORIAL_PROJECT_ID,
        seed.project.title,
        seed.project.genre ?? null,
        sampleLanguage,
        seed.project.ai_instructions ?? null,
        aiPolicy,
        now,
        now,
      ],
    );

    for (const node of seed.tree_nodes) {
      const content = node.content ?? emptyDoc;
      db.run(
        `INSERT INTO tree_nodes
          (id, project_id, parent_id, node_type, title, synopsis, sort_order,
           status, content, char_count, story_time_order, story_time_label,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(node.id),
          TUTORIAL_PROJECT_ID,
          node.parent_id ? entityId(node.parent_id) : null,
          node.node_type,
          node.title,
          node.synopsis ?? null,
          node.sort_order,
          node.status ?? null,
          content,
          countSceneBodyCharsFromJson(content),
          node.story_time_order ?? null,
          node.story_time_label ?? null,
          now,
          now,
        ],
      );
    }

    for (const entry of seed.codex_entries) {
      db.run(
        `INSERT INTO codex_entries
          (id, project_id, type, name, aliases, summary, content, notes,
           context_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(entry.id),
          TUTORIAL_PROJECT_ID,
          entry.type,
          entry.name,
          entry.aliases ?? null,
          entry.summary ?? null,
          entry.content ?? emptyDoc,
          entry.notes ?? null,
          entry.context_mode ?? "mentioned",
          now,
          now,
        ],
      );
    }

    for (const session of seed.chat_sessions) {
      db.run(
        `INSERT INTO chat_sessions
          (id, project_id, node_id, title, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(session.id),
          TUTORIAL_PROJECT_ID,
          session.node_id ? entityId(session.node_id) : null,
          session.title,
          session.model,
          now,
          now,
        ],
      );
    }

    for (const message of seed.chat_messages) {
      db.run(
        `INSERT INTO chat_messages
          (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          entityId(message.id),
          entityId(message.session_id),
          message.role,
          message.content,
          now,
        ],
      );
    }

    for (const foreshadow of seed.foreshadows) {
      db.run(
        `INSERT INTO foreshadows
          (id, project_id, title, intent, notes, payoff_scene_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(foreshadow.id),
          TUTORIAL_PROJECT_ID,
          foreshadow.title,
          foreshadow.intent ?? null,
          foreshadow.notes ?? null,
          foreshadow.payoff_scene_id
            ? entityId(foreshadow.payoff_scene_id)
            : null,
          nowMs,
          nowMs,
        ],
      );
    }

    for (const snippet of seed.snippets) {
      db.run(
        `INSERT INTO snippets
          (id, project_id, title, content, content_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(snippet.id),
          TUTORIAL_PROJECT_ID,
          snippet.title,
          snippet.content,
          snippet.content_source ?? null,
          now,
          now,
        ],
      );
    }

    for (const setup of seed.foreshadow_setups) {
      db.run(
        `INSERT INTO foreshadow_setups
          (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
           attribution, is_orphan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          entityId(setup.id),
          entityId(setup.foreshadow_id),
          entityId(setup.scene_id),
          setup.from_pos,
          setup.to_pos,
          setup.kind,
          setup.strength ?? null,
          setup.attribution,
          nowMs,
          nowMs,
        ],
      );
    }

    for (const span of seed.authorship_spans) {
      db.run(
        `INSERT INTO authorship_spans
          (id, node_id, from_pos, to_pos, source, model, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entityId(span.id),
          entityId(span.node_id),
          span.from_pos,
          span.to_pos,
          span.source,
          span.model ?? null,
          span.timestamp ?? null,
        ],
      );
    }

    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original seeding error.
    }
    throw error;
  }
}

export interface BrowserMockOptions {
  databaseBytes?: Uint8Array;
  onDatabaseDirty?: () => void;
  authorizeAiRequest?: (
    request: BrowserAiAuthorizationRequest,
  ) => Promise<void>;
  aiTransport?: BrowserAiTransport;
}

export interface BrowserAiAuthorizationRequest {
  operation: BrowserAiOperation | "agent" | "connection";
  provider: AiProvider;
  model: string;
  endpointId?: string | null;
  ollamaEndpoint?: string | null;
  baseUrl?: string | null;
  apiVariant?: string | null;
  hasApiKey: boolean;
}

export interface BrowserMock {
  invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
}

export interface PersistentBrowserMock extends BrowserMock {
  exportDatabase(): Uint8Array;
  close(): void;
}

interface TimelapseAppendEvent {
  eventUid: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

async function browserPayloadFingerprint(
  domain: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const canonical = JSON.stringify(canonicalizeJson([domain, payload]));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createBrowserMock(
  options: BrowserMockOptions = {},
): Promise<PersistentBrowserMock> {
  const SQL = await initSqlJs();
  const isNewDatabase = options.databaseBytes === undefined;
  const db: Database = new SQL.Database(options.databaseBytes);
  db.run("PRAGMA foreign_keys = ON;");
  if (isNewDatabase) {
    // The ASM.js build has a fixed shared heap. A compact page size keeps
    // repeated in-memory BrowserMock instances within that heap even with the
    // complete renderer schema.
    db.run("PRAGMA page_size = 1024;");
    db.run(SCHEMA_DDL);
  }
  const ledgerTableExists =
    db.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_requests'",
    ).length > 0;
  const ledgerIndexExists =
    db.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_idempotency_requests_project_created'",
    ).length > 0;
  if (!ledgerTableExists || !ledgerIndexExists) {
    // Persisted Browser workspaces predate the durable create ledger. Keep
    // this migration content-free and idempotent, mirroring native migrate.rs.
    db.run(IDEMPOTENCY_LEDGER_MIGRATION_DDL);
    options.onDatabaseDirty?.();
  }
  db.run(`CREATE TEMP TABLE grimodex_connection_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    epoch TEXT NOT NULL
  )`);
  db.run(
    "INSERT INTO temp.grimodex_connection_meta (singleton, epoch) VALUES (1, ?)",
    [crypto.randomUUID()],
  );

  const now = new Date().toISOString();
  if (isNewDatabase) {
    // Seed default project only — folder/scenes are no longer auto-created
    // so a fresh workspace stays empty (mirrors src-tauri/src/database.rs).
    db.run(
      "INSERT INTO projects (id, title, language, created_at, updated_at) VALUES ('default-project', 'Untitled Project', 'ja', ?, ?)",
      [now, now],
    );

    seedBuiltinCodexTypes(db, now);
    if (isScreenshotStagingActive()) {
      await seedScreenshotWorkspace(db, now);
    }
  }

  const AI_SETTINGS_KEY = "grimodex:ai-settings";
  // Browser BYOK credentials are deliberately scoped to this runtime. They
  // are never written to localStorage or included in the persisted SQL image.
  const apiKeys = new Map<string, string>();
  try {
    // Remove credentials left by older browser-mock builds. They are not
    // imported into memory: a reload must always require the key again.
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("grimodex:api-key:")) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  const aiTransport = options.aiTransport ?? createBrowserAiTransport();
  const authorizeAiRequest =
    options.authorizeAiRequest ??
    (async (request: BrowserAiAuthorizationRequest): Promise<void> => {
      if (
        browserProviderRequiresApiKey(request.provider) &&
        !request.hasApiKey
      ) {
        throw new Error(
          `AIは未接続です。APIキーを設定してください: ${request.provider}`,
        );
      }
      // Keep consent UI state out of the database adapter's eager import
      // graph. Most renderer calls are DB-only, and loading the broker only
      // when AI is actually requested also prevents unrelated async DB reads
      // from crossing a test/environment teardown boundary.
      const { authorizeBrowserAiRequest } =
        await import("@/features/ai-policy/browserAiDisclosure");
      await authorizeBrowserAiRequest(request);
    });

  function requireBrowserAiProvider(value: unknown): AiProvider {
    const provider = String(value ?? "").trim() as AiProvider;
    if (!BROWSER_AI_PROVIDERS.has(provider)) {
      throw new Error(
        `Provider "${provider || "unknown"}" is not supported in browser mode`,
      );
    }
    return provider;
  }

  function optionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function validateExpectedOllamaEndpoint(
    provider: AiProvider,
    configuredEndpoint: unknown,
    expectedEndpoint: unknown,
  ): void {
    if (provider !== "ollama" || expectedEndpoint == null) return;
    if (typeof expectedEndpoint !== "string") {
      throw new Error("expectedOllamaEndpoint must be a string or null");
    }
    const expected = expectedEndpoint.trim().replace(/\/+$/u, "");
    const configured = String(configuredEndpoint ?? "")
      .trim()
      .replace(/\/+$/u, "");
    if (!expected) {
      throw new Error("expected Ollama endpoint snapshot must not be empty");
    }
    if (expected !== configured) {
      throw new Error(
        `Ollama endpoint changed before request; expected ${expected}, configured ${configured}`,
      );
    }
  }

  function apiKeySlot(provider: string, endpointId?: string | null): string {
    return endpointId ? `${provider}:${endpointId}` : provider;
  }

  const defaultBrowserAiSettings = (): Record<string, unknown> => ({
    provider: "ollama",
    model: "",
    ollamaEndpoint: "http://localhost:11434",
    thinkingEnabled: true,
  });

  function normalizeBrowserAiSettings(value: unknown): Record<string, unknown> {
    const parsed =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const httpSettings = { ...parsed };
    delete httpSettings.browserAiMode;
    const provider = String(parsed.provider ?? "").trim() as AiProvider;
    if (BROWSER_AI_PROVIDERS.has(provider)) {
      return {
        ...defaultBrowserAiSettings(),
        ...httpSettings,
        provider,
      };
    }
    // Native-only selections must never survive as an apparently connected
    // Web Editor setting.
    return {
      ...defaultBrowserAiSettings(),
      ...httpSettings,
      provider: "ollama",
      model: "",
      modelApiVariant: null,
    };
  }

  function handleGetAiSettings(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(AI_SETTINGS_KEY);
      if (raw) {
        const normalized = normalizeBrowserAiSettings(JSON.parse(raw));
        if (JSON.stringify(normalized) !== raw) {
          localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(normalized));
        }
        return normalized;
      }
    } catch {
      // noop
    }
    return defaultBrowserAiSettings();
  }

  function handleSaveAiSettings(args: Record<string, unknown>): void {
    const settings = args.settings as Record<string, unknown>;
    requireBrowserAiProvider(settings?.provider);
    const normalized = normalizeBrowserAiSettings(settings);
    try {
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(normalized));
    } catch {
      // noop
    }
  }

  function handleSaveApiKey(args: Record<string, unknown>): void {
    const provider = requireBrowserAiProvider(args.provider);
    const key = String(args.key ?? "").trim();
    if (!provider || !key) {
      throw new Error("provider and key are required");
    }
    apiKeys.set(apiKeySlot(provider, optionalString(args.endpointId)), key);
  }

  function handleGetApiKey(args: Record<string, unknown>): string | null {
    const provider = requireBrowserAiProvider(args.provider);
    const endpointId = optionalString(args.endpointId);
    return (
      apiKeys.get(apiKeySlot(provider, endpointId)) ??
      apiKeys.get(apiKeySlot(provider)) ??
      null
    );
  }

  function hasAiProviderAccess(args: Record<string, unknown>): boolean {
    const provider = requireBrowserAiProvider(args.provider);
    return (
      !browserProviderRequiresApiKey(provider) || handleGetApiKey(args) !== null
    );
  }

  function handleDeleteApiKey(args: Record<string, unknown>): void {
    const provider = requireBrowserAiProvider(args.provider);
    const endpointId = optionalString(args.endpointId);
    if (endpointId) {
      apiKeys.delete(apiKeySlot(provider, endpointId));
    } else {
      for (const slot of apiKeys.keys()) {
        if (slot === provider || slot.startsWith(`${provider}:`)) {
          apiKeys.delete(slot);
        }
      }
    }
  }

  function resolveAiRequest(
    args: Record<string, unknown>,
    operation: BrowserAiOperation,
  ): BrowserAiRequest {
    const settings = handleGetAiSettings();
    const provider = requireBrowserAiProvider(
      args.resolvedProvider ?? args.provider ?? settings.provider,
    );
    validateExpectedOllamaEndpoint(
      provider,
      settings.ollamaEndpoint,
      args.expectedOllamaEndpoint,
    );
    const model =
      optionalString(args.model) ?? optionalString(settings.model) ?? "";
    if (!model) {
      throw new Error(
        "AIモデルを設定してください。AIはWeb Editorに付属していません。",
      );
    }
    const requestedEndpointId = optionalString(
      args.resolvedEndpointId ?? args.endpointId,
    );
    const compatibleEndpoint =
      provider === "openai-compatible"
        ? resolveActiveOpenaiCompatibleEndpoint(
            settings as unknown as AiSettings,
            requestedEndpointId,
          )
        : undefined;
    const endpointId =
      provider === "openai-compatible"
        ? (compatibleEndpoint?.id ?? requestedEndpointId)
        : requestedEndpointId;
    const baseUrl = compatibleEndpoint?.baseUrl?.trim().replace(/\/+$/, "");
    const explicitApiVariant = optionalString(args.apiVariant);
    const persistedApiVariant =
      provider === settings.provider
        ? optionalString(settings.modelApiVariant)
        : null;
    const requestedApiVariant =
      explicitApiVariant ??
      (provider === "openai-compatible"
        ? (compatibleEndpoint?.apiVariant ?? null)
        : provider === "ai-novelist"
          ? (persistedApiVariant ??
            (isAinoveristV1Model(model) ? "v1" : "legacy"))
          : persistedApiVariant);
    // Web Editor currently implements chat-style HTTP transports, not the
    // desktop Responses API path. Fall back explicitly instead of silently
    // attaching a stale desktop "responses" variant to a chat request.
    const apiVariant =
      requestedApiVariant === "responses"
        ? provider === "ai-novelist"
          ? isAinoveristV1Model(model)
            ? "v1"
            : "legacy"
          : null
        : requestedApiVariant;
    const messages = Array.isArray(args.messages)
      ? args.messages.map((message) => {
          const value = message as Record<string, unknown>;
          return {
            role: String(value.role ?? "user"),
            content: String(value.content ?? ""),
          };
        })
      : [];
    const requestMaxOutputTokens = Number(args.requestMaxOutputTokens);
    return {
      operation,
      provider,
      model,
      endpointId,
      apiKey: handleGetApiKey({ provider, endpointId }) ?? undefined,
      messages,
      maxOutputTokens:
        Number.isInteger(requestMaxOutputTokens) && requestMaxOutputTokens > 0
          ? requestMaxOutputTokens
          : null,
      ollamaEndpoint: optionalString(settings.ollamaEndpoint),
      baseUrl: baseUrl || null,
      apiVariant,
      toolProtocolMode:
        (settings.toolProtocolMode as ToolProtocolMode | undefined) ?? "auto",
    };
  }

  async function authorizeResolvedRequest(
    request: BrowserAiRequest,
    operation: BrowserAiAuthorizationRequest["operation"] = request.operation,
  ): Promise<void> {
    await authorizeAiRequest({
      operation,
      provider: request.provider,
      model: request.model,
      endpointId: request.endpointId,
      ollamaEndpoint: request.ollamaEndpoint,
      baseUrl: request.baseUrl,
      apiVariant: request.apiVariant,
      hasApiKey: Boolean(request.apiKey),
    });
  }

  async function handleListAiModels(
    args: Record<string, unknown>,
  ): Promise<Array<{ id: string; name: string }>> {
    const settings = handleGetAiSettings();
    const provider = requireBrowserAiProvider(
      args.provider ?? settings.provider,
    );
    const endpointId = optionalString(args.endpointId);
    const selectedModelId = optionalString(args.selectedModelId);
    const ollamaEndpoint = optionalString(settings.ollamaEndpoint);
    validateExpectedOllamaEndpoint(
      provider,
      ollamaEndpoint,
      args.expectedOllamaEndpoint,
    );
    const compatibleEndpoint =
      provider === "openai-compatible"
        ? resolveActiveOpenaiCompatibleEndpoint(
            settings as unknown as AiSettings,
            endpointId,
          )
        : undefined;
    const resolvedEndpointId =
      provider === "openai-compatible"
        ? (compatibleEndpoint?.id ?? endpointId)
        : endpointId;
    const baseUrl =
      compatibleEndpoint?.baseUrl?.trim().replace(/\/+$/, "") ?? null;
    const apiKey =
      handleGetApiKey({ provider, endpointId: resolvedEndpointId }) ?? "";
    await authorizeAiRequest({
      operation: "connection",
      provider,
      model: "",
      endpointId: resolvedEndpointId,
      ollamaEndpoint,
      baseUrl,
      apiVariant: compatibleEndpoint?.apiVariant ?? null,
      hasApiKey: Boolean(apiKey),
    });

    const listRequest: BrowserAiRequest = {
      operation: "chat",
      provider,
      model: selectedModelId ?? "",
      apiKey,
      messages: [],
      ollamaEndpoint,
      selectedModelId,
      baseUrl,
      apiVariant: compatibleEndpoint?.apiVariant ?? null,
    };
    if (aiTransport.listModels) {
      return aiTransport.listModels(listRequest);
    }
    return fetchModels(provider, apiKey, listRequest);
  }

  async function handleTestAiConnection(
    args: Record<string, unknown>,
  ): Promise<string> {
    const provider = args.provider as AiProvider;
    const request = resolveAiRequest(
      {
        ...args,
        provider,
        messages: [
          { role: "user", content: "Reply with exactly: Connection OK" },
        ],
      },
      "chat",
    );
    await authorizeResolvedRequest(request, "connection");
    return testConnection(
      request.provider,
      request.model,
      request.apiKey ?? "",
      {
        ollamaEndpoint: request.ollamaEndpoint,
        baseUrl: request.baseUrl,
        apiVariant: request.apiVariant,
      },
    );
  }

  async function handleSendChatMessage(
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<BrowserAiTransport["complete"]>>> {
    const request = resolveAiRequest(args, "chat");
    await authorizeResolvedRequest(request);
    return aiTransport.complete(request);
  }

  async function handleSendAgentMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const request = resolveAiRequest(args, "chat");
    await authorizeResolvedRequest(request, "agent");

    const messages = args.messages as AgentMessagePayload[];
    const tools = args.tools as AgentToolDefinition[];
    if (aiTransport.completeAgent) {
      return aiTransport.completeAgent(request, messages, tools);
    }
    return sendChatWithTools(
      request.provider,
      request.model,
      request.apiKey ?? "",
      messages,
      tools,
      request.toolProtocolMode ?? "auto",
      {
        ollamaEndpoint: request.ollamaEndpoint,
        baseUrl: request.baseUrl,
        apiVariant: request.apiVariant,
      },
    );
  }

  function emitBrowserAiEvent(
    channel: string,
    detail: Record<string, unknown>,
  ): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(channel, { detail }));
  }

  async function handleAiStream(
    args: Record<string, unknown>,
    operation: BrowserAiOperation,
  ): Promise<void> {
    const request = resolveAiRequest(args, operation);
    await authorizeResolvedRequest(request);
    const channel = operation === "chat" ? "chat" : "inline-ai";
    let doneEmitted = false;
    const sink: BrowserAiStreamSink = {
      text(delta, blockType = "text") {
        if (!delta) return;
        emitBrowserAiEvent(`${channel}:stream-chunk`, {
          delta,
          block_type: blockType,
        });
      },
      done(payload) {
        if (doneEmitted) return;
        doneEmitted = true;
        emitBrowserAiEvent(`${channel}:stream-done`, {
          stop_reason: payload.stopReason,
          input_tokens: payload.inputTokens ?? null,
          output_tokens: payload.outputTokens ?? null,
        });
      },
    };

    try {
      if (aiTransport.stream) {
        await aiTransport.stream(request, sink);
      } else {
        const response = await aiTransport.complete(request);
        for (const block of response.blocks) {
          if (block.type === "text" || block.type === "thinking") {
            sink.text(block.content, block.type);
          }
        }
        sink.done({
          stopReason: response.stopReason,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        });
      }
      if (!doneEmitted) sink.done({ stopReason: "end_turn" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitBrowserAiEvent(`${channel}:stream-error`, { message });
      throw error;
    }
  }

  function handleDbExecute(args: Record<string, unknown>): {
    rows: Record<string, unknown>[];
  } {
    const sql = args.sql as string;
    const params = args.params as SqlValue[];
    const result = executeBrowserDbStatement(db, sql, params);

    if (methodAssumesMutation(args.method) || result.mutated) {
      options.onDatabaseDirty?.();
    }

    return { rows: result.rows };
  }

  function lintIgnoreRowsToWire(
    rows: Record<string, unknown>[],
  ): Array<Record<string, unknown>> {
    return rows.map((row) => ({
      id: String(row.id),
      ruleId: String(row.rule_id),
      sceneId: String(row.scene_id),
      textSnippet: String(row.text_snippet),
      contextBefore: String(row.context_before),
      contextAfter: String(row.context_after),
      note: row.note == null ? null : String(row.note),
      createdAt: Number(row.created_at ?? 0),
      sceneTitle: row.scene_title == null ? null : String(row.scene_title),
    }));
  }

  function handleLintIgnoreList(args: Record<string, unknown>) {
    const result = handleDbExecute({
      sql: `SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                   l.context_before, l.context_after, l.note, l.created_at,
                   t.title AS scene_title
              FROM lint_ignored_diagnostics l
              LEFT JOIN tree_nodes t ON t.id = l.scene_id
             WHERE t.project_id = ? OR t.project_id IS NULL
             ORDER BY t.title IS NULL, t.title, l.created_at DESC`,
      params: [String(args.projectId)],
      method: "all",
    });
    return lintIgnoreRowsToWire(result.rows);
  }

  function handleLintIgnoreListScene(args: Record<string, unknown>) {
    const result = handleDbExecute({
      sql: `SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                   l.context_before, l.context_after, l.note, l.created_at,
                   t.title AS scene_title
             FROM lint_ignored_diagnostics l
              LEFT JOIN tree_nodes t ON t.id = l.scene_id
             WHERE l.scene_id = ? AND t.project_id = ?
             ORDER BY l.created_at DESC`,
      params: [String(args.sceneId), String(args.projectId)],
      method: "all",
    });
    return lintIgnoreRowsToWire(result.rows);
  }

  function handleLintIgnoreCreate(args: Record<string, unknown>) {
    const payload = args.payload as Record<string, unknown>;
    const scene = handleDbExecute({
      sql: `SELECT id FROM tree_nodes
             WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
      params: [String(payload.sceneId), String(payload.projectId)],
      method: "all",
    });
    if (scene.rows.length === 0) {
      throw new Error("lint ignore scene is not in the requested project");
    }
    handleDbExecute({
      sql: `INSERT INTO lint_ignored_diagnostics
             (id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        String(payload.id),
        String(payload.ruleId),
        String(payload.sceneId),
        String(payload.textSnippet),
        String(payload.contextBefore),
        String(payload.contextAfter),
        payload.note == null ? null : String(payload.note),
        Number(payload.createdAt),
      ],
      method: "run",
    });
    const result = handleDbExecute({
      sql: `SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                   l.context_before, l.context_after, l.note, l.created_at,
                   t.title AS scene_title
              FROM lint_ignored_diagnostics l
              LEFT JOIN tree_nodes t ON t.id = l.scene_id
             WHERE l.id = ?`,
      params: [String(payload.id)],
      method: "get",
    });
    return lintIgnoreRowsToWire(result.rows)[0];
  }

  function handleLintIgnoreDelete(args: Record<string, unknown>) {
    handleDbExecute({
      sql: `DELETE FROM lint_ignored_diagnostics
             WHERE id = ?
               AND (EXISTS (
                      SELECT 1 FROM tree_nodes t
                       WHERE t.id = lint_ignored_diagnostics.scene_id
                         AND t.project_id = ?
                    ) OR NOT EXISTS (
                      SELECT 1 FROM tree_nodes t
                       WHERE t.id = lint_ignored_diagnostics.scene_id
                    ))`,
      params: [String(args.id), String(args.projectId)],
      method: "run",
    });
    return null;
  }

  function handleLintIgnoreCopy(args: Record<string, unknown>) {
    const payload = args.payload as Record<string, unknown>;
    const source = handleLintIgnoreListScene({
      sceneId: payload.fromSceneId,
      projectId: payload.projectId,
    });
    for (const entry of source) {
      handleLintIgnoreCreate({
        payload: {
          id: crypto.randomUUID(),
          projectId: payload.projectId,
          sceneId: payload.toSceneId,
          ruleId: entry.ruleId,
          textSnippet: entry.textSnippet,
          contextBefore: entry.contextBefore,
          contextAfter: entry.contextAfter,
          note: entry.note,
          createdAt: entry.createdAt,
        },
      });
    }
    return handleLintIgnoreListScene({
      sceneId: payload.toSceneId,
      projectId: payload.projectId,
    });
  }

  function handleLintIgnoreMove(args: Record<string, unknown>) {
    const payload = args.payload as Record<string, unknown>;
    for (const sceneId of payload.fromSceneIds as string[]) {
      handleDbExecute({
        sql: "UPDATE lint_ignored_diagnostics SET scene_id = ? WHERE scene_id = ?",
        params: [String(payload.toSceneId), sceneId],
        method: "run",
      });
    }
    return handleLintIgnoreListScene({
      sceneId: payload.toSceneId,
      projectId: payload.projectId,
    });
  }

  function handleFtsSearch(args: Record<string, unknown>): Array<{
    sourceType: "scene" | "codex" | "snippet";
    id: string;
    title: string;
    excerpt: string;
  }> {
    const projectId = String(args.projectId ?? "default-project");
    const query = String(args.query ?? "").trim();
    const limit = Math.max(1, Number(args.limit ?? 50));
    if (!query) return [];

    const like = `%${query}%`;
    const result = handleDbExecute({
      sql: `SELECT 'scene' AS source_type, id, title,
                   COALESCE(synopsis, '') AS excerpt
              FROM tree_nodes
             WHERE project_id = ? AND node_type = 'scene'
               AND (title LIKE ? OR COALESCE(synopsis, '') LIKE ? OR content LIKE ?)
            UNION ALL
            SELECT 'codex' AS source_type, id, name AS title,
                   COALESCE(summary, '') AS excerpt
              FROM codex_entries
             WHERE project_id = ?
               AND (name LIKE ? OR COALESCE(summary, '') LIKE ? OR content LIKE ?)
            UNION ALL
            SELECT 'snippet' AS source_type, id, title,
                   content AS excerpt
              FROM snippets
             WHERE project_id = ?
               AND (title LIKE ? OR content LIKE ?)
            LIMIT ?`,
      params: [
        projectId,
        like,
        like,
        like,
        projectId,
        like,
        like,
        like,
        projectId,
        like,
        like,
        limit,
      ],
    });

    return result.rows.map((row) => {
      const sourceType = String(row.source_type) as
        | "scene"
        | "codex"
        | "snippet";
      return {
        sourceType,
        id: String(row.id),
        title: String(row.title),
        excerpt:
          sourceType === "snippet"
            ? proseDocText(row.excerpt)
            : String(row.excerpt),
      };
    });
  }

  function handleDbExecuteBatch(args: Record<string, unknown>): {
    rows: Record<string, unknown>[];
  } {
    const statements = args.statements as {
      sql: string;
      params: SqlValue[];
      method: string;
    }[];
    db.run("BEGIN");
    let last: Record<string, unknown>[] = [];
    let mutated = false;
    try {
      for (const s of statements) {
        const result = executeBrowserDbStatement(db, s.sql, s.params);
        last = result.rows;
        mutated ||= methodAssumesMutation(s.method) || result.mutated;
      }
      db.run("COMMIT");
      if (mutated) {
        options.onDatabaseDirty?.();
      }
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
    }
    return { rows: last };
  }

  function queryOne(
    sql: string,
    params: SqlValue[],
  ): Record<string, SqlValue> | null {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function queryAll(
    sql: string,
    params: SqlValue[],
  ): Record<string, SqlValue>[] {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: Record<string, SqlValue>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  function browserCommandPayload(
    command: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload = args.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error(`${command}: payload must be an object`);
    }
    return payload as Record<string, unknown>;
  }

  function requiredBrowserString(
    command: string,
    payload: Record<string, unknown>,
    key: string,
  ): string {
    const value = payload[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${command}: ${key} must be a non-empty string`);
    }
    return value;
  }

  function nullableBrowserString(
    command: string,
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = payload[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      throw new Error(`${command}: ${key} must be a string or null`);
    }
    return value;
  }

  function optionalBrowserString(
    command: string,
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = payload[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      throw new Error(`${command}: ${key} must be a string or null`);
    }
    return value;
  }

  function nullableBrowserInteger(
    command: string,
    payload: Record<string, unknown>,
    key: string,
  ): number | null {
    const value = payload[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`${command}: ${key} must be an integer or null`);
    }
    return value;
  }

  function browserBoolean(
    command: string,
    payload: Record<string, unknown>,
    key: string,
    fallback: boolean,
  ): boolean {
    const value = payload[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      throw new Error(`${command}: ${key} must be a boolean`);
    }
    return value;
  }

  function rowMatches(
    row: Record<string, SqlValue>,
    expected: Record<string, SqlValue>,
  ): boolean {
    return Object.entries(expected).every(
      ([key, value]) => (row[key] ?? null) === value,
    );
  }

  async function runBrowserIdempotentCreate(request: {
    domain: string;
    requestId: string | null;
    entityId: string;
    projectId: string;
    fingerprintPayload: Record<string, unknown>;
    conflictMarker: string;
    loadEntity: () => Record<string, SqlValue> | null;
    createEntity: () => Record<string, SqlValue>;
  }): Promise<Record<string, unknown>> {
    const payloadHash = await browserPayloadFingerprint(
      request.domain,
      request.fingerprintPayload,
    );
    db.run("BEGIN IMMEDIATE");
    try {
      const ledger =
        request.requestId === null
          ? null
          : queryOne(
              `SELECT payload_hash, tombstone_json
           FROM idempotency_requests
          WHERE domain = ? AND request_id = ?`,
              [request.domain, request.requestId],
            );
      if (ledger) {
        if (String(ledger.payload_hash) !== payloadHash) {
          throw new Error(
            `${request.conflictMarker}: request id reused with different payload`,
          );
        }
        const current = request.loadEntity();
        const tombstone = JSON.parse(String(ledger.tombstone_json)) as {
          id?: unknown;
        };
        const replayEntityId =
          typeof tombstone.id === "string" ? tombstone.id : request.entityId;
        db.run("COMMIT");
        return {
          ...(current ?? { id: replayEntityId }),
          __idempotency: {
            replayed: true,
            entityPresent: current !== null,
          },
        };
      }

      const created = request.createEntity();
      if (request.requestId !== null) {
        db.run(
          `INSERT INTO idempotency_requests
           (domain, request_id, project_id, payload_hash, tombstone_json)
         VALUES (?, ?, ?, ?, ?)`,
          [
            request.domain,
            request.requestId,
            request.projectId,
            payloadHash,
            JSON.stringify({ id: request.entityId }),
          ],
        );
      }
      db.run("COMMIT");
      options.onDatabaseDirty?.();
      return {
        ...created,
        __idempotency: { replayed: false, entityPresent: true },
      };
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* noop */
      }
      throw error;
    }
  }

  async function handlePlotThreadCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_create";
    const payload = browserCommandPayload(command, args);
    const id = requiredBrowserString(command, payload, "id");
    const projectId = requiredBrowserString(command, payload, "projectId");
    const name = requiredBrowserString(command, payload, "name");
    const color = nullableBrowserString(command, payload, "color");
    const description = nullableBrowserString(command, payload, "description");
    const sortOrder = requiredBrowserString(command, payload, "sortOrder");
    const fingerprintPayload = {
      id,
      projectId,
      name,
      color,
      description,
      sortOrder,
    };
    const loadEntity = () =>
      queryOne("SELECT * FROM plot_threads WHERE id = ?", [id]);

    return runBrowserIdempotentCreate({
      domain: command,
      requestId: id,
      entityId: id,
      projectId,
      fingerprintPayload,
      conflictMarker: "PLOT_THREAD_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        try {
          db.run(
            `INSERT INTO plot_threads
               (id, project_id, name, color, description, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, projectId, name, color, description, sortOrder],
          );
        } catch (error) {
          const existing = loadEntity();
          if (!existing) throw error;
          if (
            !rowMatches(existing, {
              project_id: projectId,
              name,
              color,
              description,
              sort_order: sortOrder,
            })
          ) {
            throw new Error(
              "PLOT_THREAD_IDEMPOTENCY_CONFLICT: request id reused with different payload",
              { cause: error },
            );
          }
        }
        const created = loadEntity();
        if (!created) {
          throw new Error(
            "plot thread create completed without a persisted row",
          );
        }
        return created;
      },
    });
  }

  async function handlePlotThreadLinkCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_link_create";
    const payload = browserCommandPayload(command, args);
    const id = requiredBrowserString(command, payload, "id");
    const threadId = requiredBrowserString(command, payload, "threadId");
    const nodeId = requiredBrowserString(command, payload, "nodeId");
    const phaseType = requiredBrowserString(command, payload, "phaseType");
    const note = nullableBrowserString(command, payload, "note");
    const sortOrder = nullableBrowserString(command, payload, "sortOrder");
    const fingerprintPayload = {
      id,
      threadId,
      nodeId,
      phaseType,
      note,
      sortOrder,
    };
    const loadEntity = () =>
      queryOne("SELECT * FROM plot_thread_scene_links WHERE id = ?", [id]);

    const thread = queryOne(
      "SELECT project_id FROM plot_threads WHERE id = ?",
      [threadId],
    );
    const projectId = String(thread?.project_id ?? "");
    return runBrowserIdempotentCreate({
      domain: command,
      requestId: id,
      entityId: id,
      projectId,
      fingerprintPayload,
      conflictMarker: "PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (
          !["introduce", "develop", "turn", "climax", "resolve"].includes(
            phaseType,
          )
        ) {
          throw new Error(`invalid phase_type: ${phaseType}`);
        }
        const currentThread = queryOne(
          "SELECT project_id FROM plot_threads WHERE id = ?",
          [threadId],
        );
        const node = queryOne(
          "SELECT project_id FROM tree_nodes WHERE id = ?",
          [nodeId],
        );
        if (
          !currentThread ||
          !node ||
          currentThread.project_id !== node.project_id
        ) {
          throw new Error(
            "plot thread link must reference a thread and scene in the same project",
          );
        }
        try {
          db.run(
            `INSERT INTO plot_thread_scene_links
               (id, thread_id, node_id, phase_type, note, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, threadId, nodeId, phaseType, note, sortOrder],
          );
        } catch (error) {
          const existing = loadEntity();
          if (!existing) throw error;
          if (
            !rowMatches(existing, {
              thread_id: threadId,
              node_id: nodeId,
              phase_type: phaseType,
              note,
              sort_order: sortOrder,
            })
          ) {
            throw new Error(
              "PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT: request id reused with different payload",
              { cause: error },
            );
          }
        }
        const created = loadEntity();
        if (!created) {
          throw new Error(
            "plot thread link create completed without a persisted row",
          );
        }
        return created;
      },
    });
  }

  async function handlePlotThreadBranchCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_branch_create";
    const payload = browserCommandPayload(command, args);
    const id = requiredBrowserString(command, payload, "id");
    const projectId = requiredBrowserString(command, payload, "projectId");
    const fromThreadId = requiredBrowserString(
      command,
      payload,
      "fromThreadId",
    );
    const toThreadId = requiredBrowserString(command, payload, "toThreadId");
    const atNodeId = requiredBrowserString(command, payload, "atNodeId");
    const kind = requiredBrowserString(command, payload, "kind");
    const fingerprintPayload = {
      id,
      projectId,
      fromThreadId,
      toThreadId,
      atNodeId,
      kind,
    };
    const loadEntity = () =>
      queryOne("SELECT * FROM plot_thread_branches WHERE id = ?", [id]);

    return runBrowserIdempotentCreate({
      domain: command,
      requestId: id,
      entityId: id,
      projectId,
      fingerprintPayload,
      conflictMarker: "PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (!["branch", "merge"].includes(kind)) {
          throw new Error(`invalid plot branch kind: ${kind}`);
        }
        if (fromThreadId === toThreadId) {
          throw new Error(
            "plot thread branch cannot reference the same thread twice",
          );
        }
        const from = queryOne(
          "SELECT project_id FROM plot_threads WHERE id = ?",
          [fromThreadId],
        );
        const to = queryOne(
          "SELECT project_id FROM plot_threads WHERE id = ?",
          [toThreadId],
        );
        const node = queryOne(
          "SELECT project_id FROM tree_nodes WHERE id = ?",
          [atNodeId],
        );
        if (
          from?.project_id !== projectId ||
          to?.project_id !== projectId ||
          node?.project_id !== projectId
        ) {
          throw new Error(
            "plot thread branch must reference a project, threads, and scene in the same project",
          );
        }
        try {
          db.run(
            `INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, projectId, fromThreadId, toThreadId, atNodeId, kind],
          );
        } catch (error) {
          const existing = loadEntity();
          if (!existing) throw error;
          if (
            !rowMatches(existing, {
              project_id: projectId,
              from_thread_id: fromThreadId,
              to_thread_id: toThreadId,
              at_node_id: atNodeId,
              kind,
            })
          ) {
            throw new Error(
              "PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT: request id reused with different payload",
              { cause: error },
            );
          }
        }
        const created = loadEntity();
        if (!created) {
          throw new Error(
            "plot thread branch create completed without a persisted row",
          );
        }
        return created;
      },
    });
  }

  function browserSnapshotRecord(
    command: string,
    value: unknown,
    key: string,
  ): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${command}: ${key} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  function browserSnapshotArray(
    command: string,
    payload: Record<string, unknown>,
    key: string,
  ): Record<string, unknown>[] {
    const value = payload[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error(`${command}: ${key} must be an array`);
    }
    return value.map((entry, index) =>
      browserSnapshotRecord(command, entry, `${key}[${index}]`),
    );
  }

  function parseBrowserThreadSnapshot(
    command: string,
    raw: Record<string, unknown>,
  ): BrowserPlotThreadSnapshot {
    return {
      id: requiredBrowserString(command, raw, "id"),
      projectId: requiredBrowserString(command, raw, "projectId"),
      name: requiredBrowserString(command, raw, "name"),
      color: nullableBrowserString(command, raw, "color"),
      description: nullableBrowserString(command, raw, "description"),
      sortOrder: requiredBrowserString(command, raw, "sortOrder"),
      startNodeId: nullableBrowserString(command, raw, "startNodeId"),
      endNodeId: nullableBrowserString(command, raw, "endNodeId"),
      createdAt: requiredBrowserString(command, raw, "createdAt"),
      updatedAt: requiredBrowserString(command, raw, "updatedAt"),
    };
  }

  function parseBrowserLinkSnapshot(
    command: string,
    raw: Record<string, unknown>,
  ): BrowserPlotLinkSnapshot {
    return {
      id: requiredBrowserString(command, raw, "id"),
      threadId: requiredBrowserString(command, raw, "threadId"),
      nodeId: requiredBrowserString(command, raw, "nodeId"),
      phaseType: requiredBrowserString(command, raw, "phaseType"),
      note: nullableBrowserString(command, raw, "note"),
      sortOrder: nullableBrowserString(command, raw, "sortOrder"),
      createdAt: requiredBrowserString(command, raw, "createdAt"),
      updatedAt: requiredBrowserString(command, raw, "updatedAt"),
    };
  }

  function parseBrowserBranchSnapshot(
    command: string,
    raw: Record<string, unknown>,
  ): BrowserPlotBranchSnapshot {
    return {
      id: requiredBrowserString(command, raw, "id"),
      projectId: requiredBrowserString(command, raw, "projectId"),
      fromThreadId: requiredBrowserString(command, raw, "fromThreadId"),
      toThreadId: requiredBrowserString(command, raw, "toThreadId"),
      atNodeId: requiredBrowserString(command, raw, "atNodeId"),
      kind: requiredBrowserString(command, raw, "kind"),
      createdAt: requiredBrowserString(command, raw, "createdAt"),
      updatedAt: requiredBrowserString(command, raw, "updatedAt"),
    };
  }

  function browserThreadSnapshotMatches(
    row: Record<string, SqlValue>,
    expected: BrowserPlotThreadSnapshot,
  ): boolean {
    return rowMatches(row, {
      id: expected.id,
      project_id: expected.projectId,
      name: expected.name,
      color: expected.color,
      description: expected.description,
      sort_order: expected.sortOrder,
      start_node_id: expected.startNodeId,
      end_node_id: expected.endNodeId,
      created_at: expected.createdAt,
      updated_at: expected.updatedAt,
    });
  }

  function browserLinkSnapshotMatches(
    row: Record<string, SqlValue>,
    expected: BrowserPlotLinkSnapshot,
  ): boolean {
    return rowMatches(row, {
      id: expected.id,
      thread_id: expected.threadId,
      node_id: expected.nodeId,
      phase_type: expected.phaseType,
      note: expected.note,
      sort_order: expected.sortOrder,
      created_at: expected.createdAt,
      updated_at: expected.updatedAt,
    });
  }

  function browserBranchSnapshotMatches(
    row: Record<string, SqlValue>,
    expected: BrowserPlotBranchSnapshot,
  ): boolean {
    return rowMatches(row, {
      id: expected.id,
      project_id: expected.projectId,
      from_thread_id: expected.fromThreadId,
      to_thread_id: expected.toThreadId,
      at_node_id: expected.atNodeId,
      kind: expected.kind,
      created_at: expected.createdAt,
      updated_at: expected.updatedAt,
    });
  }

  function requireBrowserProjectMember(
    table: "plot_threads" | "tree_nodes",
    id: string,
    projectId: string,
    message: string,
  ): void {
    const row = queryOne(`SELECT project_id FROM ${table} WHERE id = ?`, [id]);
    if (row?.project_id !== projectId) {
      throw new Error(message);
    }
  }

  async function handlePlotThreadMoveMarkerBundle(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_move_marker_bundle";
    const payload = browserCommandPayload(command, args);
    const requestId = requiredBrowserString(command, payload, "requestId");
    const projectId = requiredBrowserString(command, payload, "projectId");
    const markerBefore = parseBrowserLinkSnapshot(
      command,
      browserSnapshotRecord(command, payload.markerBefore, "markerBefore"),
    );
    const markerAfter = parseBrowserLinkSnapshot(
      command,
      browserSnapshotRecord(command, payload.markerAfter, "markerAfter"),
    );
    const branchTransitions = browserSnapshotArray(
      command,
      payload,
      "branchTransitions",
    ).map((transition, index): BrowserPlotBranchTransition => {
      const parseBranch = (
        key: "before" | "after",
      ): BrowserPlotBranchSnapshot | null => {
        const value = transition[key];
        if (value === null || value === undefined) return null;
        return parseBrowserBranchSnapshot(
          command,
          browserSnapshotRecord(
            command,
            value,
            `branchTransitions[${index}].${key}`,
          ),
        );
      };
      return { before: parseBranch("before"), after: parseBranch("after") };
    });

    if (
      !["introduce", "develop", "turn", "climax", "resolve"].includes(
        markerBefore.phaseType,
      ) ||
      !["introduce", "develop", "turn", "climax", "resolve"].includes(
        markerAfter.phaseType,
      )
    ) {
      throw new Error("plot marker move has an invalid phase_type");
    }
    if (markerBefore.id !== markerAfter.id) {
      throw new Error("plot marker move marker identity cannot change");
    }
    if (
      markerBefore.phaseType !== markerAfter.phaseType ||
      markerBefore.note !== markerAfter.note ||
      markerBefore.sortOrder !== markerAfter.sortOrder ||
      markerBefore.createdAt !== markerAfter.createdAt
    ) {
      throw new Error(
        "plot marker move may only change marker thread, scene, and updatedAt",
      );
    }

    const branchIds = new Set<string>();
    for (const transition of branchTransitions) {
      if (transition.before === null && transition.after === null) {
        throw new Error(
          "plot marker move branch transition must contain before or after",
        );
      }
      for (const branch of [transition.before, transition.after]) {
        if (!branch) continue;
        if (branch.projectId !== projectId) {
          throw new Error(
            "plot marker move branch must belong to the bundle project",
          );
        }
        if (branch.fromThreadId === branch.toThreadId) {
          throw new Error(
            "plot thread branch cannot reference the same thread twice",
          );
        }
        if (!["branch", "merge"].includes(branch.kind)) {
          throw new Error(`invalid plot branch kind: ${branch.kind}`);
        }
      }
      if (
        transition.before !== null &&
        transition.after !== null &&
        (transition.before.id !== transition.after.id ||
          transition.before.projectId !== transition.after.projectId ||
          transition.before.kind !== transition.after.kind ||
          transition.before.createdAt !== transition.after.createdAt)
      ) {
        throw new Error(
          "plot marker move may only change branch endpoints, anchor, and updatedAt",
        );
      }
      const branchId = (transition.before ?? transition.after)?.id;
      if (!branchId || branchIds.has(branchId)) {
        throw new Error("plot marker move contains duplicate branch ids");
      }
      branchIds.add(branchId);
    }

    const branchesAfter = branchTransitions.flatMap((transition) =>
      transition.after === null ? [] : [transition.after],
    );
    const deletedBranchIds = branchTransitions.flatMap((transition) =>
      transition.after === null && transition.before !== null
        ? [transition.before.id]
        : [],
    );
    const response = () => ({
      id: requestId,
      marker: markerAfter,
      branches: branchesAfter,
      deletedBranchIds,
    });
    const loadEntity = (): Record<string, SqlValue> | null => {
      const marker = queryOne(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        [markerAfter.id],
      );
      if (!marker || !browserLinkSnapshotMatches(marker, markerAfter)) {
        return null;
      }
      for (const transition of branchTransitions) {
        if (transition.after !== null) {
          const branch = queryOne(
            "SELECT * FROM plot_thread_branches WHERE id = ?",
            [transition.after.id],
          );
          if (
            !branch ||
            !browserBranchSnapshotMatches(branch, transition.after)
          ) {
            return null;
          }
        } else if (
          transition.before !== null &&
          queryOne("SELECT id FROM plot_thread_branches WHERE id = ?", [
            transition.before.id,
          ])
        ) {
          return null;
        }
      }
      return response() as unknown as Record<string, SqlValue>;
    };

    return runBrowserIdempotentCreate({
      domain: command,
      requestId,
      entityId: requestId,
      projectId,
      fingerprintPayload: {
        projectId,
        markerBefore,
        markerAfter,
        branchTransitions,
      },
      conflictMarker: "PLOT_THREAD_MOVE_MARKER_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (!queryOne("SELECT id FROM projects WHERE id = ?", [projectId])) {
          throw new Error("plot marker move project does not exist");
        }
        for (const marker of [markerBefore, markerAfter]) {
          requireBrowserProjectMember(
            "plot_threads",
            marker.threadId,
            projectId,
            "plot marker move thread must belong to the bundle project",
          );
          requireBrowserProjectMember(
            "tree_nodes",
            marker.nodeId,
            projectId,
            "plot marker move scene must belong to the bundle project",
          );
        }
        for (const transition of branchTransitions) {
          for (const branch of [transition.before, transition.after]) {
            if (!branch) continue;
            requireBrowserProjectMember(
              "plot_threads",
              branch.fromThreadId,
              projectId,
              "plot marker move branch source thread must belong to the bundle project",
            );
            requireBrowserProjectMember(
              "plot_threads",
              branch.toThreadId,
              projectId,
              "plot marker move branch target thread must belong to the bundle project",
            );
            requireBrowserProjectMember(
              "tree_nodes",
              branch.atNodeId,
              projectId,
              "plot marker move branch scene must belong to the bundle project",
            );
          }
        }

        const currentMarker = queryOne(
          "SELECT * FROM plot_thread_scene_links WHERE id = ?",
          [markerBefore.id],
        );
        if (!currentMarker) {
          throw new Error(
            "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker no longer exists",
          );
        }
        if (!browserLinkSnapshotMatches(currentMarker, markerBefore)) {
          throw new Error(
            "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker changed since snapshot",
          );
        }
        for (const transition of branchTransitions) {
          if (transition.before !== null) {
            const currentBranch = queryOne(
              "SELECT * FROM plot_thread_branches WHERE id = ?",
              [transition.before.id],
            );
            if (!currentBranch) {
              throw new Error(
                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch no longer exists",
              );
            }
            if (
              !browserBranchSnapshotMatches(currentBranch, transition.before)
            ) {
              throw new Error(
                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch changed since snapshot",
              );
            }
          } else if (
            transition.after !== null &&
            queryOne("SELECT id FROM plot_thread_branches WHERE id = ?", [
              transition.after.id,
            ])
          ) {
            throw new Error(
              "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch id already exists",
            );
          }
        }

        db.run(
          `UPDATE plot_thread_scene_links
              SET thread_id = ?, node_id = ?, phase_type = ?, note = ?,
                  sort_order = ?, created_at = ?, updated_at = ?
            WHERE id = ?`,
          [
            markerAfter.threadId,
            markerAfter.nodeId,
            markerAfter.phaseType,
            markerAfter.note,
            markerAfter.sortOrder,
            markerAfter.createdAt,
            markerAfter.updatedAt,
            markerAfter.id,
          ],
        );
        for (const transition of branchTransitions) {
          if (transition.before === null && transition.after !== null) {
            const branch = transition.after;
            db.run(
              `INSERT INTO plot_thread_branches
                 (id, project_id, from_thread_id, to_thread_id, at_node_id,
                  kind, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                branch.id,
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                branch.createdAt,
                branch.updatedAt,
              ],
            );
          } else if (transition.before !== null && transition.after !== null) {
            const branch = transition.after;
            db.run(
              `UPDATE plot_thread_branches
                  SET project_id = ?, from_thread_id = ?, to_thread_id = ?,
                      at_node_id = ?, kind = ?, created_at = ?, updated_at = ?
                WHERE id = ?`,
              [
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                branch.createdAt,
                branch.updatedAt,
                branch.id,
              ],
            );
          } else if (transition.before !== null && transition.after === null) {
            db.run("DELETE FROM plot_thread_branches WHERE id = ?", [
              transition.before.id,
            ]);
          }
        }

        for (const branch of branchesAfter) {
          const duplicate = queryOne(
            `SELECT id
               FROM plot_thread_branches
              WHERE project_id = ? AND from_thread_id = ? AND to_thread_id = ?
                AND at_node_id = ? AND kind = ? AND id <> ?
              LIMIT 1`,
            [
              branch.projectId,
              branch.fromThreadId,
              branch.toThreadId,
              branch.atNodeId,
              branch.kind,
              branch.id,
            ],
          );
          if (duplicate) {
            throw new Error("plot marker move would create a duplicate branch");
          }
        }
        return response() as unknown as Record<string, SqlValue>;
      },
    });
  }

  async function handlePlotThreadRestoreSnapshot(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_restore_snapshot";
    const payload = browserCommandPayload(command, args);
    const requestId = requiredBrowserString(command, payload, "requestId");
    const projectId = requiredBrowserString(command, payload, "projectId");
    const rawThread = payload.thread;
    const thread =
      rawThread === null || rawThread === undefined
        ? null
        : parseBrowserThreadSnapshot(
            command,
            browserSnapshotRecord(command, rawThread, "thread"),
          );
    const links = browserSnapshotArray(command, payload, "links").map((row) =>
      parseBrowserLinkSnapshot(command, row),
    );
    const branches = browserSnapshotArray(command, payload, "branches").map(
      (row) => parseBrowserBranchSnapshot(command, row),
    );
    if (thread === null && links.length === 0 && branches.length === 0) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot must contain at least one row",
      );
    }
    if (new Set(links.map((row) => row.id)).size !== links.length) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot contains duplicate link ids",
      );
    }
    if (new Set(branches.map((row) => row.id)).size !== branches.length) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot contains duplicate branch ids",
      );
    }
    const response = () => ({
      id: requestId,
      thread,
      links,
      branches,
    });
    const loadEntity = (): Record<string, SqlValue> | null => {
      if (thread !== null) {
        const row = queryOne("SELECT * FROM plot_threads WHERE id = ?", [
          thread.id,
        ]);
        if (!row || !browserThreadSnapshotMatches(row, thread)) return null;
      }
      for (const expected of links) {
        const row = queryOne(
          "SELECT * FROM plot_thread_scene_links WHERE id = ?",
          [expected.id],
        );
        if (!row || !browserLinkSnapshotMatches(row, expected)) return null;
      }
      for (const expected of branches) {
        const row = queryOne(
          "SELECT * FROM plot_thread_branches WHERE id = ?",
          [expected.id],
        );
        if (!row || !browserBranchSnapshotMatches(row, expected)) return null;
      }
      return response() as unknown as Record<string, SqlValue>;
    };

    return runBrowserIdempotentCreate({
      domain: command,
      requestId,
      entityId: requestId,
      projectId,
      fingerprintPayload: { projectId, thread, links, branches },
      conflictMarker: "PLOT_THREAD_RESTORE_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (!queryOne("SELECT id FROM projects WHERE id = ?", [projectId])) {
          throw new Error("plot snapshot project does not exist");
        }
        if (thread !== null) {
          if (thread.projectId !== projectId) {
            throw new Error(
              "plot restore thread must belong to the snapshot project",
            );
          }
          for (const nodeId of [thread.startNodeId, thread.endNodeId]) {
            if (nodeId !== null) {
              requireBrowserProjectMember(
                "tree_nodes",
                nodeId,
                projectId,
                "plot restore thread boundary scene must belong to the snapshot project",
              );
            }
          }
          const existing = queryOne("SELECT * FROM plot_threads WHERE id = ?", [
            thread.id,
          ]);
          if (existing) {
            if (!browserThreadSnapshotMatches(existing, thread)) {
              throw new Error(
                "PLOT_THREAD_RESTORE_CONFLICT: thread id already has different content",
              );
            }
          } else {
            db.run(
              `INSERT INTO plot_threads
                 (id, project_id, name, color, description, sort_order,
                  start_node_id, end_node_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                thread.id,
                thread.projectId,
                thread.name,
                thread.color,
                thread.description,
                thread.sortOrder,
                thread.startNodeId,
                thread.endNodeId,
                thread.createdAt,
                thread.updatedAt,
              ],
            );
          }
        }
        for (const link of links) {
          if (
            !["introduce", "develop", "turn", "climax", "resolve"].includes(
              link.phaseType,
            )
          ) {
            throw new Error(`invalid phase_type: ${link.phaseType}`);
          }
          requireBrowserProjectMember(
            "plot_threads",
            link.threadId,
            projectId,
            "plot restore link thread must belong to the snapshot project",
          );
          requireBrowserProjectMember(
            "tree_nodes",
            link.nodeId,
            projectId,
            "plot restore link scene must belong to the snapshot project",
          );
          const existing = queryOne(
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            [link.id],
          );
          if (existing) {
            if (!browserLinkSnapshotMatches(existing, link)) {
              throw new Error(
                "PLOT_THREAD_RESTORE_CONFLICT: link id already has different content",
              );
            }
          } else {
            db.run(
              `INSERT INTO plot_thread_scene_links
                 (id, thread_id, node_id, phase_type, note, sort_order,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                link.id,
                link.threadId,
                link.nodeId,
                link.phaseType,
                link.note,
                link.sortOrder,
                link.createdAt,
                link.updatedAt,
              ],
            );
          }
        }
        for (const branch of branches) {
          if (!["branch", "merge"].includes(branch.kind)) {
            throw new Error(`invalid plot branch kind: ${branch.kind}`);
          }
          if (branch.projectId !== projectId) {
            throw new Error(
              "plot restore branch must belong to the snapshot project",
            );
          }
          if (branch.fromThreadId === branch.toThreadId) {
            throw new Error(
              "plot thread branch cannot reference the same thread twice",
            );
          }
          requireBrowserProjectMember(
            "plot_threads",
            branch.fromThreadId,
            projectId,
            "plot restore branch source thread must belong to the snapshot project",
          );
          requireBrowserProjectMember(
            "plot_threads",
            branch.toThreadId,
            projectId,
            "plot restore branch target thread must belong to the snapshot project",
          );
          requireBrowserProjectMember(
            "tree_nodes",
            branch.atNodeId,
            projectId,
            "plot restore branch scene must belong to the snapshot project",
          );
          const existing = queryOne(
            "SELECT * FROM plot_thread_branches WHERE id = ?",
            [branch.id],
          );
          if (existing) {
            if (!browserBranchSnapshotMatches(existing, branch)) {
              throw new Error(
                "PLOT_THREAD_RESTORE_CONFLICT: branch id already has different content",
              );
            }
          } else {
            db.run(
              `INSERT INTO plot_thread_branches
                 (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                branch.id,
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                branch.createdAt,
                branch.updatedAt,
              ],
            );
          }
        }
        return response() as unknown as Record<string, SqlValue>;
      },
    });
  }

  async function handlePlotThreadDeleteSnapshot(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "plot_thread_delete_snapshot";
    const payload = browserCommandPayload(command, args);
    const requestId = requiredBrowserString(command, payload, "requestId");
    const projectId = requiredBrowserString(command, payload, "projectId");
    const link = parseBrowserLinkSnapshot(
      command,
      browserSnapshotRecord(command, payload.link, "link"),
    );
    const branches = browserSnapshotArray(command, payload, "branches").map(
      (row) => parseBrowserBranchSnapshot(command, row),
    );
    if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
      throw new Error(`${command}: branches contains duplicate ids`);
    }
    const loadEntity = (): Record<string, SqlValue> | null => {
      if (
        queryOne("SELECT id FROM plot_thread_scene_links WHERE id = ?", [
          link.id,
        ])
      ) {
        return null;
      }
      if (
        branches.some((branch) =>
          queryOne("SELECT id FROM plot_thread_branches WHERE id = ?", [
            branch.id,
          ]),
        )
      ) {
        return null;
      }
      return { id: requestId, deleted: 1 };
    };

    return runBrowserIdempotentCreate({
      domain: command,
      requestId,
      entityId: requestId,
      projectId,
      fingerprintPayload: { projectId, link, branches },
      conflictMarker: "PLOT_THREAD_DELETE_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (!queryOne("SELECT id FROM projects WHERE id = ?", [projectId])) {
          throw new Error("plot snapshot project does not exist");
        }
        const currentLink = queryOne(
          "SELECT * FROM plot_thread_scene_links WHERE id = ?",
          [link.id],
        );
        if (!currentLink) {
          throw new Error("plot delete snapshot link does not exist");
        }
        if (!browserLinkSnapshotMatches(currentLink, link)) {
          throw new Error(
            "PLOT_THREAD_DELETE_PRECONDITION_FAILED: link changed since snapshot",
          );
        }
        if (
          !["introduce", "develop", "turn", "climax", "resolve"].includes(
            link.phaseType,
          )
        ) {
          throw new Error(`invalid phase_type: ${link.phaseType}`);
        }
        requireBrowserProjectMember(
          "plot_threads",
          link.threadId,
          projectId,
          "plot delete snapshot link thread must belong to the snapshot project",
        );
        requireBrowserProjectMember(
          "tree_nodes",
          link.nodeId,
          projectId,
          "plot delete snapshot link scene must belong to the snapshot project",
        );
        const otherLinks = Number(
          queryOne(
            `SELECT COUNT(*) AS count
               FROM plot_thread_scene_links
              WHERE id <> ? AND thread_id = ? AND node_id = ?`,
            [link.id, link.threadId, link.nodeId],
          )?.count ?? 0,
        );
        const expected =
          otherLinks > 0
            ? []
            : queryAll(
                `SELECT id, project_id
                  FROM plot_thread_branches
                  WHERE to_thread_id = ? AND at_node_id = ?
                  ORDER BY id`,
                [link.threadId, link.nodeId],
              ).map((row) => {
                if (row.project_id !== projectId) {
                  throw new Error(
                    "plot delete snapshot branch must belong to the snapshot project",
                  );
                }
                return String(row.id);
              });
        if (
          [...expected].sort().join("\u0000") !==
          branches
            .map((branch) => branch.id)
            .sort()
            .join("\u0000")
        ) {
          throw new Error(
            "plot delete snapshot branch ids do not match the marker dependencies",
          );
        }
        for (const branch of branches) {
          if (!["branch", "merge"].includes(branch.kind)) {
            throw new Error(`invalid plot branch kind: ${branch.kind}`);
          }
          if (branch.projectId !== projectId) {
            throw new Error(
              "plot delete snapshot branch must belong to the snapshot project",
            );
          }
          if (branch.fromThreadId === branch.toThreadId) {
            throw new Error(
              "plot thread branch cannot reference the same thread twice",
            );
          }
          requireBrowserProjectMember(
            "plot_threads",
            branch.fromThreadId,
            projectId,
            "plot delete snapshot branch source thread must belong to the snapshot project",
          );
          requireBrowserProjectMember(
            "plot_threads",
            branch.toThreadId,
            projectId,
            "plot delete snapshot branch target thread must belong to the snapshot project",
          );
          requireBrowserProjectMember(
            "tree_nodes",
            branch.atNodeId,
            projectId,
            "plot delete snapshot branch scene must belong to the snapshot project",
          );
          const currentBranch = queryOne(
            "SELECT * FROM plot_thread_branches WHERE id = ?",
            [branch.id],
          );
          if (
            !currentBranch ||
            !browserBranchSnapshotMatches(currentBranch, branch)
          ) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch changed since snapshot",
            );
          }
          db.run("DELETE FROM plot_thread_branches WHERE id = ?", [branch.id]);
        }
        db.run("DELETE FROM plot_thread_scene_links WHERE id = ?", [link.id]);
        return { id: requestId, deleted: 1 };
      },
    });
  }

  async function handleForeshadowCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "foreshadow_create";
    const payload = browserCommandPayload(command, args);
    const suppliedId = optionalBrowserString(command, payload, "id");
    const suppliedRequestId = optionalBrowserString(
      command,
      payload,
      "requestId",
    );
    const requestId = suppliedRequestId ?? suppliedId;
    const id = suppliedId ?? requestId ?? crypto.randomUUID();
    const projectId = requiredBrowserString(command, payload, "projectId");
    const title = requiredBrowserString(command, payload, "title");
    const intent = nullableBrowserString(command, payload, "intent");
    const notes = nullableBrowserString(command, payload, "notes");
    const payoffSceneId = nullableBrowserString(
      command,
      payload,
      "payoffSceneId",
    );
    const payoffFromPos = nullableBrowserInteger(
      command,
      payload,
      "payoffFromPos",
    );
    const payoffToPos = nullableBrowserInteger(command, payload, "payoffToPos");
    const payoffConfirmed = browserBoolean(
      command,
      payload,
      "payoffConfirmed",
      false,
    );
    const abandoned = browserBoolean(command, payload, "abandoned", false);
    const secret = browserBoolean(command, payload, "secret", true);
    const loadBearing = nullableBrowserString(command, payload, "loadBearing");
    const codexLinkDirtyAt = nullableBrowserInteger(
      command,
      payload,
      "codexLinkDirtyAt",
    );
    const fingerprintPayload = {
      id: suppliedId,
      projectId,
      title,
      intent,
      notes,
      payoffSceneId,
      payoffFromPos,
      payoffToPos,
      payoffConfirmed,
      abandoned,
      secret,
      loadBearing,
      codexLinkDirtyAt,
    };
    const loadEntity = () =>
      queryOne("SELECT * FROM foreshadows WHERE id = ?", [id]);

    return runBrowserIdempotentCreate({
      domain: command,
      requestId,
      entityId: id,
      projectId,
      fingerprintPayload,
      conflictMarker: "FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (
          loadBearing !== null &&
          !["critical", "supporting", "optional"].includes(loadBearing)
        ) {
          throw new Error(`invalid load_bearing value: ${loadBearing}`);
        }
        if (payoffSceneId === null) {
          if (payoffFromPos !== null || payoffToPos !== null) {
            throw new Error(
              "foreshadow payoff positions require a payoff scene",
            );
          }
        } else if (
          !(
            (payoffFromPos === null && payoffToPos === null) ||
            (payoffFromPos !== null &&
              payoffToPos !== null &&
              0 <= payoffFromPos &&
              payoffFromPos <= payoffToPos)
          )
        ) {
          throw new Error(
            "foreshadow payoff positions must both be null or satisfy 0 <= from <= to",
          );
        }
        if (payoffSceneId !== null) {
          const payoffScene = queryOne(
            "SELECT project_id FROM tree_nodes WHERE id = ?",
            [payoffSceneId],
          );
          if (payoffScene?.project_id !== projectId) {
            throw new Error(
              "foreshadow payoff scene must belong to the same project",
            );
          }
        }
        const timestamp = Date.now();
        try {
          db.run(
            `INSERT INTO foreshadows
               (id, project_id, title, intent, notes, payoff_scene_id,
                payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned,
                secret, load_bearing, codex_link_dirty_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              projectId,
              title,
              intent,
              notes,
              payoffSceneId,
              payoffFromPos,
              payoffToPos,
              payoffConfirmed ? 1 : 0,
              abandoned ? 1 : 0,
              secret ? 1 : 0,
              loadBearing,
              codexLinkDirtyAt,
              timestamp,
              timestamp,
            ],
          );
        } catch (error) {
          const existing = loadEntity();
          if (!existing) throw error;
          if (
            !rowMatches(existing, {
              project_id: projectId,
              title,
              intent,
              notes,
              payoff_scene_id: payoffSceneId,
              payoff_from_pos: payoffFromPos,
              payoff_to_pos: payoffToPos,
              payoff_confirmed: payoffConfirmed ? 1 : 0,
              abandoned: abandoned ? 1 : 0,
              secret: secret ? 1 : 0,
              load_bearing: loadBearing,
              codex_link_dirty_at: codexLinkDirtyAt,
            })
          ) {
            throw new Error(
              "FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload",
              { cause: error },
            );
          }
        }
        const created = loadEntity();
        if (!created) {
          throw new Error(
            "foreshadow create completed without a persisted row",
          );
        }
        return created;
      },
    });
  }

  function readTimelapseTail(projectId: string): {
    sequence: number;
    hash: string;
  } {
    const row = queryOne(
      "select sequence, hash from change_events where project_id = ? order by sequence desc limit 1",
      [projectId],
    );
    if (!row) {
      return { sequence: 0, hash: bytesToHex(GENESIS_HASH) };
    }
    return {
      sequence: Number(row.sequence),
      hash: String(row.hash),
    };
  }

  function eventUidExists(projectId: string, eventUid: string): boolean {
    return Boolean(
      queryOne(
        "select 1 as found from change_events where project_id = ? and event_uid = ? limit 1",
        [projectId, eventUid],
      ),
    );
  }

  function liveSceneId(sceneId: string | null): string | null {
    if (!sceneId) return null;
    const row = queryOne(
      "select 1 as found from tree_nodes where id = ? limit 1",
      [sceneId],
    );
    return row ? sceneId : null;
  }

  async function handleTimelapseAppendBatch(
    args: Record<string, unknown>,
  ): Promise<{
    insertedCount: number;
    tailSequence: number;
    tailHash: string;
  }> {
    const projectId = args.projectId as string;
    const sessionId = args.sessionId as string;
    const events = (args.events ?? []) as TimelapseAppendEvent[];

    db.run("BEGIN IMMEDIATE");
    try {
      // Per-event idempotency (mirror of the Rust allocator): a committed-but-
      // rejected flush can be re-sent merged with new events; skip the
      // already-present uids and append only the genuinely-new suffix so the
      // merged-in events are never dropped.
      const firstUid = events[0]?.eventUid;
      const firstPresent = firstUid
        ? eventUidExists(projectId, firstUid)
        : false;

      let { sequence, hash: prevHash } = readTimelapseTail(projectId);
      let insertedCount = 0;
      for (const ev of events) {
        if (firstPresent && eventUidExists(projectId, ev.eventUid)) continue;
        sequence += 1;
        const sceneId = liveSceneId(ev.sceneId);
        const hash = bytesToHex(
          await computeEventHash({
            projectId,
            sceneId,
            domain: ev.domain,
            opType: ev.opType,
            entityType: ev.entityType,
            entityId: ev.entityId,
            payload: ev.payload,
            sessionId,
            sequence,
            timestamp: ev.timestamp,
            prevHash: hexToBytes(prevHash),
          }),
        );
        db.run(
          "insert into change_events (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id, payload, session_id, sequence, timestamp, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            ev.eventUid,
            projectId,
            sceneId,
            ev.domain,
            ev.opType,
            ev.entityType,
            ev.entityId,
            ev.payload,
            sessionId,
            sequence,
            ev.timestamp,
            prevHash,
            hash,
          ],
        );
        prevHash = hash;
        insertedCount += 1;
      }
      db.run("COMMIT");
      if (insertedCount > 0) {
        options.onDatabaseDirty?.();
      }
      return {
        insertedCount,
        tailSequence: sequence,
        tailHash: prevHash,
      };
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
    }
  }

  function handleGetGlobalSettings(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const recent = parsed.recentWorkspaces as unknown[];
        // Reuse the workspace while removing legacy desktop-only provider
        // routes that old Web Editor builds may have persisted.
        if (Array.isArray(recent)) {
          const normalized = normalizeBrowserGlobalSettings(parsed);
          if (normalized !== parsed) {
            localStorage.setItem(
              GLOBAL_SETTINGS_KEY,
              JSON.stringify(normalized),
            );
          }
          return normalized;
        }
      }
    } catch {
      // noop
    }
    // Normal Web Editor launches mirror native first-run settings so the
    // preflight/tutorial is reachable. Screenshot staging intentionally keeps
    // its automatic workspace bootstrap for deterministic captures.
    const defaultSettings = defaultBrowserGlobalSettings();
    try {
      localStorage.setItem(
        GLOBAL_SETTINGS_KEY,
        JSON.stringify(defaultSettings),
      );
    } catch {
      // noop
    }
    return defaultSettings;
  }

  function handleSaveGlobalSettings(args: Record<string, unknown>): void {
    const settings = normalizeBrowserGlobalSettings(
      args.settings as Record<string, unknown>,
    );
    try {
      localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }
  }

  function handleValidateWorkspacePath(): boolean {
    // In browser mock, always return true for any path
    return true;
  }

  function handleGetMcpConfig(): { command: string; workspace: string } {
    const settings = handleGetGlobalSettings();
    const workspace = settings.lastActiveWorkspace as string | null;
    if (!workspace) {
      throw new Error("No workspace is open");
    }
    // Dev/browser preview has no real binary path; "grimodex" stands in for
    // the installed app executable the native command would resolve.
    return { command: "grimodex", workspace };
  }

  function handleOpenWorkspace(args: Record<string, unknown>): {
    name: string;
    isExisting: boolean;
  } {
    const path = args.path as string;
    const parts = path.replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 1] || path;

    // Update mock global settings
    const settings = handleGetGlobalSettings();
    const recent = (settings.recentWorkspaces ?? []) as Array<{
      path: string;
      lastOpened: string;
    }>;
    const filtered = recent.filter((w: { path: string }) => w.path !== path);
    filtered.unshift({ path, lastOpened: new Date().toISOString() });
    settings.recentWorkspaces = filtered.slice(0, 10);
    settings.lastActiveWorkspace = path;
    try {
      localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }

    return { name, isExisting: false };
  }

  function handleSeedSampleWorkspace(args: Record<string, unknown>): {
    path: string;
    projectId: string;
  } {
    const language = args.language === "en" ? "en" : "ja";
    const aiPolicy =
      typeof args.aiPolicy === "string" ? args.aiPolicy : '{"preset":"off"}';
    seedBrowserTutorialProject(db, language, aiPolicy);
    options.onDatabaseDirty?.();

    const settings = handleGetGlobalSettings();
    const path =
      typeof settings.lastActiveWorkspace === "string"
        ? settings.lastActiveWorkspace
        : BROWSER_WORKSPACE_PATH;
    handleSaveGlobalSettings({
      settings: {
        ...settings,
        sampleWorkspacePath: path,
      },
    });
    return { path, projectId: TUTORIAL_PROJECT_ID };
  }

  async function invoke<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    switch (cmd) {
      case "get_global_settings":
        return handleGetGlobalSettings() as T;
      case "save_global_settings":
        handleSaveGlobalSettings(args);
        return undefined as T;
      case "validate_workspace_path":
        return handleValidateWorkspacePath() as T;
      case "open_workspace":
        return handleOpenWorkspace(args) as T;
      case "seed_sample_workspace":
        return handleSeedSampleWorkspace(args) as T;
      case "get_mcp_config":
        return handleGetMcpConfig() as T;
      case "db_execute":
        return handleDbExecute(args) as T;
      case "db_execute_batch":
        return handleDbExecuteBatch(args) as T;
      case "lint_ignore_list":
        return handleLintIgnoreList(args) as T;
      case "lint_ignore_list_scene":
        return handleLintIgnoreListScene(args) as T;
      case "lint_ignore_create":
        return handleLintIgnoreCreate(args) as T;
      case "lint_ignore_delete":
        return handleLintIgnoreDelete(args) as T;
      case "lint_ignore_copy":
        return handleLintIgnoreCopy(args) as T;
      case "lint_ignore_move":
        return handleLintIgnoreMove(args) as T;
      case "plot_thread_create":
        return (await handlePlotThreadCreate(args)) as T;
      case "plot_thread_link_create":
        return (await handlePlotThreadLinkCreate(args)) as T;
      case "plot_thread_branch_create":
        return (await handlePlotThreadBranchCreate(args)) as T;
      case "plot_thread_move_marker_bundle":
        return (await handlePlotThreadMoveMarkerBundle(args)) as T;
      case "plot_thread_restore_snapshot":
        return (await handlePlotThreadRestoreSnapshot(args)) as T;
      case "plot_thread_delete_snapshot":
        return (await handlePlotThreadDeleteSnapshot(args)) as T;
      case "foreshadow_create":
        return (await handleForeshadowCreate(args)) as T;
      case "vacuum_database":
        db.run("VACUUM");
        options.onDatabaseDirty?.();
        return undefined as T;
      case "fts_search":
        return handleFtsSearch(args) as T;
      case "semantic_search":
      case "codex_semantic_search":
      case "events_semantic_search":
      case "chat_message_search":
        // Hosted Editor has no local embedding model. Dense search is an
        // explicit empty arm; fts_search above remains a real SQL LIKE arm.
        return [] as T;
      case "semantic_index_scene":
      case "semantic_reindex_all":
      case "semantic_cancel_background":
      case "codex_index_entry":
      case "codex_reindex_all":
      case "events_index_entry":
      case "events_reindex_all":
      case "chat_index_message":
      case "chat_reindex_all":
        return 0 as T;
      case "semantic_download_model":
        return "unavailable" as T;
      case "semantic_index_status":
        return {
          indexedChunkCount: 0,
          staleChunkCount: 0,
          indexedSceneCount: 0,
          nonemptySceneCount: 0,
          currentModelId: "",
          currentEmbeddingDim: 0,
          currentChunkerVersion: "",
        } as T;
      case "codex_index_status":
        return { indexedEntryCount: 0, totalEntryCount: 0 } as T;
      case "events_index_status":
        return { indexedEventCount: 0, totalEventCount: 0 } as T;
      case "chat_index_status":
        return { indexedMessageCount: 0, totalMessageCount: 0 } as T;
      case "semantic_chunk_context":
        return {
          before: "",
          chunk: "",
          after: "",
          sceneTitle: "",
        } as T;
      case "semantic_debug_dump":
        return {
          projectId: String(args.projectId ?? "default-project"),
          language: "",
          currentModelId: "",
          currentEmbeddingDim: 0,
          currentChunkerVersion: "",
          totalChunks: 0,
          returnedChunks: 0,
          chunks: [],
        } as T;
      case "timelapse_append_batch":
        return (await handleTimelapseAppendBatch(args)) as T;
      case "ime_export_get_status":
      case "ime_export_refresh":
      case "ime_export_set_active_project":
        // Browser preview has no native filesystem. Keep the complete invoke
        // contract while making the feature an explicit, side-effect-free no-op.
        return {
          rootPath: "",
          consumers: [],
          activeProjectId: null,
          exportedProjectCount: 0,
          effectiveEnabled: false,
        } as T;
      case "ime_export_clear_all":
      case "ime_export_remove_project":
        return null as T;
      case "open_log_dir":
        // ブラウザではファイルマネージャを開けない。no-op で成功扱い。
        return undefined as T;
      case "get_ai_settings":
        return handleGetAiSettings() as T;
      case "save_ai_settings":
        handleSaveAiSettings(args);
        return undefined as T;
      case "save_api_key":
        handleSaveApiKey(args);
        return undefined as T;
      case "has_api_key":
        // 本物の IPC と同様、renderer には利用可否だけを返す。BYOK key
        // 本体は runtime-local Map から外へ公開しない。
        return hasAiProviderAccess(args) as T;
      case "delete_api_key":
        handleDeleteApiKey(args);
        return undefined as T;
      case "list_ai_models":
        return (await handleListAiModels(args)) as T;
      case "test_ai_connection":
        return (await handleTestAiConnection(args)) as T;
      case "send_chat_message":
        return (await handleSendChatMessage(args)) as T;
      case "send_chat_message_stream":
        await handleAiStream(args, "chat");
        return undefined as T;
      case "abort_chat_stream":
        aiTransport.abort?.("chat");
        return undefined as T;
      case "send_inline_ai_stream":
        await handleAiStream(args, "inline");
        return undefined as T;
      case "abort_inline_ai_stream":
        aiTransport.abort?.("inline");
        return undefined as T;
      case "detect_cli_binary":
        return null as T;
      case "list_cli_models":
        return [] as T;
      case "test_cli_connection":
        throw new Error("CLI subprocess is unavailable in browser mock");
      case "send_cli_chat_stream":
      case "abort_cli_chat_stream":
        return undefined as T;
      case "list_post_effect_runs":
        return [] as T;
      case "list_scene_lens_for_project":
        // Lens overlays are generated by the native post-effect pipeline.
        // Browser editing remains functional with an explicitly empty lens.
        return [] as T;
      case "list_annotations_for_scene":
        return {
          annotations: getScreenshotAnnotations(now).filter(
            (annotation) =>
              annotation.sceneId === (args.sceneId ?? args.scene_id),
          ),
          relations: [],
        } as T;
      case "list_annotations_for_project":
        return { annotations: getScreenshotAnnotations(now) } as T;
      case "update_annotation_status":
        return {
          ...getScreenshotAnnotations(now)[0],
          status: args.status ?? "open",
        } as T;
      case "save_post_effect_annotations":
        return undefined as T;
      case "abort_post_effect_run":
        return undefined as T;
      case "trash_bin_list":
        return getScreenshotTrashItems(now) as T;
      case "trash_bin_create":
        return getScreenshotTrashItems(now)[0] as T;
      case "trash_bin_delete":
      case "trash_bin_clear_all":
        return undefined as T;
      case "trash_bin_prune":
        return 0 as T;
      case "send_agent_message":
        return (await handleSendAgentMessage(args)) as T;
      case "lint_text":
        return lintTextBrowser(
          args as unknown as Parameters<typeof lintTextBrowser>[0],
        ) as T;
      case "external_mount_register":
        return { dirs: [], files: [] } as T;
      case "external_mount_unregister":
      case "external_mount_write_file":
        return undefined as T;
      case "external_mount_read_file":
        return "" as T;
      case "external_mount_scan":
        return { dirs: [], files: [] } as T;
      default:
        throw new Error(`[browser-mock] Unknown Tauri command: ${cmd}`);
    }
  }

  let isClosed = false;

  function exportDatabase(): Uint8Array {
    return db.export();
  }

  function close(): void {
    if (isClosed) return;
    aiTransport.abort?.("chat");
    aiTransport.abort?.("inline");
    aiTransport.dispose?.();
    apiKeys.clear();
    db.close();
    isClosed = true;
  }

  return { invoke, exportDatabase, close };
}

function proseDoc(lines: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: lines.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });
}

function proseDocText(raw: unknown): string {
  try {
    const parts: string[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const value = node as { text?: unknown; content?: unknown };
      if (typeof value.text === "string") parts.push(value.text);
      if (Array.isArray(value.content)) value.content.forEach(visit);
    };
    visit(JSON.parse(String(raw)));
    return parts.join(" ");
  } catch {
    return String(raw ?? "");
  }
}

function getScreenshotAnnotations(now: string) {
  if (!isScreenshotStagingActive()) return [];
  const { compassDry, foreignMemory } =
    SCREENSHOT_SEED_CONTENT[getScreenshotLanguage()].annotations;
  return [
    {
      id: "ann-akahimo-wet",
      projectId: "default-project",
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: compassDry.rangeStart,
      rangeEnd: compassDry.rangeEnd,
      textSnapshot: compassDry.textSnapshot,
      category: "consistency_anchor",
      persona: compassDry.persona,
      severity: "error",
      content: compassDry.content,
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        codex_ref: {
          entry_id: "codex-akahimo",
          entry_name: compassDry.entryName,
          source_field: "content",
          expected_value: compassDry.expectedValue,
          found_value: compassDry.foundValue,
          found_text: compassDry.foundText,
          found_context: compassDry.foundContext,
          confidence: "high",
          llm_reason: compassDry.llmReason,
          dismiss_key: compassDry.dismissKey,
          detected_by_model: "qwen3:30b",
        },
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ann-akane-memory",
      projectId: "default-project",
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: foreignMemory.rangeStart,
      rangeEnd: foreignMemory.rangeEnd,
      textSnapshot: foreignMemory.textSnapshot,
      category: "consistency_anchor",
      persona: compassDry.persona,
      severity: "warning",
      content: foreignMemory.content,
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        confidence: "medium",
        found_text: foreignMemory.foundText,
        found_context: foreignMemory.foundContext,
        llm_reason: foreignMemory.llmReason,
        dismiss_key: foreignMemory.dismissKey,
        detected_by_model: "qwen3:30b",
      }),
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function getScreenshotTrashItems(now: string) {
  if (!isScreenshotStagingActive()) return [];
  const { sceneDraft, textFragment } =
    SCREENSHOT_SEED_CONTENT[getScreenshotLanguage()].trash;
  return [
    {
      id: "trash-scene-draft",
      projectId: "default-project",
      kind: "structure-item",
      subKind: "scene",
      originSceneId: "scene-1",
      originCodexId: null,
      previewText: sceneDraft.previewText,
      previewMeta: JSON.stringify({
        nodeType: "scene",
        status: "draft",
        folderHintName: sceneDraft.folderHintName,
      }),
      payload: JSON.stringify({
        originalId: "scene-old-fire-night",
        title: sceneDraft.title,
        body: proseDoc(sceneDraft.body),
        beats: "[]",
        povCharacterId: "codex-akane",
        folderHintId: "chapter-1",
        folderHintName: sceneDraft.folderHintName,
        metadata: {
          synopsis: sceneDraft.synopsis,
          status: "draft",
          nodeType: "scene",
          locationId: "codex-haisha",
          sortOrder: "a9",
          storyTimeOrder: "z1",
          storyTimeLabel: sceneDraft.storyTimeLabel,
        },
        charCount: sceneDraft.charCount,
      }),
      charCount: sceneDraft.charCount,
      isInteresting: true,
      deletedAt: now,
    },
    {
      id: "trash-text-fragment",
      projectId: "default-project",
      kind: "text-fragment",
      subKind: "text-fragment",
      originSceneId: "scene-1",
      originCodexId: null,
      previewText: textFragment.previewText,
      previewMeta: null,
      payload: JSON.stringify({
        text: textFragment.text,
        spans: [
          {
            text: textFragment.text,
            source: "human",
            model: null,
            chatMessageId: null,
            timestamp: now,
          },
        ],
      }),
      charCount: textFragment.charCount,
      isInteresting: false,
      deletedAt: now,
    },
  ];
}

function seedBuiltinCodexTypes(db: Database, now: string): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO codex_types
      (id, project_id, slug, label, color, palette_index, icon, is_builtin, sort_order, created_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  [
    ["type-character", "character", "人物", "#7C9BD1", 0, "user", 0],
    ["type-location", "location", "場所", "#7FB08E", 1, "map-pin", 1],
    ["type-item", "item", "道具", "#D4A35F", 2, "package", 2],
    ["type-lore", "lore", "設定", "#A783C9", 3, "book-open", 3],
  ].forEach(([id, slug, label, color, paletteIndex, icon, sortOrder]) => {
    stmt.run([id, slug, label, color, paletteIndex, icon, sortOrder, now]);
  });
  stmt.free();
}

async function seedScreenshotWorkspace(
  db: Database,
  now: string,
): Promise<void> {
  const lang = getScreenshotLanguage();
  const c = SCREENSHOT_SEED_CONTENT[lang];
  db.run(
    `UPDATE projects
     SET title = ?,
       genre = ?,
       pov = ?,
       tense = ?,
       language = ?,
       style_guide = ?,
       ai_instructions = ?,
       updated_at = ?
     WHERE id = 'default-project'`,
    [
      c.project.title,
      c.project.genre,
      c.project.pov,
      c.project.tense,
      lang,
      c.project.styleGuide,
      c.project.aiInstructions,
      now,
    ],
  );

  const sceneContent = proseDoc(c.scenes.scene1.body);

  const nodes = [
    [
      "chapter-1",
      null,
      "folder",
      c.chapter.title,
      c.chapter.synopsis,
      "a0",
      null,
      null,
      null,
      null,
      "none",
      null,
      null,
      "none",
      "exact",
      "outline",
      "{}",
      0,
    ],
    [
      "scene-1",
      "chapter-1",
      "scene",
      c.scenes.scene1.title,
      c.scenes.scene1.synopsis,
      "a0",
      "a0",
      c.scenes.scene1.storyTimeLabel,
      150,
      null,
      "day",
      null,
      null,
      "none",
      "exact",
      "draft",
      sceneContent,
      c.scenes.scene1.charCount,
    ],
    [
      "scene-2",
      "chapter-1",
      "scene",
      c.scenes.scene2.title,
      c.scenes.scene2.synopsis,
      "a1",
      "a1",
      c.scenes.scene2.storyTimeLabel,
      151,
      null,
      "day",
      null,
      null,
      "none",
      "exact",
      "outline",
      proseDoc(c.scenes.scene2.body),
      c.scenes.scene2.charCount,
    ],
    [
      "scene-3",
      "chapter-1",
      "scene",
      c.scenes.scene3.title,
      c.scenes.scene3.synopsis,
      "a2",
      "a2",
      c.scenes.scene3.storyTimeLabel,
      100,
      null,
      "day",
      null,
      null,
      "none",
      "approx",
      "outline",
      proseDoc(c.scenes.scene3.body),
      c.scenes.scene3.charCount,
    ],
  ];

  const nodeStmt = db.prepare(
    `INSERT OR IGNORE INTO tree_nodes
      (id, project_id, parent_id, node_type, title, synopsis, sort_order,
       story_time_order, story_time_label, chronicle_start_time,
       chronicle_start_minute, chronicle_start_granularity,
       chronicle_end_time, chronicle_end_minute, chronicle_end_granularity,
       chronicle_precision, status, content, char_count,
       unplaced_beats_doc, created_at, updated_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  );
  nodes.forEach((row) => nodeStmt.run([...row, now, now]));
  nodeStmt.free();

  const codexRows = [
    [
      "codex-akane",
      "character",
      c.codex.akane.name,
      c.codex.akane.summary,
      JSON.stringify([{ name: c.codex.akane.tagName, color: "#7C9BD1" }]),
    ],
    [
      "codex-otowa",
      "character",
      c.codex.otowa.name,
      c.codex.otowa.summary,
      JSON.stringify([{ name: c.codex.otowa.tagName, color: "#7FB08E" }]),
    ],
    [
      "codex-haisha",
      "location",
      c.codex.haisha.name,
      c.codex.haisha.summary,
      JSON.stringify([{ name: c.codex.haisha.tagName, color: "#7FB08E" }]),
    ],
    [
      "codex-akahimo",
      "item",
      c.codex.akahimo.name,
      c.codex.akahimo.summary,
      JSON.stringify([{ name: c.codex.akahimo.tagName, color: "#9B59B6" }]),
    ],
    [
      "codex-akanawa",
      "lore",
      c.codex.akanawa.name,
      c.codex.akanawa.summary,
      JSON.stringify([{ name: c.codex.akanawa.tagName, color: "#9B59B6" }]),
    ],
  ];
  const codexStmt = db.prepare(
    `INSERT OR IGNORE INTO codex_entries
      (id, project_id, type, name, summary, content, tags_cache, context_mode,
       children_budget, created_at, updated_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, 'mentioned', 'compact', ?, ?)`,
  );
  codexRows.forEach(([id, type, name, summary, tags]) => {
    codexStmt.run([
      id,
      type,
      name,
      summary,
      proseDoc([summary]),
      tags,
      now,
      now,
    ]);
  });
  codexStmt.free();

  const chronicleRows = [
    [
      "shot-event-fire",
      c.chronicle.fire.title,
      c.chronicle.fire.note,
      "a0",
      "codex-akane",
      "codex-haisha",
      100,
      null,
      "day",
      "none",
      "approx",
    ],
    [
      "shot-event-departure",
      c.chronicle.departure.title,
      c.chronicle.departure.note,
      "a1",
      "codex-akane",
      "codex-haisha",
      102,
      null,
      "day",
      "none",
      "exact",
    ],
    [
      "shot-event-return",
      c.chronicle.returnHome.title,
      c.chronicle.returnHome.note,
      "a2",
      "codex-akane",
      "codex-haisha",
      150,
      null,
      "day",
      "none",
      "exact",
    ],
    [
      "shot-event-awakening",
      c.chronicle.awakening.title,
      c.chronicle.awakening.note,
      "a3",
      "codex-akahimo",
      "codex-haisha",
      151,
      153,
      "day",
      "day",
      "unknown",
    ],
  ];
  const chronicleStmt = db.prepare(
    `INSERT OR IGNORE INTO events
      (id, project_id, title, note, ordinal, primary_codex_id,
       location_codex_id, start_time, end_time, start_granularity,
       end_granularity, precision, kind, secret, created_at, updated_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       'generic', 0, ?, ?)`,
  );
  chronicleRows.forEach((row) => chronicleStmt.run([...row, now, now]));
  chronicleStmt.free();

  db.run(
    `INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
     VALUES
      ('shot-event-fire', 'codex-akane', 'witness'),
      ('shot-event-departure', 'codex-akane', 'subject'),
      ('shot-event-return', 'codex-akane', 'subject'),
      ('shot-event-return', 'codex-otowa', 'witness'),
      ('shot-event-awakening', 'codex-akahimo', 'source')`,
  );
  db.run(
    `INSERT OR IGNORE INTO scene_events (scene_id, event_id)
     VALUES
      ('scene-1', 'shot-event-return'),
      ('scene-2', 'shot-event-awakening')`,
  );
  db.run(
    `INSERT OR IGNORE INTO event_relations
      (project_id, cause_event_id, effect_event_id)
     VALUES
      ('default-project', 'shot-event-fire', 'shot-event-departure'),
      ('default-project', 'shot-event-departure', 'shot-event-return'),
      ('default-project', 'shot-event-return', 'shot-event-awakening')`,
  );

  db.run(
    `UPDATE tree_nodes SET pov_character_id = ?, location_id = ? WHERE id = 'scene-1'`,
    ["codex-akane", "codex-haisha"],
  );

  const labelRows = [
    ["label-ki", c.labels.ki, "rose", 0],
    ["label-important", c.labels.important, "red", 1],
    ["label-consider", c.labels.consider, "slate", 2],
  ];
  const labelStmt = db.prepare(
    `INSERT OR IGNORE INTO labels
      (id, project_id, name, color, sort_order, created_at)
     VALUES (?, 'default-project', ?, ?, ?, ?)`,
  );
  labelRows.forEach((row) => labelStmt.run([...row, now]));
  labelStmt.free();
  db.run(
    `INSERT OR IGNORE INTO tree_node_labels (node_id, label_id) VALUES
      ('scene-1', 'label-ki'),
      ('scene-1', 'label-important'),
      ('scene-2', 'label-consider')`,
  );

  db.run(
    `INSERT OR IGNORE INTO snippets
      (id, project_id, title, content, tags_cache, content_source, scene_id,
       source_chat_message_id, usage_count, created_at, updated_at)
     VALUES
      ('snippet-akane-restraint', 'default-project', ?, ?, ?,
       'human', 'scene-1', NULL, 2, ?, ?),
      ('snippet-akahimo-reunion', 'default-project', ?, ?, ?,
       'human', 'scene-1', NULL, 1, ?, ?)`,
    [
      c.snippets.restraint.title,
      proseDoc(c.snippets.restraint.body),
      JSON.stringify([
        { name: c.snippets.restraint.tagName, color: "#5B8CDD" },
      ]),
      now,
      now,
      c.snippets.reunion.title,
      proseDoc(c.snippets.reunion.body),
      JSON.stringify([{ name: c.snippets.reunion.tagName, color: "#9B59B6" }]),
      now,
      now,
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO map_boards
      (id, project_id, title, sort_order, mode, viewport_x, viewport_y,
       viewport_zoom, show_config, color_by, created_at, updated_at)
     VALUES ('default-project-main-board', 'default-project', 'Main', 0, 'free',
       0, 0, 0.9, '{}', 'type', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_node_positions
      (id, board_id, node_ref_type, tree_node_id, codex_entry_id, snippet_id,
       sticky_id, ai_branch_id, x, y, pinned, z_index, created_at, updated_at)
     VALUES
      ('map-pos-akane', 'default-project-main-board', 'codex', NULL,
       'codex-akane', NULL, NULL, NULL, 120, 100, 0, 1, ?, ?),
      ('map-pos-haisha', 'default-project-main-board', 'codex', NULL,
       'codex-haisha', NULL, NULL, NULL, 420, 110, 0, 1, ?, ?),
      ('map-pos-akahimo', 'default-project-main-board', 'codex', NULL,
       'codex-akahimo', NULL, NULL, NULL, 260, 330, 0, 1, ?, ?),
      ('map-pos-scene-1', 'default-project-main-board', 'scene',
       'scene-1', NULL, NULL, NULL, NULL, 720, 160, 0, 1, ?, ?),
      ('map-pos-scene-2', 'default-project-main-board', 'scene',
       'scene-2', NULL, NULL, NULL, NULL, 720, 390, 0, 1, ?, ?)`,
    [now, now, now, now, now, now, now, now, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_edges
      (id, board_id, from_position_id, to_position_id, forward_label,
       backward_label, labels, style, color, direction, created_at, updated_at)
     VALUES
      ('map-edge-1', 'default-project-main-board', 'map-pos-akane',
       'map-pos-scene-1', ?, NULL, '[]', 'solid', '#8b7fd4',
       'forward', ?, ?),
      ('map-edge-2', 'default-project-main-board', 'map-pos-scene-1',
       'map-pos-akahimo', ?, NULL, '[]', 'solid', '#d4a35f',
       'forward', ?, ?)`,
    [c.map.edge1Label, now, now, c.map.edge2Label, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_frames
      (id, board_id, title, x, y, width, height, background, border_color, z_index,
       created_at, updated_at)
     VALUES ('map-frame-return', 'default-project-main-board', ?,
       60, 40, 880, 520, '#2b3038', '#64748b', -1, ?, ?)`,
    [c.map.frameTitle, now, now],
  );

  db.run(
    `INSERT OR IGNORE INTO foreshadows
      (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
       payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
       created_at, updated_at)
     VALUES
      ('fs-akahimo-warmth', 'default-project', ?,
       ?,
       ?, 'scene-2',
       NULL, NULL, 0, 0, 1, 'critical', ?, ?),
      ('fs-haisha-visitor', 'default-project', ?,
       ?,
       ?, NULL,
       NULL, NULL, 0, 0, 1, 'supporting', ?, ?)`,
    [
      c.foreshadows.warmth.title,
      c.foreshadows.warmth.intent,
      c.foreshadows.warmth.notes,
      Date.now(),
      Date.now(),
      c.foreshadows.visitor.title,
      c.foreshadows.visitor.intent,
      c.foreshadows.visitor.notes,
      Date.now(),
      Date.now(),
    ],
  );
  db.run(
    `INSERT OR IGNORE INTO foreshadow_setups
      (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
       ai_strength, ai_reasoning, attribution, ai_rationale,
       last_evaluated_at, is_orphan, created_at, updated_at)
     VALUES
      ('setup-akahimo-warmth', 'fs-akahimo-warmth', 'scene-1', ?, ?,
       'designated_existing', 'moderate', 'moderate',
       ?, 'human',
       NULL, ?, 0, ?, ?),
      ('setup-haisha-lock', 'fs-haisha-visitor', 'scene-1', ?, ?,
       'designated_existing', 'subtle', 'subtle',
       ?, 'human',
       NULL, ?, 0, ?, ?)`,
    [
      c.foreshadows.setupWarmth.fromPos,
      c.foreshadows.setupWarmth.toPos,
      c.foreshadows.setupWarmth.aiReasoning,
      Date.now(),
      Date.now(),
      Date.now(),
      c.foreshadows.setupLock.fromPos,
      c.foreshadows.setupLock.toPos,
      c.foreshadows.setupLock.aiReasoning,
      Date.now(),
      Date.now(),
      Date.now(),
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO chat_sessions
      (id, project_id, node_id, title, title_manual, model, created_at, updated_at)
     VALUES ('chat-scene-1', 'default-project', 'scene-1', ?, 1,
       'qwen3:30b', ?, ?)`,
    [c.chat.sessionTitle, now, now],
  );
  const msgStmt = db.prepare(
    `INSERT OR IGNORE INTO chat_messages
      (id, session_id, role, content, model, tokens_in, tokens_out, duration_ms,
       metadata, is_starred, is_summarized, created_at)
     VALUES (?, 'chat-scene-1', ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
  );
  msgStmt.run([
    "chat-message-user-1",
    "user",
    c.chat.userMsg,
    null,
    null,
    null,
    null,
    0,
    now,
  ]);
  msgStmt.run([
    "chat-message-assistant-1",
    "assistant",
    c.chat.assistantMsg,
    "qwen3:30b",
    820,
    118,
    1320,
    1,
    now,
  ]);
  msgStmt.free();

  const pinStmt = db.prepare(
    `INSERT OR IGNORE INTO chat_session_pinned_codex
      (session_id, codex_entry_id, snippet_id, with_children, pin_source, created_at)
     VALUES ('chat-scene-1', ?, NULL, 0, 'manual', ?)`,
  );
  ["codex-akane", "codex-haisha", "codex-akahimo"].forEach((id) =>
    pinStmt.run([id, now]),
  );
  pinStmt.free();

  db.run(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES
      ('display.reduceMotion', 'true')`,
  );

  db.run(
    `INSERT OR REPLACE INTO project_settings (project_id, key, value)
      VALUES ('default-project', 'editor.tabState', ?)`,
    [
      JSON.stringify({
        tabs: [
          { nodeId: "scene-1", isPreview: false, contentType: "scene" },
          { nodeId: "codex-akahimo", isPreview: false, contentType: "codex" },
        ],
        activeTabId: "scene-1",
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
        secondaryGroupOpen: false,
        splitDirection: "right",
        isLinearMode: false,
      }),
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO codex_quick_pins (entry_id, created_at) VALUES
      ('codex-akahimo', ?),
      ('codex-akane', ?)`,
    [now, now],
  );

  db.run(
    `INSERT OR IGNORE INTO scene_codex_mentions
      (scene_id, codex_entry_id, source, role) VALUES
     ('scene-1', 'codex-akane', 'body', 'mentioned'),
     ('scene-1', 'codex-akahimo', 'body', 'mentioned'),
     ('scene-1', 'codex-haisha', 'body', 'mentioned'),
     ('scene-2', 'codex-akanawa', 'body', 'mentioned')`,
  );

  db.run(
    `INSERT OR IGNORE INTO scene_beat_pov_cache (scene_id, pov_character_id)
     VALUES ('scene-1', 'codex-akane')`,
  );

  db.run(
    `INSERT OR IGNORE INTO authorship_spans
      (id, node_id, codex_entry_id, snippet_id, detail_value_id, from_pos, to_pos, source, model, timestamp, chat_msg_id, phase_id, sticky_id)
     VALUES
      ('shot-auth-s1a', 'scene-1', NULL, NULL, NULL, 0, ?, 'human', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s1b', 'scene-1', NULL, NULL, NULL, ?, ?, 'ai', 'qwen3:30b', ?, NULL, NULL, NULL),
      ('shot-auth-s1c', 'scene-1', NULL, NULL, NULL, ?, ?, 'unknown', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s2a', 'scene-2', NULL, NULL, NULL, 0, ?, 'human', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s3a', 'scene-3', NULL, NULL, NULL, 0, ?, 'ai', 'qwen3:30b', ?, NULL, NULL, NULL)`,
    [
      c.authorship.scene1.humanTo,
      now,
      c.authorship.scene1.humanTo,
      c.authorship.scene1.aiTo,
      now,
      c.authorship.scene1.aiTo,
      c.authorship.scene1.unknownTo,
      now,
      c.authorship.scene2.humanTo,
      now,
      c.authorship.scene3.aiTo,
      now,
    ],
  );

  // 執筆統計パネル用。直近5日の連続執筆と疎な過去日の両方を作り、
  // streak・集計カード・ヒートマップが一枚で確認できるようにする。
  const writingDayOffsets = [0, 1, 2, 3, 4, 6, 7, 9, 12, 16, 24, 35, 52, 84];
  const nowMs = new Date(now).getTime();
  const dayMs = 86_400_000;
  const writingEventStmt = db.prepare(
    `INSERT OR IGNORE INTO change_events
      (event_uid, project_id, scene_id, domain, op_type, entity_type,
       entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
     VALUES (?, 'default-project', ?, 'editor', 'doc.change', 'scene', ?, ?,
       'shot-writing-session', ?, ?, ?, ?)`,
  );
  let prevHash = bytesToHex(GENESIS_HASH);
  for (const [index, dayOffset] of writingDayOffsets.entries()) {
    const sceneId = `scene-${(index % 3) + 1}`;
    const source = c.scenes.scene1.body[index % c.scenes.scene1.body.length];
    const insertedText = source.repeat((index % 3) + 1);
    const sequence = index + 1;
    const timestamp = nowMs - dayOffset * dayMs;
    const payload = JSON.stringify({
      steps: [
        {
          stepType: "replace",
          from: 1,
          to: 1,
          slice: { content: [{ type: "text", text: insertedText }] },
        },
      ],
    });
    const hash = bytesToHex(
      await computeEventHash({
        projectId: "default-project",
        sceneId,
        domain: "editor",
        opType: "doc.change",
        entityType: "scene",
        entityId: sceneId,
        payload,
        sessionId: "shot-writing-session",
        sequence,
        timestamp,
        prevHash: hexToBytes(prevHash),
      }),
    );
    writingEventStmt.run([
      `shot-writing-${sequence}`,
      sceneId,
      sceneId,
      payload,
      sequence,
      timestamp,
      prevHash,
      hash,
    ]);
    prevHash = hash;
  }
  writingEventStmt.free();
}
