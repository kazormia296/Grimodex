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
  type BrowserAiAuditContext,
  type BrowserAiEffectiveRequestReceipt,
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
import {
  AUX_PROJECT_FILTER,
  AUX_SCOPE_OWNER,
  AUX_SCOPES,
  AUX_TABLE,
  type AuxScope,
  type RawRow,
  type RestoreScope,
} from "@/features/revision/projectSnapshotScopes";
import sampleProjectJa from "../../src-tauri/resources/sample_project/v1.json";
import sampleProjectEn from "../../src-tauri/resources/sample_project/v1_en.json";
import {
  AI_AUDIT_JOURNAL_FORMAT_VERSION,
  type AiAuditJournalBatch,
  type AiAuditJournalMaterializedBatch,
  type AiAuditJournalMaterializedEvent,
} from "./browser-db/indexedDbStore";

type BrowserSchemaTable = {
  kind: string;
  columns: Record<
    string,
    {
      ordinal: number;
      declaredType: string;
      notNull: boolean;
      default: string | null;
      primaryKey: number;
    }
  >;
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
  version: number;
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
  semanticKey: string | null;
  version: number;
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
  semanticKey: string | null;
  version: number;
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

function buildBrowserTableDdlStatements(
  contract: BrowserSchemaContract,
  tableName: string,
): string[] {
  const table = contract.tables[tableName];
  if (!table || table.kind !== "table") {
    throw new Error(`canonical browser schema is missing ${tableName}`);
  }
  return [
    executableCreateSql(table.createSql, Object.keys(table.columns)),
    ...Object.values(contract.indexes)
      .filter((index) => index.table === tableName)
      .map((index) => index.createSql),
    ...Object.values(contract.triggers).filter((createSql) =>
      new RegExp(`\\b${tableName}\\b`, "u").test(createSql),
    ),
  ];
}

function buildBrowserTableDdl(
  contract: BrowserSchemaContract,
  tableName: string,
): string {
  const statements = buildBrowserTableDdlStatements(contract, tableName);
  return `${statements.join(";\n")};`;
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

function assertRendererDoesNotMutateAiAudit(sql: string): void {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/--[^\r\n]*/gu, "");
  const referencesAudit =
    /(?:\bmain\s*\.\s*)?[`"'[]?ai_audit_events[`"'\]]?/iu.test(withoutComments);
  const withoutTrailingSemicolon = withoutComments.trim().replace(/;\s*$/u, "");
  const isSingleReadOnlySelect =
    /^select\b/iu.test(withoutTrailingSemicolon) &&
    !withoutTrailingSemicolon.includes(";");
  if (referencesAudit && !isSingleReadOnlySelect) {
    throw new Error(
      "RENDERER_SQL_SECURITY: denied mutation of ai_audit_events; use typed audit commands",
    );
  }
}

const SCHEMA_DDL = buildBrowserSchemaDdl(
  schemaContract as unknown as BrowserSchemaContract,
);
const BROWSER_SCHEMA_CONTRACT =
  schemaContract as unknown as BrowserSchemaContract;
const AI_AUDIT_LEDGER_DDL_STATEMENTS = buildBrowserTableDdlStatements(
  BROWSER_SCHEMA_CONTRACT,
  "ai_audit_events",
);
const AI_AUDIT_LEDGER_CREATE_SQL = AI_AUDIT_LEDGER_DDL_STATEMENTS[0];
const AI_AUDIT_LEDGER_POST_CREATE_SQL = AI_AUDIT_LEDGER_DDL_STATEMENTS.slice(1);
const AI_AUDIT_LEDGER_DDL = buildBrowserTableDdl(
  BROWSER_SCHEMA_CONTRACT,
  "ai_audit_events",
);
const AI_AUDIT_LEDGER_COLUMNS = Object.entries(
  BROWSER_SCHEMA_CONTRACT.tables.ai_audit_events.columns,
)
  .sort(([, left], [, right]) => left.ordinal - right.ordinal)
  .map(([name]) => name);
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
const AI_AUDIT_GENESIS_HASH = "0".repeat(64);
const AI_AUDIT_SCHEMA_VERSION = 1;
const AI_AUDIT_CAPTURE_CONTRACT_VERSION = 1;
const AI_AUDIT_RECORDER = "grimodex-ai-audit";
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
           attribution, is_orphan, semantic_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          entityId(setup.id),
          entityId(setup.foreshadow_id),
          entityId(setup.scene_id),
          setup.from_pos,
          setup.to_pos,
          setup.kind,
          setup.strength ?? null,
          setup.attribution,
          `${entityId(setup.foreshadow_id)}|${entityId(setup.scene_id)}|${setup.from_pos}|${setup.to_pos}`,
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
  /**
   * Production Web runtime durability barrier for AI audit events. The audit
   * append command awaits this after every idempotent attempt, including a
   * resend that inserts zero rows after a lost/rejected persistence ACK.
   */
  onAiAuditDurabilityRequired?: (batch: AiAuditJournalBatch) => Promise<void>;
  /** Stable identity of the SQLite image owned by this BrowserMock instance. */
  workspaceIdentity?: string;
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

interface BrowserAiAuditEventInput {
  eventId: string;
  executionId: string;
  operationId: string;
  parentExecutionId: string | null;
  pathId: string;
  eventType: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

interface BrowserAiAuditExecutionState {
  operationId: string;
  parentExecutionId: string | null;
  pathId: string;
  started: boolean;
  preparedBeforeDispatch: boolean;
  dispatched: boolean;
  responseCompleted: boolean;
  terminalEventType: string | null;
}

const AI_AUDIT_EVENT_TYPES = new Set([
  "execution.started",
  "request.prepared",
  "request.dispatched",
  "transport.attempt.started",
  "transport.attempt.finished",
  "response.partial",
  "response.completed",
  "execution.succeeded",
  "execution.failed",
  "execution.cancelled",
  "execution.skipped",
  "execution.cache_hit",
  "execution.retrying",
  "execution.fallback",
]);
const AI_AUDIT_CAPTURE_STATES = new Set([
  "complete",
  "partial",
  "redacted",
  "truncated",
  "legacy_missing",
  "unobservable_provider",
]);

function observeBrowserAiAuditLifecycleEvent(
  state: BrowserAiAuditExecutionState,
  eventType: string,
): void {
  switch (eventType) {
    case "execution.started":
      state.started = true;
      break;
    case "request.prepared":
      if (!state.dispatched) state.preparedBeforeDispatch = true;
      break;
    case "request.dispatched":
      state.dispatched = true;
      break;
    case "response.completed":
      state.responseCompleted = true;
      break;
    case "execution.succeeded":
    case "execution.failed":
    case "execution.cancelled":
    case "execution.skipped":
    case "execution.cache_hit":
      state.terminalEventType ??= eventType;
      break;
    default:
      break;
  }
}

function validateBrowserAiAuditLifecycleTransition(
  existing: BrowserAiAuditExecutionState | null,
  event: BrowserAiAuditEventInput,
): void {
  if (!existing) {
    if (event.eventType !== "execution.started") {
      throw new Error(
        `AI audit execution must begin with execution.started: ${event.executionId}`,
      );
    }
    return;
  }
  if (!existing.started) {
    throw new Error(
      `AI audit execution has no leading execution.started event: ${event.executionId}`,
    );
  }

  switch (event.eventType) {
    case "execution.started":
      throw new Error(
        `AI audit execution already has execution.started: ${event.executionId}`,
      );
    case "request.prepared":
      if (
        existing.dispatched &&
        event.payload.effectiveRequestReceipt !== true
      ) {
        throw new Error(
          "post-dispatch request.prepared requires payload.effectiveRequestReceipt=true",
        );
      }
      return;
    case "request.dispatched":
      if (!existing.preparedBeforeDispatch) {
        throw new Error(
          "request.dispatched requires a durable pre-dispatch request.prepared",
        );
      }
      if (existing.dispatched) {
        throw new Error(
          `AI audit execution already has request.dispatched: ${event.executionId}`,
        );
      }
      return;
    case "transport.attempt.started":
    case "transport.attempt.finished":
    case "response.partial":
    case "response.completed":
    case "execution.retrying":
    case "execution.fallback":
      if (!existing.dispatched) {
        throw new Error(
          `${event.eventType} requires a durable request.dispatched event`,
        );
      }
      return;
    case "execution.succeeded":
      if (!existing.dispatched) {
        throw new Error(
          "execution.succeeded requires a durable request.dispatched event",
        );
      }
      if (!existing.responseCompleted) {
        throw new Error(
          "execution.succeeded requires a durable response.completed event",
        );
      }
      return;
    case "execution.failed":
    case "execution.cancelled":
      return;
    case "execution.skipped":
    case "execution.cache_hit":
      if (existing.dispatched) {
        throw new Error(
          `${event.eventType} must not follow request.dispatched`,
        );
      }
      return;
    default:
      return;
  }
}
function normalizedAiAuditKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function segmentedAiAuditKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

const AI_AUDIT_STRONG_CREDENTIAL_KEY_MARKERS = [
  "authorization",
  "authentication",
  "headers",
  "cookie",
  "environment",
  "apikey",
  "accesstoken",
  "bearer",
  "accesskeyid",
  "secretaccesskey",
  "privatekey",
  "password",
  "passwd",
] as const;

const AI_AUDIT_SAFE_SEMANTIC_TOKEN_KEYS = new Set([
  "tokenizeridentity",
  "tokenizeridentitystatus",
  "tokenization",
  "tokenizationcapture",
  "tokenizeraddsspecialtokens",
  "tokenizermaytruncateat",
]);

function hasCredentialMarkerAtKeyBoundary(
  normalized: string,
  marker: string,
): boolean {
  return (
    normalized === marker ||
    normalized.startsWith(marker) ||
    normalized.endsWith(marker)
  );
}

function forbiddenAiAuditKey(key: string): boolean {
  const normalized = normalizedAiAuditKey(key);
  const segmented = segmentedAiAuditKey(key);
  const segments = segmented ? segmented.split("_") : [];
  if (
    normalized === "auth" ||
    normalized.endsWith("auth") ||
    segments.includes("auth")
  ) {
    return true;
  }
  if (
    AI_AUDIT_STRONG_CREDENTIAL_KEY_MARKERS.some((marker) =>
      hasCredentialMarkerAtKeyBoundary(normalized, marker),
    )
  ) {
    return true;
  }
  if (
    normalized === "env" ||
    normalized.startsWith("environment") ||
    normalized.startsWith("processenv") ||
    normalized.endsWith("env")
  ) {
    return true;
  }
  if (
    normalized === "secret" ||
    normalized.startsWith("secret") ||
    normalized.endsWith("secret")
  ) {
    return true;
  }
  if (
    normalized === "token" ||
    normalized.endsWith("token") ||
    (normalized.startsWith("token") &&
      !AI_AUDIT_SAFE_SEMANTIC_TOKEN_KEYS.has(normalized) &&
      !/^(?:tokens|(?:token|tokens)(?:usage|count|counts|budget|limit|limits|estimate|estimated|total|totals|used|remaining|input|output|cached|reasoning|billable))$/u.test(
        normalized,
      ))
  ) {
    return true;
  }
  return false;
}

type BrowserAiAuditJsonPathSegment = string | number;

function isBrowserAiAuditVisiblePath(
  eventType: string,
  path: readonly BrowserAiAuditJsonPathSegment[],
): boolean {
  if (
    eventType === "request.prepared" &&
    path.length === 1 &&
    path[0] === "input"
  ) {
    // Native semantic inference records the exact model input directly at
    // payload.input rather than under the renderer request envelope.
    return true;
  }
  if (eventType === "request.prepared" && path[0] === "request") {
    if (
      path.length === 2 &&
      ["body", "input", "tools", "modelVisibleContext"].includes(
        String(path[1]),
      )
    ) {
      return true;
    }
    return (
      path.length === 3 && path[1] === "messages" && typeof path[2] === "number"
    );
  }
  return (
    path.length === 1 &&
    path[0] === "response" &&
    (eventType === "response.partial" ||
      eventType === "response.completed" ||
      eventType === "execution.cache_hit")
  );
}

function isBrowserAiAuditVisibilityResetPath(
  eventType: string,
  path: readonly BrowserAiAuditJsonPathSegment[],
): boolean {
  // Codex runtime warnings use this known diagnostic wrapper. Its producer
  // sanitizes free-form diagnostic strings and the persistence boundary keeps
  // credential-shaped fields fail-closed as defense in depth. Other observed
  // response/tool payloads remain exact even when they contain same-named keys.
  return (
    eventType === "response.partial" &&
    path.length === 2 &&
    path[0] === "response" &&
    path[1] === "runtimeDiagnostic"
  );
}

function validateBrowserAiAuditJson(
  value: unknown,
  path: string,
  eventType: string,
  jsonPath: readonly BrowserAiAuditJsonPathSegment[] = [],
  seen = new WeakSet<object>(),
  aiVisible = false,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers`);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must be JSON-compatible`);
  }
  if (seen.has(value)) throw new Error(`${path} must not be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childPath = [...jsonPath, index];
      validateBrowserAiAuditJson(
        item,
        `${path}[${index}]`,
        eventType,
        childPath,
        seen,
        aiVisible || isBrowserAiAuditVisiblePath(eventType, childPath),
      );
    });
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (!aiVisible && forbiddenAiAuditKey(key)) {
        throw new Error(
          `${path}.${key} contains excluded transport credentials`,
        );
      }
      const childPath = [...jsonPath, key];
      const childAiVisible = isBrowserAiAuditVisibilityResetPath(
        eventType,
        childPath,
      )
        ? false
        : aiVisible || isBrowserAiAuditVisiblePath(eventType, childPath);
      validateBrowserAiAuditJson(
        child,
        `${path}.${key}`,
        eventType,
        childPath,
        seen,
        childAiVisible,
      );
    }
  }
  seen.delete(value);
}

function validateBrowserAiAuditEvent(
  event: BrowserAiAuditEventInput,
  index: number,
): void {
  for (const [key, value] of [
    ["eventId", event.eventId],
    ["executionId", event.executionId],
    ["operationId", event.operationId],
    ["pathId", event.pathId],
    ["eventType", event.eventType],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`events[${index}].${key} is required`);
    }
  }
  if (!AI_AUDIT_EVENT_TYPES.has(event.eventType)) {
    throw new Error(`events[${index}].eventType is unsupported`);
  }
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) {
    throw new Error(`events[${index}].timestamp is invalid`);
  }
  if (
    event.parentExecutionId !== null &&
    (typeof event.parentExecutionId !== "string" ||
      event.parentExecutionId.length === 0)
  ) {
    throw new Error(`events[${index}].parentExecutionId is invalid`);
  }
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload) ||
    !AI_AUDIT_CAPTURE_STATES.has(String(event.payload.captureState))
  ) {
    throw new Error(`events[${index}].payload.captureState is invalid`);
  }
  if (
    event.eventType === "request.prepared" &&
    event.payload.credentialsExcluded !== true
  ) {
    throw new Error(
      `events[${index}].payload.credentialsExcluded must be true`,
    );
  }
  const redactions = event.payload.redactions;
  if (redactions !== undefined) {
    if (!Array.isArray(redactions)) {
      throw new Error(`events[${index}].payload.redactions must be an array`);
    }
    const allowedKeys = new Set([
      "path",
      "category",
      "ruleId",
      "originalSha256",
      "originalByteLength",
      "placeholder",
      "reversible",
    ]);
    redactions.forEach((candidate, redactionIndex) => {
      const path = `events[${index}].payload.redactions[${redactionIndex}]`;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        throw new Error(`${path} must be an object`);
      }
      const record = candidate as Record<string, unknown>;
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new Error(`${path} contains an unexpected redaction key`);
      }
      if (
        typeof record.path !== "string" ||
        !record.path.trim() ||
        record.category !== "credential" ||
        typeof record.ruleId !== "string" ||
        !record.ruleId.trim() ||
        typeof record.originalSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.originalSha256) ||
        !Number.isSafeInteger(record.originalByteLength) ||
        Number(record.originalByteLength) < 0 ||
        record.placeholder !== "[REDACTED:credential]" ||
        record.reversible !== false
      ) {
        throw new Error(`${path} is not a valid credential redaction record`);
      }
    });
  }
  validateBrowserAiAuditJson(
    event.payload,
    `events[${index}].payload`,
    event.eventType,
  );
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

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalizeAiAuditJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeAiAuditJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, canonicalizeAiAuditJson(child)]),
    );
  }
  return value;
}

async function sha256AuditHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function enrichBrowserAiAuditPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...payload,
    auditSchemaVersion: AI_AUDIT_SCHEMA_VERSION,
    captureContractVersion: AI_AUDIT_CAPTURE_CONTRACT_VERSION,
    recorder: AI_AUDIT_RECORDER,
    appVersion:
      typeof payload.appVersion === "string" && payload.appVersion.trim()
        ? payload.appVersion
        : "unknown",
  };
}

function canonicalStoredAiAuditPayload(
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(canonicalizeAiAuditJson(payload));
}

function validateStoredAiAuditCaptureContract(
  payload: Record<string, unknown>,
): string | null {
  if (payload.auditSchemaVersion !== AI_AUDIT_SCHEMA_VERSION) {
    return "payload.auditSchemaVersion is unsupported";
  }
  if (payload.captureContractVersion !== AI_AUDIT_CAPTURE_CONTRACT_VERSION) {
    return "payload.captureContractVersion is unsupported";
  }
  if (payload.recorder !== AI_AUDIT_RECORDER) {
    return "payload.recorder is unsupported";
  }
  if (typeof payload.appVersion !== "string" || !payload.appVersion.trim()) {
    return "payload.appVersion is required";
  }
  return null;
}

function canonicalAiAuditPayloadForAppend(
  payload: Record<string, unknown>,
): string {
  return canonicalStoredAiAuditPayload(enrichBrowserAiAuditPayload(payload));
}

async function browserAiAuditJournalBatch(
  materializedBatch: AiAuditJournalMaterializedBatch,
): Promise<AiAuditJournalBatch> {
  // Persist the exact rows accepted by SQLite. Replaying this object must not
  // enrich payloads, assign recordedAt values, or recompute the hash chain.
  const appendArgsJson = JSON.stringify(
    canonicalizeAiAuditJson(materializedBatch),
  );
  return {
    batchId: await sha256AuditHex(appendArgsJson),
    appendArgsJson,
  };
}

interface BrowserAiAuditHashInput {
  scopeId: string;
  projectId: string | null;
  sequence: number;
  eventId: string;
  executionId: string;
  operationId: string;
  parentExecutionId: string | null;
  pathId: string;
  eventType: string;
  timestamp: number;
  recordedAt: number;
  payloadSha256: string;
  prevHash: string;
}

async function browserAiAuditHash(
  input: BrowserAiAuditHashInput,
): Promise<string> {
  // Preserve the Rust HashInput field order exactly; JSON object insertion
  // order is part of this private cross-runtime hash contract.
  return sha256AuditHex(
    JSON.stringify({
      scopeId: input.scopeId,
      projectId: input.projectId,
      sequence: input.sequence,
      eventId: input.eventId,
      executionId: input.executionId,
      operationId: input.operationId,
      parentExecutionId: input.parentExecutionId,
      pathId: input.pathId,
      eventType: input.eventType,
      timestamp: input.timestamp,
      recordedAt: input.recordedAt,
      payloadSha256: input.payloadSha256,
      prevHash: input.prevHash,
    }),
  );
}

function browserTableColumns(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`)[0];
  if (!result) return [];
  const nameIndex = result.columns.indexOf("name");
  return result.values.map((row) => String(row[nameIndex]));
}

function browserTableMatchesContract(db: Database, table: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`)[0];
  const expectedTable = (schemaContract as BrowserSchemaContract).tables[table];
  if (!result || !expectedTable) return false;
  const nameIndex = result.columns.indexOf("name");
  const typeIndex = result.columns.indexOf("type");
  const notNullIndex = result.columns.indexOf("notnull");
  const defaultIndex = result.columns.indexOf("dflt_value");
  const primaryKeyIndex = result.columns.indexOf("pk");
  const expectedColumns = Object.entries(expectedTable.columns).sort(
    (left, right) => left[1].ordinal - right[1].ordinal,
  );
  return (
    result.values.length === expectedColumns.length &&
    result.values.every((row, index) => {
      const [expectedName, expected] = expectedColumns[index];
      const actualDefault =
        row[defaultIndex] === null ? null : String(row[defaultIndex]);
      return (
        String(row[nameIndex]) === expectedName &&
        String(row[typeIndex]).toUpperCase() === expected.declaredType &&
        Boolean(Number(row[notNullIndex])) === expected.notNull &&
        actualDefault === expected.default &&
        Number(row[primaryKeyIndex]) === expected.primaryKey
      );
    })
  );
}

function browserCompactSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/gu, "");
}

function browserIndexMatches(
  db: Database,
  table: string,
  indexName: string,
  unique: boolean,
  columns: readonly string[],
): boolean {
  const list = db.exec(`PRAGMA index_list(${table})`)[0];
  if (!list) return false;
  const nameIndex = list.columns.indexOf("name");
  const uniqueIndex = list.columns.indexOf("unique");
  const partialIndex = list.columns.indexOf("partial");
  const row = list.values.find(
    (candidate) => String(candidate[nameIndex]) === indexName,
  );
  if (
    !row ||
    Boolean(Number(row[uniqueIndex])) !== unique ||
    Number(row[partialIndex]) !== 0
  ) {
    return false;
  }
  const info = db.exec(`PRAGMA index_info(${indexName})`)[0];
  if (!info) return false;
  const columnNameIndex = info.columns.indexOf("name");
  const actual = info.values.map((candidate) =>
    String(candidate[columnNameIndex]),
  );
  return (
    actual.length === columns.length &&
    actual.every((column, index) => column === columns[index])
  );
}

function browserSemanticBindingsSchemaIsValid(db: Database): boolean {
  if (!browserTableMatchesContract(db, "codex_detail_semantic_bindings")) {
    return false;
  }
  if (
    !browserIndexMatches(
      db,
      "codex_detail_definitions",
      "uq_codex_detail_defs_project_id",
      true,
      ["project_id", "id"],
    ) ||
    !browserIndexMatches(
      db,
      "codex_detail_semantic_bindings",
      "uq_codex_detail_semantic_binding_definition_facet",
      true,
      ["definition_id", "facet_key"],
    ) ||
    !browserIndexMatches(
      db,
      "codex_detail_semantic_bindings",
      "idx_codex_detail_semantic_bindings_project_facet",
      false,
      ["project_id", "facet_key"],
    )
  ) {
    return false;
  }

  const foreignKeys = db.exec(
    "PRAGMA foreign_key_list(codex_detail_semantic_bindings)",
  )[0];
  if (!foreignKeys) return false;
  const idIndex = foreignKeys.columns.indexOf("id");
  const sequenceIndex = foreignKeys.columns.indexOf("seq");
  const tableIndex = foreignKeys.columns.indexOf("table");
  const fromIndex = foreignKeys.columns.indexOf("from");
  const toIndex = foreignKeys.columns.indexOf("to");
  const deleteIndex = foreignKeys.columns.indexOf("on_delete");
  const groups = new Map<number, SqlValue[][]>();
  for (const row of foreignKeys.values) {
    const id = Number(row[idIndex]);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const foreignKeyGroups = [...groups.values()];
  const hasDefinitionOwner = foreignKeyGroups.some((group) => {
    const ordered = [...group].sort(
      (left, right) =>
        Number(left[sequenceIndex]) - Number(right[sequenceIndex]),
    );
    return (
      ordered.length === 2 &&
      ordered.every(
        (row) =>
          String(row[tableIndex]) === "codex_detail_definitions" &&
          String(row[deleteIndex]).toUpperCase() === "CASCADE",
      ) &&
      String(ordered[0][fromIndex]) === "project_id" &&
      String(ordered[0][toIndex]) === "project_id" &&
      String(ordered[1][fromIndex]) === "definition_id" &&
      String(ordered[1][toIndex]) === "id"
    );
  });
  const hasProjectOwner = foreignKeyGroups.some(
    (group) =>
      group.length === 1 &&
      String(group[0][tableIndex]) === "projects" &&
      String(group[0][fromIndex]) === "project_id" &&
      String(group[0][toIndex]) === "id" &&
      String(group[0][deleteIndex]).toUpperCase() === "CASCADE",
  );
  if (
    foreignKeyGroups.length !== 2 ||
    !hasDefinitionOwner ||
    !hasProjectOwner
  ) {
    return false;
  }

  const tableSqlResult = db.exec(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_detail_semantic_bindings'",
  )[0];
  if (!tableSqlResult || tableSqlResult.values.length !== 1) return false;
  const sqlIndex = tableSqlResult.columns.indexOf("sql");
  const compact = browserCompactSql(String(tableSqlResult.values[0][sqlIndex]));
  return [
    "check(projection_kindin('scalar-text','summary-text','enum','entity-reference'))",
    "check(temporal_policyin('base-only','phase-on-durable-change','base-and-phase','derived','manual-only'))",
    "check(sourcein('preset','user','reviewed-ai'))",
    "check(confirmedin(0,1))",
    "check(version>=0)",
  ].every((required) => compact.includes(required));
}

function browserProjectCalendarVersionIsValid(db: Database): boolean {
  const info = db.exec("PRAGMA table_info(project_calendar)")[0];
  if (!info) return false;
  const nameIndex = info.columns.indexOf("name");
  const typeIndex = info.columns.indexOf("type");
  const notNullIndex = info.columns.indexOf("notnull");
  const defaultIndex = info.columns.indexOf("dflt_value");
  const primaryKeyIndex = info.columns.indexOf("pk");
  const version = info.values.find(
    (column) => String(column[nameIndex]) === "version",
  );
  return (
    version !== undefined &&
    String(version[typeIndex]).toUpperCase() === "INTEGER" &&
    Boolean(Number(version[notNullIndex])) &&
    String(version[defaultIndex]) === "0" &&
    Number(version[primaryKeyIndex]) === 0
  );
}

function migrateBrowserProjectCalendarVersion(db: Database): boolean {
  const columns = browserTableColumns(db, "project_calendar");
  if (columns.length === 0) {
    db.run(
      buildBrowserTableDdl(
        schemaContract as unknown as BrowserSchemaContract,
        "project_calendar",
      ),
    );
    if (!browserProjectCalendarVersionIsValid(db)) {
      throw new Error("Project Calendar browser schema migration failed");
    }
    return true;
  }
  if (!columns.includes("version")) {
    db.run(
      "ALTER TABLE project_calendar ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
    );
    if (!browserProjectCalendarVersionIsValid(db)) {
      throw new Error("Project Calendar browser schema migration failed");
    }
    return true;
  }
  if (!browserProjectCalendarVersionIsValid(db)) {
    throw new Error(
      "Unsupported prerelease project_calendar.version schema; export with the originating build before upgrading",
    );
  }
  return false;
}

function browserAiAuditHasProjectForeignKey(db: Database): boolean {
  const result = db.exec("PRAGMA foreign_key_list(ai_audit_events)")[0];
  if (!result) return false;
  const tableIndex = result.columns.indexOf("table");
  const fromIndex = result.columns.indexOf("from");
  return result.values.some(
    (row) =>
      String(row[tableIndex]) === "projects" &&
      String(row[fromIndex]) === "project_id",
  );
}

function migrateBrowserAiAuditLedger(db: Database): boolean {
  const columns = browserTableColumns(db, "ai_audit_events");
  if (columns.length === 0) {
    db.run(AI_AUDIT_LEDGER_DDL);
    return true;
  }
  if (
    columns.length !== AI_AUDIT_LEDGER_COLUMNS.length ||
    columns.some((column, index) => column !== AI_AUDIT_LEDGER_COLUMNS[index])
  ) {
    throw new Error(
      "Unsupported prerelease ai_audit_events schema; export with the originating build before upgrading",
    );
  }
  if (!browserAiAuditHasProjectForeignKey(db)) {
    return false;
  }

  const migratedTable = "grimodex_ai_audit_events_without_project_fk";
  const migratedCreateSql = AI_AUDIT_LEDGER_CREATE_SQL.replace(
    /^(CREATE TABLE(?: IF NOT EXISTS)?\s+)ai_audit_events\b/u,
    `$1${migratedTable}`,
  );
  if (migratedCreateSql === AI_AUDIT_LEDGER_CREATE_SQL) {
    throw new Error("canonical ai_audit_events CREATE statement is invalid");
  }
  const columnList = AI_AUDIT_LEDGER_COLUMNS.join(", ");
  const foreignKeysEnabled =
    Number(db.exec("PRAGMA foreign_keys")[0]?.values[0]?.[0] ?? 0) !== 0;
  if (foreignKeysEnabled) db.run("PRAGMA foreign_keys = OFF;");
  let migrationFailure: { cause: unknown } | null = null;
  try {
    db.run(`BEGIN IMMEDIATE;
      CREATE TEMP TABLE grimodex_ai_audit_sequence_high_water (
        sequence INTEGER NOT NULL
      );
      INSERT INTO grimodex_ai_audit_sequence_high_water (sequence)
        SELECT MAX(
          COALESCE((
            SELECT seq FROM sqlite_sequence WHERE name = 'ai_audit_events'
          ), 0),
          COALESCE((SELECT MAX(id) FROM ai_audit_events), 0)
        );
      ${migratedCreateSql};
      INSERT INTO ${migratedTable} (${columnList})
        SELECT ${columnList} FROM ai_audit_events;
      DROP TABLE ai_audit_events;
      ALTER TABLE ${migratedTable} RENAME TO ai_audit_events;
      ${AI_AUDIT_LEDGER_POST_CREATE_SQL.join(";\n")};
      UPDATE sqlite_sequence
         SET seq = (SELECT sequence FROM grimodex_ai_audit_sequence_high_water)
       WHERE name = 'ai_audit_events';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'ai_audit_events', sequence
          FROM grimodex_ai_audit_sequence_high_water
         WHERE sequence > 0
           AND NOT EXISTS (
             SELECT 1 FROM sqlite_sequence WHERE name = 'ai_audit_events'
           );
      DELETE FROM sqlite_sequence
       WHERE name = '${migratedTable}';
      DROP TABLE grimodex_ai_audit_sequence_high_water;
      COMMIT;`);
  } catch (error) {
    try {
      db.run("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    migrationFailure = { cause: error };
  }
  let restoreFailure: { cause: unknown } | null = null;
  if (foreignKeysEnabled) {
    try {
      db.run("PRAGMA foreign_keys = ON;");
    } catch (error) {
      restoreFailure = { cause: error };
    }
  }
  if (migrationFailure) throw migrationFailure.cause;
  if (restoreFailure) throw restoreFailure.cause;
  if (browserAiAuditHasProjectForeignKey(db)) {
    throw new Error("ai_audit_events project foreign key migration failed");
  }
  const integrity = db.exec("PRAGMA integrity_check")[0]?.values[0]?.[0];
  if (integrity !== "ok") {
    throw new Error(
      `ai_audit_events project identity migration failed integrity_check: ${String(integrity)}`,
    );
  }
  return true;
}

const BROWSER_DOMAIN_MIGRATION_TABLES = [
  "scene_events",
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  "foreshadows",
  "foreshadow_setups",
  "foreshadow_codex_links",
  "foreshadow_payoffs",
  "foreshadow_setup_payoff_links",
] as const;

const BROWSER_DOMAIN_MIGRATION_COLUMNS = [
  ["scene_events", "incarnation_token", "TEXT NOT NULL DEFAULT ''"],
  ["plot_threads", "version", "INTEGER NOT NULL DEFAULT 0"],
  ["plot_thread_scene_links", "version", "INTEGER NOT NULL DEFAULT 0"],
  ["plot_thread_scene_links", "semantic_key", "TEXT NOT NULL DEFAULT ''"],
  ["plot_thread_branches", "version", "INTEGER NOT NULL DEFAULT 0"],
  ["plot_thread_branches", "semantic_key", "TEXT NOT NULL DEFAULT ''"],
  ["foreshadows", "version", "INTEGER NOT NULL DEFAULT 0"],
  ["foreshadows", "mechanism", "TEXT"],
  ["foreshadow_setups", "role", "TEXT NOT NULL DEFAULT 'unspecified'"],
  ["foreshadow_setups", "evidence_anchor_id", "TEXT"],
  ["foreshadow_setups", "semantic_key", "TEXT NOT NULL DEFAULT ''"],
] as const;

const BROWSER_DOMAIN_MIGRATION_INDEXES = [
  [
    "plot_thread_scene_links",
    "idx_plot_thread_links_semantic_key",
    false,
    ["semantic_key"],
  ],
  [
    "plot_thread_scene_links",
    "uq_plot_thread_links_semantic_key",
    true,
    ["semantic_key"],
  ],
  [
    "plot_thread_branches",
    "idx_plot_thread_branches_semantic_key",
    false,
    ["semantic_key"],
  ],
  [
    "plot_thread_branches",
    "uq_plot_thread_branches_semantic_key",
    true,
    ["semantic_key"],
  ],
  ["foreshadow_setups", "idx_fs_setup_semantic_key", false, ["semantic_key"]],
  ["foreshadow_setups", "uq_fs_setup_semantic_key", true, ["semantic_key"]],
  ["foreshadow_payoffs", "idx_fs_payoff_fid", false, ["foreshadow_id"]],
  ["foreshadow_payoffs", "idx_fs_payoff_scene", false, ["scene_id"]],
  ["foreshadow_payoffs", "idx_fs_payoff_semantic_key", false, ["semantic_key"]],
  ["foreshadow_payoffs", "uq_fs_payoff_semantic_key", true, ["semantic_key"]],
  [
    "foreshadow_setup_payoff_links",
    "idx_fs_payoff_link_setup",
    false,
    ["setup_id"],
  ],
  [
    "foreshadow_setup_payoff_links",
    "idx_fs_payoff_link_payoff",
    false,
    ["payoff_id"],
  ],
] as const;

function browserSchemaObjectExists(
  db: Database,
  type: "table" | "index",
  name: string,
): boolean {
  const statement = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  );
  try {
    statement.bind([type, name]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function browserQueryHasRows(db: Database, sql: string): boolean {
  return (db.exec(sql)[0]?.values.length ?? 0) > 0;
}

function migrateBrowserDomainSchema(db: Database): boolean {
  const missingTables = BROWSER_DOMAIN_MIGRATION_TABLES.filter(
    (table) => !browserSchemaObjectExists(db, "table", table),
  );
  const missingColumns = BROWSER_DOMAIN_MIGRATION_COLUMNS.filter(
    ([table, column]) =>
      !missingTables.includes(table) &&
      !browserTableColumns(db, table).includes(column),
  );
  const missingIndexes = BROWSER_DOMAIN_MIGRATION_INDEXES.filter(
    ([table, name, unique, columns]) => {
      if (!browserSchemaObjectExists(db, "index", name)) return true;
      if (!browserIndexMatches(db, table, name, unique, columns)) {
        throw new Error(
          `Unsupported prerelease browser domain index '${name}'; export with the originating build before upgrading`,
        );
      }
      return false;
    },
  );
  const schemaNeedsMigration =
    missingTables.length > 0 ||
    missingColumns.length > 0 ||
    missingIndexes.length > 0;
  const contentNeedsMigration =
    schemaNeedsMigration ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM plot_thread_scene_links
        WHERE semantic_key IS NULL OR semantic_key = '' LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM plot_thread_branches
        WHERE semantic_key IS NULL OR semantic_key = '' LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM foreshadow_setups
        WHERE role IS NULL OR role = '' OR semantic_key IS NULL
           OR semantic_key = '' LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM foreshadow_payoffs
        WHERE semantic_key IS NULL OR semantic_key = '' LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM foreshadows root
        WHERE (
          root.payoff_scene_id IS NULL
          AND (
            root.payoff_from_pos IS NOT NULL
            OR root.payoff_to_pos IS NOT NULL
          )
        ) OR (
          root.payoff_scene_id IS NOT NULL
          AND (
            NOT EXISTS (
              SELECT 1 FROM tree_nodes scene
               WHERE scene.id = root.payoff_scene_id
                 AND scene.project_id = root.project_id
                 AND scene.node_type = 'scene'
            )
            OR (
              root.payoff_from_pos IS NULL
              AND root.payoff_to_pos IS NOT NULL
            )
            OR (
              root.payoff_from_pos IS NOT NULL
              AND root.payoff_to_pos IS NULL
            )
            OR (
              root.payoff_from_pos IS NOT NULL
              AND root.payoff_to_pos IS NOT NULL
              AND (
                root.payoff_from_pos < 0
                OR root.payoff_from_pos > root.payoff_to_pos
              )
            )
          )
        )
        LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM foreshadow_payoffs payoff
        WHERE NOT EXISTS (
          SELECT 1
            FROM foreshadows root
            JOIN tree_nodes scene
              ON scene.id = payoff.scene_id
             AND scene.project_id = root.project_id
             AND scene.node_type = 'scene'
           WHERE root.id = payoff.foreshadow_id
        )
        LIMIT 1`,
    ) ||
    browserQueryHasRows(
      db,
      `SELECT 1 FROM foreshadows root
        WHERE payoff_scene_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM foreshadow_payoffs payoff
             WHERE payoff.foreshadow_id = root.id
               AND (
                 payoff.is_primary = 1
                 OR (
                   payoff.scene_id = root.payoff_scene_id
                   AND payoff.from_pos IS root.payoff_from_pos
                   AND payoff.to_pos IS root.payoff_to_pos
                 )
               )
          )
        LIMIT 1`,
    );
  if (!contentNeedsMigration) return false;

  db.run("BEGIN IMMEDIATE");
  try {
    for (const table of missingTables) {
      db.run(buildBrowserTableDdl(BROWSER_SCHEMA_CONTRACT, table));
    }
    for (const [
      table,
      column,
      declaration,
    ] of BROWSER_DOMAIN_MIGRATION_COLUMNS) {
      if (!browserTableColumns(db, table).includes(column)) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      }
    }
    // Older Browser writers accepted folders/notes as payoff scenes. Capture
    // every affected root before deleting invalid payoff children, whose
    // incident support edges cascade. The temporary primary key ensures a root
    // with both an invalid inline anchor and invalid children advances exactly
    // one OCC token. Valid children and Codex links remain intact, while stale
    // pre-repair writes and undo snapshots can no longer restore corruption.
    //
    // The remaining backfills mirror native schema 11 and 12 ordering:
    // natural keys, stable legacy duplicate suffixes, then unique indexes.
    db.run(`
      UPDATE plot_thread_scene_links
         SET semantic_key = thread_id || '|' || node_id || '|' || phase_type
       WHERE semantic_key = '' OR semantic_key IS NULL;
      UPDATE plot_thread_scene_links
         SET semantic_key = semantic_key || '#dup:' || id
       WHERE id IN (
         SELECT id FROM plot_thread_scene_links a
          WHERE EXISTS (
            SELECT 1 FROM plot_thread_scene_links b
             WHERE b.semantic_key = a.semantic_key AND b.rowid < a.rowid
          )
       );
      UPDATE plot_thread_branches
         SET semantic_key = from_thread_id || '|' || to_thread_id || '|' || at_node_id || '|' || kind
       WHERE semantic_key = '' OR semantic_key IS NULL;
      UPDATE plot_thread_branches
         SET semantic_key = semantic_key || '#dup:' || id
       WHERE id IN (
         SELECT id FROM plot_thread_branches a
          WHERE EXISTS (
            SELECT 1 FROM plot_thread_branches b
             WHERE b.semantic_key = a.semantic_key AND b.rowid < a.rowid
          )
       );
      UPDATE foreshadow_setups
         SET role = 'unspecified'
       WHERE role IS NULL OR role = '';
      UPDATE foreshadow_setups
         SET semantic_key = foreshadow_id || '|' || scene_id || '|' || from_pos || '|' || to_pos
       WHERE semantic_key IS NULL OR semantic_key = '';
      UPDATE foreshadow_setups
         SET semantic_key = semantic_key || '#dup:' || id
       WHERE id IN (
         SELECT id FROM foreshadow_setups a
          WHERE EXISTS (
            SELECT 1 FROM foreshadow_setups b
             WHERE b.semantic_key = a.semantic_key AND b.rowid < a.rowid
           )
       );
      CREATE TEMP TABLE grimodex_foreshadow_payoff_repairs (
        foreshadow_id TEXT PRIMARY KEY,
        clear_root_anchor INTEGER NOT NULL
      );
      INSERT INTO grimodex_foreshadow_payoff_repairs (
        foreshadow_id, clear_root_anchor
      )
      SELECT root.id, 1
        FROM foreshadows root
       WHERE (
         root.payoff_scene_id IS NULL
         AND (
           root.payoff_from_pos IS NOT NULL
           OR root.payoff_to_pos IS NOT NULL
         )
       ) OR (
         root.payoff_scene_id IS NOT NULL
         AND (
           NOT EXISTS (
             SELECT 1 FROM tree_nodes scene
              WHERE scene.id = root.payoff_scene_id
                AND scene.project_id = root.project_id
                AND scene.node_type = 'scene'
           )
           OR (
             root.payoff_from_pos IS NULL
             AND root.payoff_to_pos IS NOT NULL
           )
           OR (
             root.payoff_from_pos IS NOT NULL
             AND root.payoff_to_pos IS NULL
           )
           OR (
             root.payoff_from_pos IS NOT NULL
             AND root.payoff_to_pos IS NOT NULL
             AND (
               root.payoff_from_pos < 0
               OR root.payoff_from_pos > root.payoff_to_pos
             )
           )
         )
       );
      INSERT OR IGNORE INTO grimodex_foreshadow_payoff_repairs (
        foreshadow_id, clear_root_anchor
      )
      SELECT DISTINCT root.id, 0
        FROM foreshadows root
        JOIN foreshadow_payoffs payoff
          ON payoff.foreshadow_id = root.id
       WHERE NOT EXISTS (
         SELECT 1 FROM tree_nodes scene
          WHERE scene.id = payoff.scene_id
            AND scene.project_id = root.project_id
            AND scene.node_type = 'scene'
       );
      DELETE FROM foreshadow_payoffs
       WHERE NOT EXISTS (
         SELECT 1
           FROM foreshadows root
           JOIN tree_nodes scene
             ON scene.id = foreshadow_payoffs.scene_id
            AND scene.project_id = root.project_id
            AND scene.node_type = 'scene'
          WHERE root.id = foreshadow_payoffs.foreshadow_id
       );
      UPDATE foreshadows
         SET payoff_scene_id = CASE WHEN (
               SELECT repair.clear_root_anchor
                 FROM grimodex_foreshadow_payoff_repairs repair
                WHERE repair.foreshadow_id = foreshadows.id
             ) = 1 THEN NULL ELSE payoff_scene_id END,
             payoff_from_pos = CASE WHEN (
               SELECT repair.clear_root_anchor
                 FROM grimodex_foreshadow_payoff_repairs repair
                WHERE repair.foreshadow_id = foreshadows.id
             ) = 1 THEN NULL ELSE payoff_from_pos END,
             payoff_to_pos = CASE WHEN (
               SELECT repair.clear_root_anchor
                 FROM grimodex_foreshadow_payoff_repairs repair
                WHERE repair.foreshadow_id = foreshadows.id
             ) = 1 THEN NULL ELSE payoff_to_pos END,
             version = version + 1,
             updated_at = updated_at + 1
       WHERE id IN (
         SELECT repair.foreshadow_id
           FROM grimodex_foreshadow_payoff_repairs repair
       );
      DROP TABLE grimodex_foreshadow_payoff_repairs;
      INSERT INTO foreshadow_payoffs (
        id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
        is_primary, attribution, ai_rationale, is_orphan, evidence_anchor_id,
        semantic_key, created_at, updated_at
      )
      SELECT
        'legacy-payoff:' || id, id, payoff_scene_id, payoff_from_pos,
        payoff_to_pos, 'unspecified', payoff_confirmed, 1, 'human', NULL, 0,
        NULL,
        id || '|' || payoff_scene_id || '|' || COALESCE(payoff_from_pos, '') || '|' || COALESCE(payoff_to_pos, ''),
        created_at, updated_at
        FROM foreshadows root
       WHERE payoff_scene_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM foreshadow_payoffs payoff
            WHERE payoff.foreshadow_id = root.id
              AND (
                payoff.is_primary = 1
                OR (
                  payoff.scene_id = root.payoff_scene_id
                  AND payoff.from_pos IS root.payoff_from_pos
                  AND payoff.to_pos IS root.payoff_to_pos
                )
              )
         );
      UPDATE foreshadow_payoffs
         SET semantic_key = foreshadow_id || '|' || scene_id || '|' || COALESCE(from_pos, '') || '|' || COALESCE(to_pos, '')
       WHERE semantic_key IS NULL OR semantic_key = '';
      UPDATE foreshadow_payoffs
         SET semantic_key = semantic_key || '#dup:' || id
       WHERE id IN (
         SELECT id FROM foreshadow_payoffs a
          WHERE EXISTS (
            SELECT 1 FROM foreshadow_payoffs b
             WHERE b.semantic_key = a.semantic_key AND b.rowid < a.rowid
          )
       );
      CREATE INDEX IF NOT EXISTS idx_plot_thread_links_semantic_key
        ON plot_thread_scene_links(semantic_key);
      CREATE INDEX IF NOT EXISTS idx_plot_thread_branches_semantic_key
        ON plot_thread_branches(semantic_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_thread_links_semantic_key
        ON plot_thread_scene_links(semantic_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_thread_branches_semantic_key
        ON plot_thread_branches(semantic_key);
      CREATE INDEX IF NOT EXISTS idx_fs_setup_semantic_key
        ON foreshadow_setups(semantic_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_setup_semantic_key
        ON foreshadow_setups(semantic_key);
      CREATE INDEX IF NOT EXISTS idx_fs_payoff_fid
        ON foreshadow_payoffs(foreshadow_id);
      CREATE INDEX IF NOT EXISTS idx_fs_payoff_scene
        ON foreshadow_payoffs(scene_id);
      CREATE INDEX IF NOT EXISTS idx_fs_payoff_semantic_key
        ON foreshadow_payoffs(semantic_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_payoff_semantic_key
        ON foreshadow_payoffs(semantic_key);
      CREATE INDEX IF NOT EXISTS idx_fs_payoff_link_setup
        ON foreshadow_setup_payoff_links(setup_id);
      CREATE INDEX IF NOT EXISTS idx_fs_payoff_link_payoff
        ON foreshadow_setup_payoff_links(payoff_id);
    `);
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the domain migration failure.
    }
    throw error;
  }

  for (const [table, column] of BROWSER_DOMAIN_MIGRATION_COLUMNS) {
    if (!browserTableColumns(db, table).includes(column)) {
      throw new Error(
        `browser domain schema migration did not add ${table}.${column}`,
      );
    }
  }
  for (const [
    table,
    name,
    unique,
    columns,
  ] of BROWSER_DOMAIN_MIGRATION_INDEXES) {
    if (!browserIndexMatches(db, table, name, unique, columns)) {
      throw new Error(`browser domain schema migration did not create ${name}`);
    }
  }
  return true;
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
  const semanticBindingsTableExists =
    db.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'codex_detail_semantic_bindings'",
    ).length > 0;
  if (semanticBindingsTableExists) {
    if (!browserSemanticBindingsSchemaIsValid(db)) {
      throw new Error(
        "Unsupported prerelease codex_detail_semantic_bindings schema; export with the originating build before upgrading",
      );
    }
  } else {
    const definitionOwnerIndex = (schemaContract as BrowserSchemaContract)
      .indexes.uq_codex_detail_defs_project_id;
    if (!definitionOwnerIndex) {
      throw new Error(
        "canonical browser schema is missing the Detail definition owner index",
      );
    }
    const definitionOwnerIndexExists =
      db.exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'uq_codex_detail_defs_project_id'",
      ).length > 0;
    if (
      definitionOwnerIndexExists &&
      !browserIndexMatches(
        db,
        "codex_detail_definitions",
        "uq_codex_detail_defs_project_id",
        true,
        ["project_id", "id"],
      )
    ) {
      throw new Error(
        "Unsupported prerelease Detail definition owner index; export with the originating build before upgrading",
      );
    }
    if (!definitionOwnerIndexExists) {
      db.run(`${definitionOwnerIndex.createSql};`);
    }
    db.run(
      buildBrowserTableDdl(
        schemaContract as BrowserSchemaContract,
        "codex_detail_semantic_bindings",
      ),
    );
    if (!browserSemanticBindingsSchemaIsValid(db)) {
      throw new Error("Detail semantic binding browser migration failed");
    }
    options.onDatabaseDirty?.();
  }
  if (migrateBrowserProjectCalendarVersion(db)) {
    options.onDatabaseDirty?.();
  }
  if (migrateBrowserAiAuditLedger(db)) {
    options.onDatabaseDirty?.();
  }
  if (migrateBrowserDomainSchema(db)) {
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
  // The browser mock does not load the Electron N-API backend. Keep the
  // typed editor-sticky surface usable in renderer tests with an ephemeral
  // in-memory command implementation; native persistence remains owned by
  // grimodex-db through the editor_sticky_* commands.
  interface BrowserEditorStickyRow {
    id: string;
    projectId: string;
    documentKey: string;
    body: string;
    paletteId: string;
    colorSlot: number;
    inlineOffset: number;
    blockOffset: number;
    zIndex: number;
    version: number;
    createdAt: string;
    updatedAt: string;
  }
  const editorStickyRows = new Map<string, BrowserEditorStickyRow>();
  const editorStickyRowKey = (projectId: string, stickyId: string) =>
    `${projectId}:${stickyId}`;
  const listBrowserEditorStickies = (args: Record<string, unknown>) => {
    const projectId = String(args.projectId ?? "");
    const documentKey = String(args.documentKey ?? "");
    return [...editorStickyRows.values()]
      .filter(
        (row) => row.projectId === projectId && row.documentKey === documentKey,
      )
      .sort(
        (left, right) =>
          left.zIndex - right.zIndex ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  };
  const createBrowserEditorSticky = (args: Record<string, unknown>) => {
    const payload = (args.payload ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const row: BrowserEditorStickyRow = {
      id: String(payload.id ?? crypto.randomUUID()),
      projectId: String(payload.projectId ?? ""),
      documentKey: String(payload.documentKey ?? ""),
      body: String(payload.body ?? '{"type":"doc","content":[]}'),
      paletteId: String(payload.paletteId ?? "post-it-playful"),
      colorSlot: Number(payload.colorSlot ?? 0),
      inlineOffset: Number(payload.inlineOffset ?? 0),
      blockOffset: Number(payload.blockOffset ?? 0),
      zIndex: Number(payload.zIndex ?? 0),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    editorStickyRows.set(editorStickyRowKey(row.projectId, row.id), row);
    return row;
  };
  const updateBrowserEditorSticky = (args: Record<string, unknown>) => {
    const payload = (args.payload ?? {}) as Record<string, unknown>;
    const projectId = String(payload.projectId ?? "");
    const stickyId = String(payload.stickyId ?? "");
    const baseVersion = Number(payload.baseVersion ?? -1);
    const row = editorStickyRows.get(editorStickyRowKey(projectId, stickyId));
    if (!row || row.version !== baseVersion) {
      throw new Error(`EDITOR_STICKY_CONFLICT:${stickyId}:${baseVersion}`);
    }
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    Object.assign(row, patch);
    row.version += 1;
    row.updatedAt = new Date().toISOString();
    return row;
  };
  const deleteBrowserEditorSticky = (args: Record<string, unknown>) => {
    const payload = (args.payload ?? {}) as Record<string, unknown>;
    const projectId = String(payload.projectId ?? "");
    const stickyId = String(payload.stickyId ?? "");
    const baseVersion = Number(payload.baseVersion ?? -1);
    const key = editorStickyRowKey(projectId, stickyId);
    const row = editorStickyRows.get(key);
    if (!row || row.version !== baseVersion) {
      throw new Error(`EDITOR_STICKY_CONFLICT:${stickyId}:${baseVersion}`);
    }
    editorStickyRows.delete(key);
    return null;
  };
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
  async function observeBrowserAiEffectiveRequest(
    receipt: BrowserAiEffectiveRequestReceipt,
  ): Promise<void> {
    const context = receipt.auditContext;
    if (!context) {
      throw new Error(
        "Browser AI effective request requires an auditContext correlation",
      );
    }
    const body = JSON.parse(receipt.bodyJson) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(
        "Browser AI effective request body must be a JSON object",
      );
    }
    await handleAiAuditAppendBatch({
      expectedWorkspacePath: context.expectedWorkspacePath,
      projectId: context.projectId,
      events: [
        {
          eventId: crypto.randomUUID(),
          executionId: context.executionId,
          operationId: context.operationId,
          parentExecutionId: context.parentExecutionId,
          pathId: context.pathId,
          eventType: "request.prepared",
          timestamp: Date.now(),
          payload: {
            captureState: "complete",
            credentialsExcluded: true,
            effectiveRequestReceipt: true,
            request: {
              provider: receipt.provider,
              model: receipt.model,
              body: body as Record<string, unknown>,
              auditMetadata: {
                source: "browser-final-request-builder",
                dispatchKind: receipt.kind,
                providerWireBodyAssemblyBoundary: "browser-ai",
                providerWireBodyReceiptObserved: true,
                credentialsExcluded: true,
                bodyObservation: {
                  representation: "parsed-json-value",
                  sourceBodyJsonEqualsFetchBody: true,
                  serializedBytesPreserved: false,
                  serializationWhitespacePreserved: false,
                  serializationKeyOrderPreserved: false,
                },
                routeObservation: {
                  captureState: "complete",
                  provider: receipt.provider,
                  model: receipt.model,
                  apiVariant: receipt.apiVariant,
                  endpointId: receipt.endpointId,
                  endpointOrigin: receipt.endpointOrigin,
                  transportEffectiveRouteObserved: true,
                  resolutionBoundary: "browser_final_body_json_value",
                },
              },
            },
          },
        },
      ],
    });
  }

  const aiTransport =
    options.aiTransport ??
    createBrowserAiTransport({
      onEffectiveRequest: observeBrowserAiEffectiveRequest,
    });
  const MAX_BROWSER_STREAM_TOMBSTONES = 256;
  const BROWSER_ABORT_QUIESCENCE_TIMEOUT_MS = 2_250;
  interface BrowserStreamLifecycle {
    readonly settled: Promise<void>;
    readonly resolveSettled: () => void;
    abortRequested: boolean;
    transportStarted: boolean;
    providerTerminalObserved: boolean;
  }
  const browserStreamLifecycles = new Map<string, BrowserStreamLifecycle>();
  const pendingBrowserStreamAbortIds = new Set<string>();
  const completedBrowserStreamReceipts = new Map<string, boolean>();

  const addBoundedBrowserStreamTombstone = (
    target: Set<string>,
    streamId: string,
  ): void => {
    target.delete(streamId);
    target.add(streamId);
    while (target.size > MAX_BROWSER_STREAM_TOMBSTONES) {
      const oldest = target.values().next().value as string | undefined;
      if (oldest === undefined) break;
      target.delete(oldest);
    }
  };
  const addCompletedBrowserStreamReceipt = (
    streamId: string,
    transportTerminationObserved: boolean,
  ): void => {
    completedBrowserStreamReceipts.delete(streamId);
    completedBrowserStreamReceipts.set(streamId, transportTerminationObserved);
    while (
      completedBrowserStreamReceipts.size > MAX_BROWSER_STREAM_TOMBSTONES
    ) {
      const oldest = completedBrowserStreamReceipts.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      completedBrowserStreamReceipts.delete(oldest);
    }
  };
  const waitForBrowserStreamSettled = async (
    promise: Promise<void>,
  ): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          BROWSER_ABORT_QUIESCENCE_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    return settled;
  };
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

  function requireBrowserAiAuditContext(
    args: Record<string, unknown>,
    command: string,
  ): BrowserAiAuditContext {
    const raw = args.auditContext;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `Browser AI command ${command} requires an auditContext object`,
      );
    }
    const context = raw as Record<string, unknown>;
    const allowedKeys = new Set([
      "expectedWorkspacePath",
      "projectId",
      "operationId",
      "executionId",
      "parentExecutionId",
      "pathId",
    ]);
    if (
      Object.keys(context).length !== allowedKeys.size ||
      Object.keys(context).some((key) => !allowedKeys.has(key))
    ) {
      throw new Error(
        `Browser AI command ${command} requires the exact auditContext fields`,
      );
    }
    for (const key of [
      "expectedWorkspacePath",
      "operationId",
      "executionId",
      "pathId",
    ] as const) {
      const value = context[key];
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value !== value.trim()
      ) {
        throw new Error(
          `Browser AI command ${command} requires auditContext.${key} to be a trimmed non-empty string`,
        );
      }
    }
    for (const key of ["projectId", "parentExecutionId"] as const) {
      if (!Object.prototype.hasOwnProperty.call(context, key)) {
        throw new Error(
          `Browser AI command ${command} requires auditContext.${key}`,
        );
      }
      const value = context[key];
      if (
        value !== null &&
        (typeof value !== "string" || !value.trim() || value !== value.trim())
      ) {
        throw new Error(
          `Browser AI command ${command} requires auditContext.${key} to be a trimmed non-empty string or null`,
        );
      }
    }
    return {
      expectedWorkspacePath: context.expectedWorkspacePath as string,
      projectId: context.projectId as string | null,
      operationId: context.operationId as string,
      executionId: context.executionId as string,
      parentExecutionId: context.parentExecutionId as string | null,
      pathId: context.pathId as string,
    };
  }

  function assertBrowserAiAuditDispatchPrecondition(
    context: BrowserAiAuditContext,
  ): void {
    assertBrowserAiAuditWorkspace({
      expectedWorkspacePath: context.expectedWorkspacePath,
    });
    const scopeId = browserAiAuditScopeId(context.projectId);
    const rows = queryAll(
      `SELECT operation_id, parent_execution_id, path_id, event_type
         FROM ai_audit_events
        WHERE scope_id = ? AND execution_id = ?
        ORDER BY sequence ASC`,
      [scopeId, context.executionId],
    );
    let started = false;
    let preparedBeforeDispatch = false;
    let dispatched = false;
    let terminal = false;
    for (const row of rows) {
      if (
        row.operation_id !== context.operationId ||
        row.parent_execution_id !== context.parentExecutionId ||
        row.path_id !== context.pathId
      ) {
        throw new Error(
          `AI_AUDIT_DISPATCH_PRECONDITION_FAILED: execution identity mismatch for ${context.executionId}`,
        );
      }
      const eventType = String(row.event_type);
      if (eventType === "execution.started") started = true;
      if (eventType === "request.prepared" && !dispatched) {
        preparedBeforeDispatch = true;
      }
      if (eventType === "request.dispatched") dispatched = true;
      if (
        eventType === "execution.succeeded" ||
        eventType === "execution.failed" ||
        eventType === "execution.cancelled" ||
        eventType === "execution.skipped" ||
        eventType === "execution.cache_hit"
      ) {
        terminal = true;
      }
    }
    if (!started || !preparedBeforeDispatch || !dispatched || terminal) {
      throw new Error(
        `AI_AUDIT_DISPATCH_PRECONDITION_FAILED: required durable lifecycle is missing, out of order, or terminal for ${context.executionId}`,
      );
    }
  }

  function requireBrowserAiStreamCorrelation(
    args: Record<string, unknown>,
    command: string,
  ): string {
    const rawStreamId = args.streamId;
    if (
      typeof rawStreamId !== "string" ||
      !rawStreamId ||
      rawStreamId !== rawStreamId.trim()
    ) {
      throw new Error("Browser AI streamId must be a trimmed non-empty string");
    }
    const context = requireBrowserAiAuditContext(args, command);
    if (context.executionId !== rawStreamId) {
      throw new Error(
        "Browser AI streamId must match auditContext.executionId",
      );
    }
    return rawStreamId;
  }

  function requireBrowserAiAbortStreamId(
    args: Record<string, unknown>,
  ): string {
    const streamId = args.streamId;
    if (
      typeof streamId !== "string" ||
      !streamId ||
      streamId !== streamId.trim()
    ) {
      throw new Error(
        "Browser AI abort streamId must be a trimmed non-empty string",
      );
    }
    return streamId;
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
    command: string,
  ): BrowserAiRequest {
    const auditContext = requireBrowserAiAuditContext(args, command);
    assertBrowserAiAuditDispatchPrecondition(auditContext);
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
      streamId: optionalString(args.streamId) ?? undefined,
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
      auditContext,
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
      "test_ai_connection",
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
      {
        auditContext: request.auditContext,
        onEffectiveRequest: observeBrowserAiEffectiveRequest,
      },
    );
  }

  async function handleSendChatMessage(
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<BrowserAiTransport["complete"]>>> {
    const request = resolveAiRequest(args, "chat", "send_chat_message");
    await authorizeResolvedRequest(request);
    return aiTransport.complete(request);
  }

  async function handleSendAgentMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const request = resolveAiRequest(args, "chat", "send_agent_message");
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
      {
        auditContext: request.auditContext,
        onEffectiveRequest: observeBrowserAiEffectiveRequest,
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
    const command =
      operation === "chat"
        ? "send_chat_message_stream"
        : "send_inline_ai_stream";
    const streamId = requireBrowserAiStreamCorrelation(args, command);
    if (browserStreamLifecycles.has(streamId)) {
      throw new Error(`Browser AI streamId is already active: ${streamId}`);
    }
    const request = resolveAiRequest(args, operation, command);
    completedBrowserStreamReceipts.delete(streamId);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const lifecycle: BrowserStreamLifecycle = {
      settled,
      resolveSettled,
      abortRequested: pendingBrowserStreamAbortIds.has(streamId),
      transportStarted: false,
      providerTerminalObserved: false,
    };
    browserStreamLifecycles.set(streamId, lifecycle);
    const channel = operation === "chat" ? "chat" : "inline-ai";
    let doneEmitted = false;
    const sink: BrowserAiStreamSink = {
      text(delta, blockType = "text") {
        if (!delta || doneEmitted) return;
        emitBrowserAiEvent(`${channel}:stream-chunk`, {
          streamId,
          delta,
          block_type: blockType,
        });
      },
      done(payload) {
        if (doneEmitted) return;
        doneEmitted = true;
        if (
          payload.stopReason !== "stopped" &&
          (!lifecycle.abortRequested ||
            payload.providerTerminalObservedBeforeAbort === true)
        ) {
          lifecycle.providerTerminalObserved = true;
        }
        emitBrowserAiEvent(`${channel}:stream-done`, {
          streamId,
          stop_reason:
            lifecycle.abortRequested && !lifecycle.providerTerminalObserved
              ? "stopped"
              : payload.stopReason,
          input_tokens: payload.inputTokens ?? null,
          output_tokens: payload.outputTokens ?? null,
        });
      },
    };

    try {
      await authorizeResolvedRequest(request);
      if (pendingBrowserStreamAbortIds.delete(streamId)) {
        lifecycle.abortRequested = true;
        sink.done({ stopReason: "stopped" });
        return;
      }
      if (aiTransport.stream) {
        lifecycle.transportStarted = true;
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
      if (doneEmitted) return;
      if (lifecycle.abortRequested) {
        if (!doneEmitted && !lifecycle.providerTerminalObserved) {
          sink.done({ stopReason: "stopped" });
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      emitBrowserAiEvent(`${channel}:stream-error`, { streamId, message });
      throw error;
    } finally {
      if (
        lifecycle.abortRequested &&
        !doneEmitted &&
        !lifecycle.providerTerminalObserved
      ) {
        sink.done({ stopReason: "stopped" });
      }
      if (browserStreamLifecycles.get(streamId) === lifecycle) {
        browserStreamLifecycles.delete(streamId);
      }
      pendingBrowserStreamAbortIds.delete(streamId);
      addCompletedBrowserStreamReceipt(streamId, true);
      lifecycle.resolveSettled();
    }
  }

  async function handleAbortAiStream(args: Record<string, unknown>): Promise<{
    abortCommandAcknowledged: true;
    transportTerminationObserved: boolean;
  }> {
    const streamId = requireBrowserAiAbortStreamId(args);
    const completed = completedBrowserStreamReceipts.get(streamId);
    if (completed !== undefined && !browserStreamLifecycles.has(streamId)) {
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: completed,
      };
    }
    addBoundedBrowserStreamTombstone(pendingBrowserStreamAbortIds, streamId);
    const lifecycle = browserStreamLifecycles.get(streamId);
    if (!lifecycle) {
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved: false,
      };
    }
    lifecycle.abortRequested = true;
    if (lifecycle.transportStarted && aiTransport.abort) {
      try {
        await aiTransport.abort(streamId);
      } catch {
        // The outer BrowserMock lifecycle remains the receipt authority. Do
        // not let a transport diagnostic (which may contain credentials)
        // prevent the renderer from recording its terminal audit event.
      }
    }
    const lifecycleSettled = await waitForBrowserStreamSettled(
      lifecycle.settled,
    );
    return {
      abortCommandAcknowledged: true,
      transportTerminationObserved: lifecycleSettled,
    };
  }

  function handleDbExecute(args: Record<string, unknown>): {
    rows: Record<string, unknown>[];
  } {
    const sql = args.sql as string;
    const params = args.params as SqlValue[];
    assertRendererDoesNotMutateAiAudit(sql);
    const result = executeBrowserDbStatement(db, sql, params);

    if (methodAssumesMutation(args.method) || result.mutated) {
      options.onDatabaseDirty?.();
    }

    return { rows: result.rows };
  }

  function nativeCodexPayload(args: Record<string, unknown>) {
    return (args.payload ?? {}) as Record<string, unknown>;
  }

  function nativeNullable(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    return String(value);
  }

  const BROWSER_CODEX_SUMMARY_LANE_MODEL = "__lane_summary__";
  const BROWSER_CODEX_CONTENT_LANE_MODEL = "__lane_content__";

  interface BrowserCodexAuthorshipSpanSnapshot {
    fromPos: number;
    toPos: number;
    source: string;
    model: string | null;
    chatMsgId: string | null;
    traceId: string | null;
  }

  interface BrowserCodexEntrySnapshot {
    id: string;
    projectId: string;
    type: string;
    name: string;
    aliases: string | null;
    excludedAliases: string | null;
    readings: string | null;
    tagsCache: string | null;
    summary: string | null;
    content: string;
    parentId: string | null;
    icon: string | null;
    contextMode: string;
    childrenBudget: string;
    sourceChatMessageId: string | null;
    notes: string | null;
    createdAt: string;
    version: number;
    authorshipSpans: BrowserCodexAuthorshipSpanSnapshot[];
  }

  interface BrowserCodexWriteResult extends Record<string, unknown> {
    entityId: string;
    version: number;
    changeEventUid: string;
    undoJournalId: string;
  }

  const BROWSER_CODEX_CREATE_IDEMPOTENCY_DOMAIN = "agent_codex_create";
  const BROWSER_CODEX_CREATE_IDEMPOTENCY_CONFLICT =
    "AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT";

  function browserCodexCreateConflict(detail: string): never {
    throw new Error(`${BROWSER_CODEX_CREATE_IDEMPOTENCY_CONFLICT}: ${detail}`);
  }

  function normalizeBrowserCodexContentForIdempotency(raw: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }

    const stripVolatileAuthorshipTimestamp = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(stripVolatileAuthorshipTimestamp);
        return;
      }
      if (!isRecord(value)) return;
      if (value.type === "authorship" && isRecord(value.attrs)) {
        delete value.attrs.timestamp;
      }
      Object.values(value).forEach(stripVolatileAuthorshipTimestamp);
    };
    stripVolatileAuthorshipTimestamp(parsed);
    return JSON.stringify(canonicalizeAiAuditJson(parsed));
  }

  function browserCodexCreateFingerprintPayload(
    payload: Record<string, unknown>,
    authorshipSpans: BrowserCodexAuthorshipSpanSnapshot[],
  ): Record<string, unknown> {
    const optionalString = (value: unknown): string | null =>
      value == null ? null : String(value);
    return {
      requestId: null,
      entryId: null,
      projectId: String(payload.projectId),
      sessionId: "",
      surface: optionalString(payload.surface),
      typeSlug: String(payload.typeSlug),
      name: String(payload.name),
      summary: payload.summary == null ? "" : String(payload.summary),
      content: normalizeBrowserCodexContentForIdempotency(
        payload.content == null ? "{}" : String(payload.content),
      ),
      aliases: optionalString(payload.aliases),
      excludedAliases: optionalString(payload.excludedAliases),
      readings: optionalString(payload.readings),
      tagsCache: optionalString(payload.tagsCache),
      parentId: optionalString(payload.parentId),
      sourceChatMessageId: optionalString(payload.sourceChatMessageId),
      model: optionalString(payload.model),
      chatMessageId: optionalString(payload.chatMessageId),
      traceId: optionalString(payload.traceId),
      authorshipSpans,
    };
  }

  function parseBrowserCodexCreateResult(
    raw: SqlValue,
  ): BrowserCodexWriteResult {
    try {
      if (typeof raw !== "string") {
        browserCodexCreateConflict("original result is missing");
      }
      const result = JSON.parse(raw) as Partial<BrowserCodexWriteResult>;
      if (
        typeof result.entityId !== "string" ||
        !Number.isSafeInteger(result.version) ||
        typeof result.changeEventUid !== "string" ||
        typeof result.undoJournalId !== "string"
      ) {
        browserCodexCreateConflict("original result is incomplete");
      }
      return result as BrowserCodexWriteResult;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(BROWSER_CODEX_CREATE_IDEMPOTENCY_CONFLICT)
      ) {
        throw error;
      }
      return browserCodexCreateConflict("original result is invalid");
    }
  }

  function browserCodexNullableString(value: SqlValue): string | null {
    return value == null ? null : String(value);
  }

  function browserCodexOptionalPayloadString(
    value: unknown,
    label: string,
  ): string | null {
    if (value == null) return null;
    if (typeof value !== "string") {
      throw new Error(`${label} must be a string or null`);
    }
    return value;
  }

  function browserCodexRequiredPayloadString(
    payload: Record<string, unknown>,
    key: string,
  ): string {
    const value = payload[key];
    if (typeof value !== "string") {
      throw new Error(`${key} must be a string`);
    }
    return value;
  }

  function browserCodexRequiredNonEmptyPayloadString(
    payload: Record<string, unknown>,
    key: string,
  ): string {
    const value = payload[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }

  function browserCodexRequiredPayloadInteger(
    payload: Record<string, unknown>,
    key: string,
  ): number {
    const value = payload[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    return value;
  }

  function browserCodexOptionalPayloadNumber(
    payload: Record<string, unknown>,
    key: string,
  ): number | null {
    const value = payload[key];
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${key} must be a number or null`);
    }
    return value;
  }

  function browserCodexOptionalPayloadBoolInt(
    payload: Record<string, unknown>,
    key: string,
  ): number | null {
    const value = payload[key];
    if (value == null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === 0 || value === 1) return value;
    throw new Error(`${key} must be a boolean or 0/1`);
  }

  function loadBrowserCodexAuthorshipSpans(
    entryId: string,
  ): BrowserCodexAuthorshipSpanSnapshot[] {
    return queryAll(
      `SELECT from_pos, to_pos, source, model, chat_msg_id, trace_id
         FROM authorship_spans
        WHERE codex_entry_id = ?
        ORDER BY from_pos, to_pos, source, coalesce(model, ''),
                 coalesce(chat_msg_id, ''), coalesce(trace_id, ''), id`,
      [entryId],
    ).map((row) => ({
      fromPos: Number(row.from_pos),
      toPos: Number(row.to_pos),
      source: String(row.source),
      model: browserCodexNullableString(row.model),
      chatMsgId: browserCodexNullableString(row.chat_msg_id),
      traceId: browserCodexNullableString(row.trace_id),
    }));
  }

  function parseBrowserCodexAuthorshipSpans(
    raw: unknown,
    context: string,
  ): BrowserCodexAuthorshipSpanSnapshot[] {
    if (!Array.isArray(raw)) {
      throw new Error(`${context} authorshipSpans must be an array`);
    }
    const forbiddenOwnerKeys = [
      "id",
      "projectId",
      "nodeId",
      "codexEntryId",
      "codex_entry_id",
      "snippetId",
      "detailValueId",
      "phaseId",
      "stickyId",
    ];
    return raw.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(`${context} authorship span ${index} is invalid`);
      }
      if (forbiddenOwnerKeys.some((key) => Object.hasOwn(item, key))) {
        throw new Error(
          `${context} authorship span ${index} must not declare an owner`,
        );
      }
      const fromPos = item.fromPos;
      const toPos = item.toPos;
      const source = item.source;
      if (
        !Number.isSafeInteger(fromPos) ||
        !Number.isSafeInteger(toPos) ||
        (source !== "human" && source !== "ai" && source !== "unknown")
      ) {
        throw new Error(`${context} authorship span ${index} is invalid`);
      }
      const optionalString = (key: string): string | null => {
        const value = item[key];
        if (value == null) return null;
        if (typeof value !== "string") {
          throw new Error(
            `${context} authorship span ${index}.${key} must be a string or null`,
          );
        }
        return value;
      };
      return {
        fromPos: Number(fromPos),
        toPos: Number(toPos),
        source,
        model: optionalString("model"),
        chatMsgId: optionalString("chatMsgId"),
        traceId: optionalString("traceId"),
      };
    });
  }

  function parseBrowserCodexAuthorshipSpanLanes(
    raw: unknown,
  ): Array<string | null> | null {
    if (raw == null) return null;
    if (!Array.isArray(raw)) {
      throw new Error("authorshipSpanLanes must be an array or null");
    }
    return raw.map((lane, index) => {
      if (lane == null) return null;
      if (typeof lane !== "string") {
        throw new Error(
          `authorshipSpanLanes[${index}] must be a string or null`,
        );
      }
      return lane;
    });
  }

  function mergeBrowserCodexAuthorshipSpans(input: {
    entryId: string;
    spans: BrowserCodexAuthorshipSpanSnapshot[];
    lanes: Array<string | null> | null;
    updateSummary: boolean;
    updateContent: boolean;
    model: string | null;
    chatMsgId: string | null;
    traceId: string | null;
    now: string;
  }): void {
    if (input.updateSummary && input.updateContent) {
      db.run("DELETE FROM authorship_spans WHERE codex_entry_id = ?", [
        input.entryId,
      ]);
    } else if (input.updateSummary) {
      db.run(
        "DELETE FROM authorship_spans WHERE codex_entry_id = ? AND model = ?",
        [input.entryId, BROWSER_CODEX_SUMMARY_LANE_MODEL],
      );
    } else if (input.updateContent) {
      db.run(
        "DELETE FROM authorship_spans WHERE codex_entry_id = ? AND model = ?",
        [input.entryId, BROWSER_CODEX_CONTENT_LANE_MODEL],
      );
    }
    input.spans.forEach((span, index) => {
      const lane = input.lanes?.[index] ?? null;
      const model =
        lane === "summary"
          ? BROWSER_CODEX_SUMMARY_LANE_MODEL
          : lane === "content"
            ? BROWSER_CODEX_CONTENT_LANE_MODEL
            : (span.model ?? input.model);
      db.run(
        `INSERT INTO authorship_spans
          (id, codex_entry_id, from_pos, to_pos, source, model,
           chat_msg_id, trace_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          input.entryId,
          span.fromPos,
          span.toPos,
          span.source,
          model,
          span.chatMsgId ?? input.chatMsgId,
          span.traceId ?? input.traceId,
          input.now,
        ],
      );
      if (db.getRowsModified() !== 1) {
        throw new Error(
          `authorship span ${index} for codex entry '${input.entryId}' was not persisted`,
        );
      }
    });
  }

  function restoreBrowserCodexAuthorshipSpans(
    entryId: string,
    spans: BrowserCodexAuthorshipSpanSnapshot[],
    now: string,
  ): void {
    db.run("DELETE FROM authorship_spans WHERE codex_entry_id = ?", [entryId]);
    mergeBrowserCodexAuthorshipSpans({
      entryId,
      spans,
      lanes: null,
      updateSummary: false,
      updateContent: false,
      model: null,
      chatMsgId: null,
      traceId: null,
      now,
    });
  }

  function loadBrowserCodexEntrySnapshot(
    entryId: string,
    projectId: string,
  ): BrowserCodexEntrySnapshot | null {
    const row = queryOne(
      `SELECT id, project_id, type, name, aliases, excluded_aliases, readings,
              tags_cache, summary, content, parent_id, icon, context_mode,
              children_budget, source_chat_message_id, notes, created_at, version
         FROM codex_entries
        WHERE id = ? AND project_id = ?`,
      [entryId, projectId],
    );
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      type: String(row.type),
      name: String(row.name),
      aliases: browserCodexNullableString(row.aliases),
      excludedAliases: browserCodexNullableString(row.excluded_aliases),
      readings: browserCodexNullableString(row.readings),
      tagsCache: browserCodexNullableString(row.tags_cache),
      summary: browserCodexNullableString(row.summary),
      content: String(row.content),
      parentId: browserCodexNullableString(row.parent_id),
      icon: browserCodexNullableString(row.icon),
      contextMode: String(row.context_mode),
      childrenBudget: String(row.children_budget),
      sourceChatMessageId: browserCodexNullableString(
        row.source_chat_message_id,
      ),
      notes: browserCodexNullableString(row.notes),
      createdAt: String(row.created_at),
      version: Number(row.version),
      authorshipSpans: loadBrowserCodexAuthorshipSpans(entryId),
    };
  }

  function parseBrowserCodexEntrySnapshot(
    raw: SqlValue,
    journalId: string,
  ): BrowserCodexEntrySnapshot {
    if (typeof raw !== "string") {
      throw new Error(
        `codex undo journal '${journalId}' is missing a snapshot`,
      );
    }
    const parsed = JSON.parse(raw) as Partial<BrowserCodexEntrySnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.content !== "string" ||
      typeof parsed.contextMode !== "string" ||
      typeof parsed.childrenBudget !== "string" ||
      typeof parsed.createdAt !== "string" ||
      !Number.isSafeInteger(parsed.version) ||
      !Array.isArray(parsed.authorshipSpans)
    ) {
      throw new Error(
        `codex undo journal '${journalId}' has an invalid snapshot`,
      );
    }
    parsed.authorshipSpans = parseBrowserCodexAuthorshipSpans(
      parsed.authorshipSpans,
      `codex undo journal '${journalId}' snapshot`,
    );
    return parsed as BrowserCodexEntrySnapshot;
  }

  function assertBrowserCodexSnapshotIdentity(
    snapshot: BrowserCodexEntrySnapshot,
    projectId: string,
    entryId: string,
    journalId: string,
  ): void {
    if (snapshot.projectId !== projectId || snapshot.id !== entryId) {
      throw new Error(`codex undo journal '${journalId}' identity mismatch`);
    }
  }

  function assertBrowserCodexEntryReferences(
    projectId: string,
    entryId: string,
    typeSlug: string,
    parentId: string | null,
  ): void {
    if (
      !queryOne(
        "SELECT 1 AS owned FROM codex_types WHERE project_id = ? AND slug = ?",
        [projectId, typeSlug],
      )
    ) {
      throw new Error(
        `codex type '${typeSlug}' is not in project '${projectId}'`,
      );
    }
    if (parentId === null) return;
    if (parentId === entryId) {
      throw new Error(`codex entry '${entryId}' cannot be its own parent`);
    }
    if (
      !queryOne(
        "SELECT 1 AS owned FROM codex_entries WHERE id = ? AND project_id = ?",
        [parentId, projectId],
      )
    ) {
      throw new Error(
        `codex parent '${parentId}' is not in project '${projectId}'`,
      );
    }
  }

  function insertBrowserCodexEntrySnapshot(
    snapshot: BrowserCodexEntrySnapshot,
    targetVersion: number,
    now: string,
  ): void {
    assertBrowserCodexEntryReferences(
      snapshot.projectId,
      snapshot.id,
      snapshot.type,
      snapshot.parentId,
    );
    db.run(
      `INSERT INTO codex_entries
        (id, project_id, type, name, aliases, excluded_aliases, readings,
         tags_cache, summary, content, parent_id, icon, context_mode,
         children_budget, source_chat_message_id, notes, version,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.projectId,
        snapshot.type,
        snapshot.name,
        snapshot.aliases,
        snapshot.excludedAliases,
        snapshot.readings,
        snapshot.tagsCache,
        snapshot.summary,
        snapshot.content,
        snapshot.parentId,
        snapshot.icon,
        snapshot.contextMode,
        snapshot.childrenBudget,
        snapshot.sourceChatMessageId,
        snapshot.notes,
        targetVersion,
        snapshot.createdAt,
        now,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(`codex entry '${snapshot.id}' was not restored`);
    }
    restoreBrowserCodexAuthorshipSpans(
      snapshot.id,
      snapshot.authorshipSpans,
      now,
    );
  }

  function restoreBrowserCodexEntrySnapshot(
    snapshot: BrowserCodexEntrySnapshot,
    expectedVersion: number,
    targetVersion: number,
    now: string,
  ): void {
    assertBrowserCodexEntryReferences(
      snapshot.projectId,
      snapshot.id,
      snapshot.type,
      snapshot.parentId,
    );
    db.run(
      `UPDATE codex_entries
          SET type = ?, name = ?, aliases = ?, excluded_aliases = ?,
              readings = ?, tags_cache = ?, summary = ?, content = ?,
              parent_id = ?, icon = ?, context_mode = ?, children_budget = ?,
              source_chat_message_id = ?, notes = ?, version = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND version = ?`,
      [
        snapshot.type,
        snapshot.name,
        snapshot.aliases,
        snapshot.excludedAliases,
        snapshot.readings,
        snapshot.tagsCache,
        snapshot.summary,
        snapshot.content,
        snapshot.parentId,
        snapshot.icon,
        snapshot.contextMode,
        snapshot.childrenBudget,
        snapshot.sourceChatMessageId,
        snapshot.notes,
        targetVersion,
        now,
        snapshot.id,
        snapshot.projectId,
        expectedVersion,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `codex entry '${snapshot.id}' version conflict during undo replay`,
      );
    }
    restoreBrowserCodexAuthorshipSpans(
      snapshot.id,
      snapshot.authorshipSpans,
      now,
    );
  }

  function rewriteBrowserCodexJournalStateToken(
    projectId: string,
    entryId: string,
    previousVersion: number,
    replayVersion: number,
  ): void {
    db.run(
      `UPDATE undo_journal
          SET base_version = CASE
                WHEN base_version = ? THEN ? ELSE base_version END,
              result_version = CASE
                WHEN result_version = ? THEN ? ELSE result_version END
        WHERE project_id = ? AND entity_kind = 'codex_entry' AND entity_id = ?
          AND (base_version = ? OR result_version = ?)`,
      [
        previousVersion,
        replayVersion,
        previousVersion,
        replayVersion,
        projectId,
        entryId,
        previousVersion,
        previousVersion,
      ],
    );
    if (db.getRowsModified() === 0) {
      throw new Error(
        `codex undo journal chain for '${entryId}' lost state version ${previousVersion}`,
      );
    }
  }

  function insertBrowserCodexUndoJournal(input: {
    id: string;
    projectId: string;
    surface: string;
    entryId: string;
    opKind: "create" | "update" | "delete";
    before: BrowserCodexEntrySnapshot | null;
    after: BrowserCodexEntrySnapshot | null;
    baseVersion: number;
    resultVersion: number;
    changeEventUid: string;
    now: string;
  }): void {
    db.run(
      `INSERT INTO undo_journal
        (id, project_id, surface, entity_kind, entity_id, op_kind,
         before_json, after_json, base_version, result_version,
         change_event_uid, created_at)
       VALUES (?, ?, ?, 'codex_entry', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.projectId,
        input.surface,
        input.entryId,
        input.opKind,
        input.before === null ? null : JSON.stringify(input.before),
        input.after === null ? null : JSON.stringify(input.after),
        input.baseVersion,
        input.resultVersion,
        input.changeEventUid,
        input.now,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(`codex undo journal '${input.id}' was not persisted`);
    }
  }

  function loadBrowserCodexCreateReplayResult(input: {
    requestId: string;
    projectId: string;
    requestHash: string;
  }): BrowserCodexWriteResult | null {
    const ledger = queryOne(
      `SELECT project_id, payload_hash, tombstone_json
         FROM idempotency_requests
        WHERE domain = ? AND request_id = ?`,
      [BROWSER_CODEX_CREATE_IDEMPOTENCY_DOMAIN, input.requestId],
    );
    if (!ledger) return null;
    if (
      String(ledger.project_id) !== input.projectId ||
      String(ledger.payload_hash) !== input.requestHash
    ) {
      return browserCodexCreateConflict(
        "request id reused with different payload or project",
      );
    }

    const result = parseBrowserCodexCreateResult(ledger.tombstone_json);
    if (result.undoJournalId !== input.requestId) {
      return browserCodexCreateConflict("original result identity is invalid");
    }
    const journal = queryOne(
      `SELECT journal.entity_id, journal.op_kind, journal.before_json,
              journal.after_json, journal.base_version,
              journal.result_version, journal.change_event_uid,
              event.event_uid AS persisted_event_uid,
              event.entity_type AS event_entity_type,
              event.entity_id AS event_entity_id,
              event.op_type AS event_op_type,
              event.payload AS event_payload
         FROM undo_journal journal
         LEFT JOIN change_events event
           ON event.project_id = journal.project_id
          AND event.event_uid = journal.change_event_uid
        WHERE journal.id = ? AND journal.project_id = ?
          AND journal.entity_kind = 'codex_entry'`,
      [result.undoJournalId, input.projectId],
    );
    if (
      !journal ||
      String(journal.entity_id) !== result.entityId ||
      journal.op_kind !== "create" ||
      journal.before_json !== null ||
      Number(journal.base_version) !== 0 ||
      !Number.isSafeInteger(Number(journal.result_version)) ||
      journal.change_event_uid !== result.changeEventUid ||
      journal.persisted_event_uid !== result.changeEventUid ||
      journal.event_entity_type !== "codex_entry" ||
      journal.event_entity_id !== result.entityId ||
      journal.event_op_type !== "entry.create"
    ) {
      return browserCodexCreateConflict("original result is missing");
    }

    try {
      const eventPayload = JSON.parse(String(journal.event_payload)) as unknown;
      if (
        !isRecord(eventPayload) ||
        eventPayload.requestHash !== input.requestHash
      ) {
        return browserCodexCreateConflict(
          "original change event does not match the request",
        );
      }
      const after = parseBrowserCodexEntrySnapshot(
        journal.after_json,
        result.undoJournalId,
      );
      assertBrowserCodexSnapshotIdentity(
        after,
        input.projectId,
        result.entityId,
        result.undoJournalId,
      );
      if (after.version !== result.version) {
        return browserCodexCreateConflict(
          "original snapshot does not match the persisted result",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(BROWSER_CODEX_CREATE_IDEMPOTENCY_CONFLICT)
      ) {
        throw error;
      }
      return browserCodexCreateConflict(
        "committed post-state or change event is invalid",
      );
    }
    return {
      entityId: result.entityId,
      version: Number(journal.result_version),
      changeEventUid: result.changeEventUid,
      undoJournalId: result.undoJournalId,
    };
  }

  interface BrowserPhaseDetailOverrideSnapshot {
    definitionId: string;
    value: string | null;
  }

  interface BrowserPhaseAggregateSnapshot {
    id: string;
    entryId: string;
    anchorNodeId: string | null;
    label: string;
    summaryOverride: string | null;
    contentOverride: string | null;
    contextModeOverride: string | null;
    version: number;
    detailOverrides: BrowserPhaseDetailOverrideSnapshot[];
  }

  function loadBrowserPhaseAggregateSnapshot(
    phaseId: string,
    projectId: string,
  ): BrowserPhaseAggregateSnapshot | null {
    const phase = queryOne(
      `SELECT phase.id, phase.entry_id, phase.anchor_node_id, phase.label,
              phase.summary_override, phase.content_override,
              phase.context_mode_override, phase.version
         FROM codex_entry_phases phase
         JOIN codex_entries entry ON entry.id = phase.entry_id
        WHERE phase.id = ? AND entry.project_id = ?`,
      [phaseId, projectId],
    );
    if (!phase) return null;
    const detailOverrides = queryAll(
      `SELECT definition_id, value
         FROM codex_phase_detail_overrides
        WHERE phase_id = ?
        ORDER BY definition_id`,
      [phaseId],
    ).map((row) => ({
      definitionId: String(row.definition_id),
      value: row.value == null ? null : String(row.value),
    }));
    return {
      id: String(phase.id),
      entryId: String(phase.entry_id),
      anchorNodeId:
        phase.anchor_node_id == null ? null : String(phase.anchor_node_id),
      label: String(phase.label),
      summaryOverride:
        phase.summary_override == null ? null : String(phase.summary_override),
      contentOverride:
        phase.content_override == null ? null : String(phase.content_override),
      contextModeOverride:
        phase.context_mode_override == null
          ? null
          : String(phase.context_mode_override),
      version: Number(phase.version),
      detailOverrides,
    };
  }

  function replaceBrowserPhaseOverrides(
    phaseId: string,
    projectId: string,
    rawOverrides: unknown,
  ): void {
    if (!Array.isArray(rawOverrides)) {
      throw new Error("phase detailOverrides must be an array");
    }
    db.run("DELETE FROM codex_phase_detail_overrides WHERE phase_id = ?", [
      phaseId,
    ]);
    for (const rawOverride of rawOverrides) {
      if (
        rawOverride === null ||
        typeof rawOverride !== "object" ||
        Array.isArray(rawOverride)
      ) {
        throw new Error("phase detail override must be an object");
      }
      const override = rawOverride as Record<string, unknown>;
      const definitionId = String(override.definitionId ?? "");
      const definition = queryOne(
        `SELECT 1 AS owned
           FROM codex_detail_definitions
          WHERE id = ? AND project_id = ?`,
        [definitionId, projectId],
      );
      if (!definition) {
        throw new Error(
          `phase detail definition '${definitionId}' is not in project '${projectId}'`,
        );
      }
      db.run(
        `INSERT INTO codex_phase_detail_overrides
          (phase_id, definition_id, value) VALUES (?, ?, ?)`,
        [phaseId, definitionId, nativeNullable(override.value) ?? null],
      );
    }
  }

  async function handleBrowserPhasePatch(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const phaseId = String(p.phaseId);
    const projectId = String(p.projectId);
    const sessionId = String(p.sessionId);
    const surface = String(p.surface ?? "manual");
    const baseVersion = Number(p.baseVersion);
    const eventUid = crypto.randomUUID();
    const undoJournalId = crypto.randomUUID();
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();

    return withAppendLedgerLock(async () => {
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "codex",
        opType: "phase.update",
        entityType: "phase",
        entityId: phaseId,
        payload: JSON.stringify({ surface, operation: "phase.update" }),
        sessionId,
        timestamp,
      });

      db.run("BEGIN IMMEDIATE");
      try {
        const before = loadBrowserPhaseAggregateSnapshot(phaseId, projectId);
        if (!before) {
          throw new Error(
            `phase '${phaseId}' is not in project '${projectId}'`,
          );
        }
        if (before.version !== baseVersion) {
          throw new Error("phase version conflict");
        }
        if (Object.hasOwn(p, "anchorNodeId") && p.anchorNodeId != null) {
          if (typeof p.anchorNodeId !== "string") {
            throw new Error("phase anchorNodeId must be a string or null");
          }
          if (
            !queryOne(
              `SELECT 1 AS owned FROM tree_nodes
                WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
              [p.anchorNodeId, projectId],
            )
          ) {
            throw new Error(
              `phase anchor '${p.anchorNodeId}' is not a scene in project '${projectId}'`,
            );
          }
        }

        const values: SqlValue[] = [];
        const sets: string[] = [];
        const phaseColumns: Record<string, string> = {
          label: "label",
          anchorNodeId: "anchor_node_id",
          summaryOverride: "summary_override",
          contentOverride: "content_override",
          contextModeOverride: "context_mode_override",
        };
        for (const [key, column] of Object.entries(phaseColumns)) {
          if (!(key in p)) continue;
          sets.push(`${column} = ?`);
          values.push(
            key === "label"
              ? String(p[key] ?? "")
              : (nativeNullable(p[key]) ?? null),
          );
        }
        sets.push("version = version + 1", "updated_at = ?");
        values.push(now, phaseId, baseVersion, projectId);
        db.run(
          `UPDATE codex_entry_phases
              SET ${sets.join(", ")}
            WHERE id = ? AND version = ?
              AND EXISTS (
                SELECT 1
                  FROM codex_entries entry
                 WHERE entry.id = codex_entry_phases.entry_id
                   AND entry.project_id = ?
              )`,
          values,
        );
        if (db.getRowsModified() !== 1) {
          throw new Error("phase version conflict");
        }

        if (Object.hasOwn(p, "detailOverrides")) {
          replaceBrowserPhaseOverrides(phaseId, projectId, p.detailOverrides);
        }

        const after = loadBrowserPhaseAggregateSnapshot(phaseId, projectId);
        if (!after || after.version !== baseVersion + 1) {
          throw new Error("phase version conflict");
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind,
             before_json, after_json, base_version, result_version,
             change_event_uid, created_at)
           VALUES (?, ?, ?, 'codex_phase', ?, 'update', ?, ?, ?, ?, ?, ?)`,
          [
            undoJournalId,
            projectId,
            surface,
            phaseId,
            JSON.stringify(before),
            JSON.stringify(after),
            before.version,
            after.version,
            eventUid,
            now,
          ],
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: phaseId,
          version: after.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original phase mutation failure.
        }
        throw error;
      }
    });
  }

  function parseBrowserPhaseAggregateSnapshot(
    raw: SqlValue,
    journalId: string,
  ): BrowserPhaseAggregateSnapshot {
    if (typeof raw !== "string") {
      throw new Error(
        `phase undo journal '${journalId}' is missing a snapshot`,
      );
    }
    const parsed = JSON.parse(raw) as Partial<BrowserPhaseAggregateSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.entryId !== "string" ||
      typeof parsed.label !== "string" ||
      typeof parsed.version !== "number" ||
      !Array.isArray(parsed.detailOverrides)
    ) {
      throw new Error(
        `phase undo journal '${journalId}' has an invalid snapshot`,
      );
    }
    return parsed as BrowserPhaseAggregateSnapshot;
  }

  function restoreBrowserPhaseAggregateSnapshot(
    projectId: string,
    snapshot: BrowserPhaseAggregateSnapshot,
    expectedVersion: number,
    targetVersion: number,
    now: string,
  ): void {
    if (
      snapshot.anchorNodeId !== null &&
      !queryOne(
        `SELECT 1 AS owned FROM tree_nodes
          WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
        [snapshot.anchorNodeId, projectId],
      )
    ) {
      throw new Error(
        `phase anchor '${snapshot.anchorNodeId}' is not a scene in project '${projectId}'`,
      );
    }
    db.run(
      `UPDATE codex_entry_phases
          SET label = ?, anchor_node_id = ?, summary_override = ?,
              content_override = ?, context_mode_override = ?,
              version = ?, updated_at = ?
        WHERE id = ? AND entry_id = ? AND version = ?
          AND EXISTS (
            SELECT 1
              FROM codex_entries entry
             WHERE entry.id = codex_entry_phases.entry_id
               AND entry.project_id = ?
          )`,
      [
        snapshot.label,
        snapshot.anchorNodeId,
        snapshot.summaryOverride,
        snapshot.contentOverride,
        snapshot.contextModeOverride,
        targetVersion,
        now,
        snapshot.id,
        snapshot.entryId,
        expectedVersion,
        projectId,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `phase '${snapshot.id}' version conflict during undo replay`,
      );
    }
    replaceBrowserPhaseOverrides(
      snapshot.id,
      projectId,
      snapshot.detailOverrides,
    );
    const restored = loadBrowserPhaseAggregateSnapshot(snapshot.id, projectId);
    if (!restored || restored.version !== targetVersion) {
      throw new Error(
        `phase '${snapshot.id}' could not be read after undo replay`,
      );
    }
  }

  function rewriteBrowserPhaseJournalStateToken(
    projectId: string,
    phaseId: string,
    previousVersion: number,
    replayVersion: number,
  ): void {
    db.run(
      `UPDATE undo_journal
          SET base_version = CASE
                WHEN base_version = ? THEN ? ELSE base_version END,
              result_version = CASE
                WHEN result_version = ? THEN ? ELSE result_version END
        WHERE project_id = ? AND entity_kind = 'codex_phase' AND entity_id = ?
          AND (base_version = ? OR result_version = ?)`,
      [
        previousVersion,
        replayVersion,
        previousVersion,
        replayVersion,
        projectId,
        phaseId,
        previousVersion,
        previousVersion,
      ],
    );
    if (db.getRowsModified() === 0) {
      throw new Error(
        `phase undo journal chain for '${phaseId}' lost state version ${previousVersion}`,
      );
    }
  }

  async function handleBrowserApplyUndoJournal(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const p = (args.payload ?? {}) as Record<string, unknown>;
    const requestId = String(p.requestId);
    const projectId = String(p.projectId);
    const sessionId = String(p.sessionId);
    const journalId = String(p.journalId);
    const direction = String(p.direction);
    if (direction !== "undo" && direction !== "redo") {
      throw new Error(`invalid undo direction: ${direction}`);
    }

    return withAppendLedgerLock(async () => {
      const payloadHash = await browserPayloadFingerprint(
        "agent_apply_undo_journal",
        { projectId, journalId, direction },
      );
      const journal = queryOne(
        `SELECT id, entity_kind, entity_id, op_kind, before_json, after_json,
                base_version, result_version
           FROM undo_journal
          WHERE id = ? AND project_id = ?`,
        [journalId, projectId],
      );
      if (!journal) {
        throw new Error(`undo journal '${journalId}' not found`);
      }
      if (
        journal.entity_kind !== "codex_entry" &&
        journal.entity_kind !== "codex_phase" &&
        journal.entity_kind !== "foreshadow" &&
        journal.entity_kind !== "event"
      ) {
        throw new Error(
          `browser undo does not support entity kind '${String(journal.entity_kind)}'`,
        );
      }
      const isCodexEntry = journal.entity_kind === "codex_entry";
      const isPhase = journal.entity_kind === "codex_phase";
      const isSceneEventBatch = journal.entity_kind === "event";
      const sceneEventSnapshot = isSceneEventBatch
        ? parseBrowserSceneEventLinkBatchSnapshot(
            direction === "undo" ? journal.before_json : journal.after_json,
            journalId,
          )
        : null;
      const opType = isCodexEntry
        ? journal.op_kind === "create"
          ? direction === "undo"
            ? "entry.delete"
            : "entry.create"
          : journal.op_kind === "delete"
            ? direction === "undo"
              ? "entry.create"
              : "entry.delete"
            : "entry.update"
        : isPhase
          ? "phase.update"
          : isSceneEventBatch
            ? direction === "undo"
              ? "event.unstamp"
              : "event.stamp"
            : journal.op_kind === "create"
              ? direction === "undo"
                ? "foreshadow.delete"
                : "foreshadow.create"
              : journal.op_kind === "delete"
                ? direction === "undo"
                  ? "foreshadow.create"
                  : "foreshadow.delete"
                : "foreshadow.update";
      const eventUid = crypto.randomUUID();
      const timestamp = Date.now();
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain:
          isCodexEntry || isPhase
            ? "codex"
            : isSceneEventBatch
              ? "event"
              : "foreshadow",
        opType,
        entityType: isCodexEntry
          ? "codex_entry"
          : isPhase
            ? "phase"
            : isSceneEventBatch
              ? "event"
              : "foreshadow",
        entityId: String(journal.entity_id),
        payload: JSON.stringify({
          direction,
          opKind: String(journal.op_kind),
          journalId,
          ...(sceneEventSnapshot
            ? {
                eventId: sceneEventSnapshot.eventId,
                sceneIds: sceneEventSnapshot.sceneIds,
              }
            : {}),
        }),
        sessionId,
        timestamp,
      });
      const now = new Date(timestamp).toISOString();

      db.run("BEGIN IMMEDIATE");
      try {
        const existing = queryOne(
          `SELECT payload_hash
             FROM idempotency_requests
            WHERE domain = 'agent_apply_undo_journal' AND request_id = ?`,
          [requestId],
        );
        if (existing) {
          if (String(existing.payload_hash) !== payloadHash) {
            throw new Error(
              "UNDO_JOURNAL_IDEMPOTENCY_CONFLICT: request id reused with different payload",
            );
          }
          db.run("COMMIT");
          return { ok: true };
        }

        const currentJournal = queryOne(
          `SELECT entity_kind, entity_id, op_kind, before_json, after_json,
                  base_version, result_version
             FROM undo_journal
            WHERE id = ? AND project_id = ?`,
          [journalId, projectId],
        );
        if (!currentJournal) {
          throw new Error(`undo journal '${journalId}' disappeared`);
        }
        if (currentJournal.entity_kind === "codex_entry") {
          const opKind = String(currentJournal.op_kind);
          const entryId = String(currentJournal.entity_id);
          if (opKind === "create") {
            const snapshot = parseBrowserCodexEntrySnapshot(
              currentJournal.after_json,
              journalId,
            );
            assertBrowserCodexSnapshotIdentity(
              snapshot,
              projectId,
              entryId,
              journalId,
            );
            if (direction === "undo") {
              const expectedVersion = Number(currentJournal.result_version);
              db.run(
                `DELETE FROM codex_entries
                  WHERE id = ? AND project_id = ? AND version = ?`,
                [entryId, projectId, expectedVersion],
              );
              if (db.getRowsModified() !== 1) {
                throw new Error(
                  `codex entry '${entryId}' version conflict during undo replay`,
                );
              }
            } else {
              const previousVersion = Number(currentJournal.result_version);
              const replayVersion = previousVersion + 1;
              if (!Number.isSafeInteger(replayVersion)) {
                throw new Error("codex version overflow during redo create");
              }
              insertBrowserCodexEntrySnapshot(snapshot, replayVersion, now);
              rewriteBrowserCodexJournalStateToken(
                projectId,
                entryId,
                previousVersion,
                replayVersion,
              );
            }
          } else if (opKind === "update") {
            const snapshot = parseBrowserCodexEntrySnapshot(
              direction === "undo"
                ? currentJournal.before_json
                : currentJournal.after_json,
              journalId,
            );
            assertBrowserCodexSnapshotIdentity(
              snapshot,
              projectId,
              entryId,
              journalId,
            );
            const expectedVersion = Number(
              direction === "undo"
                ? currentJournal.result_version
                : currentJournal.base_version,
            );
            const previousTargetVersion = Number(
              direction === "undo"
                ? currentJournal.base_version
                : currentJournal.result_version,
            );
            const replayVersion = expectedVersion + 1;
            if (!Number.isSafeInteger(replayVersion)) {
              throw new Error(`codex version overflow during ${direction}`);
            }
            restoreBrowserCodexEntrySnapshot(
              snapshot,
              expectedVersion,
              replayVersion,
              now,
            );
            rewriteBrowserCodexJournalStateToken(
              projectId,
              entryId,
              previousTargetVersion,
              replayVersion,
            );
          } else if (opKind === "delete") {
            const snapshot = parseBrowserCodexEntrySnapshot(
              currentJournal.before_json,
              journalId,
            );
            assertBrowserCodexSnapshotIdentity(
              snapshot,
              projectId,
              entryId,
              journalId,
            );
            if (direction === "undo") {
              const previousVersion = Number(currentJournal.base_version);
              const replayVersion = previousVersion + 1;
              if (!Number.isSafeInteger(replayVersion)) {
                throw new Error("codex version overflow during undo delete");
              }
              insertBrowserCodexEntrySnapshot(snapshot, replayVersion, now);
              rewriteBrowserCodexJournalStateToken(
                projectId,
                entryId,
                previousVersion,
                replayVersion,
              );
            } else {
              const expectedVersion = Number(currentJournal.result_version);
              db.run(
                `DELETE FROM codex_entries
                  WHERE id = ? AND project_id = ? AND version = ?`,
                [entryId, projectId, expectedVersion],
              );
              if (db.getRowsModified() !== 1) {
                throw new Error(
                  `codex entry '${entryId}' version conflict during redo replay`,
                );
              }
            }
          } else {
            throw new Error(
              `codex undo journal '${journalId}' has unsupported op '${opKind}'`,
            );
          }
        } else if (currentJournal.entity_kind === "codex_phase") {
          if (currentJournal.op_kind !== "update") {
            throw new Error(`phase undo journal '${journalId}' is invalid`);
          }
          const snapshot = parseBrowserPhaseAggregateSnapshot(
            direction === "undo"
              ? currentJournal.before_json
              : currentJournal.after_json,
            journalId,
          );
          const expectedVersion = Number(
            direction === "undo"
              ? currentJournal.result_version
              : currentJournal.base_version,
          );
          const priorTargetVersion = Number(
            direction === "undo"
              ? currentJournal.base_version
              : currentJournal.result_version,
          );
          const targetVersion = expectedVersion + 1;
          if (!Number.isSafeInteger(targetVersion)) {
            throw new Error(`phase version overflow during ${direction}`);
          }
          restoreBrowserPhaseAggregateSnapshot(
            projectId,
            snapshot,
            expectedVersion,
            targetVersion,
            now,
          );
          rewriteBrowserPhaseJournalStateToken(
            projectId,
            String(currentJournal.entity_id),
            priorTargetVersion,
            targetVersion,
          );
        } else if (currentJournal.entity_kind === "foreshadow") {
          const opKind = String(currentJournal.op_kind);
          const foreshadowId = String(currentJournal.entity_id);
          if (opKind === "create") {
            if (direction === "undo") {
              const expectedVersion = Number(currentJournal.result_version);
              const aggregate = loadBrowserForeshadowAggregateSnapshot(
                foreshadowId,
                projectId,
              );
              if (
                !aggregate ||
                aggregate.version !== expectedVersion ||
                aggregate.setups.length > 0 ||
                aggregate.payoffs.length > 0 ||
                aggregate.supportEdges.length > 0 ||
                aggregate.codexEntryIds.length > 0
              ) {
                throw new Error(
                  `foreshadow '${foreshadowId}' aggregate changed before undo replay`,
                );
              }
              db.run(
                `DELETE FROM foreshadows
                  WHERE id = ? AND project_id = ? AND version = ?`,
                [foreshadowId, projectId, expectedVersion],
              );
              if (db.getRowsModified() !== 1) {
                throw new Error(
                  `foreshadow '${foreshadowId}' changed before undo replay`,
                );
              }
            } else {
              const snapshot = parseBrowserForeshadowSnapshot(
                currentJournal.after_json,
                journalId,
              );
              if (snapshot.projectId !== projectId) {
                throw new Error(
                  `foreshadow undo journal '${journalId}' project mismatch`,
                );
              }
              const expectedVersion = Number(currentJournal.result_version);
              const replayVersion = expectedVersion + 1;
              if (!Number.isSafeInteger(replayVersion)) {
                throw new Error("foreshadow version overflow during redo");
              }
              insertBrowserForeshadowSnapshot(
                snapshot,
                replayVersion,
                timestamp,
              );
              rewriteBrowserForeshadowJournalStateToken(
                projectId,
                foreshadowId,
                expectedVersion,
                replayVersion,
              );
            }
          } else if (opKind === "update") {
            const snapshot = parseBrowserForeshadowSnapshot(
              direction === "undo"
                ? currentJournal.before_json
                : currentJournal.after_json,
              journalId,
            );
            if (snapshot.projectId !== projectId) {
              throw new Error(
                `foreshadow undo journal '${journalId}' project mismatch`,
              );
            }
            const expectedVersion = Number(
              direction === "undo"
                ? currentJournal.result_version
                : currentJournal.base_version,
            );
            const previousTargetVersion = Number(
              direction === "undo"
                ? currentJournal.base_version
                : currentJournal.result_version,
            );
            const replayVersion = expectedVersion + 1;
            if (!Number.isSafeInteger(replayVersion)) {
              throw new Error(
                `foreshadow version overflow during ${direction}`,
              );
            }
            restoreBrowserForeshadowSnapshot(
              snapshot,
              expectedVersion,
              replayVersion,
              timestamp,
            );
            rewriteBrowserForeshadowJournalStateToken(
              projectId,
              foreshadowId,
              previousTargetVersion,
              replayVersion,
            );
          } else if (opKind === "delete") {
            const snapshot = parseBrowserForeshadowAggregateSnapshot(
              currentJournal.before_json,
              journalId,
            );
            if (snapshot.projectId !== projectId) {
              throw new Error(
                `foreshadow undo journal '${journalId}' project mismatch`,
              );
            }
            if (direction === "undo") {
              const previousVersion = Number(currentJournal.base_version);
              const replayVersion = previousVersion + 1;
              if (!Number.isSafeInteger(replayVersion)) {
                throw new Error(
                  "foreshadow version overflow during undo delete",
                );
              }
              insertBrowserForeshadowAggregateSnapshot(
                snapshot,
                replayVersion,
                timestamp,
              );
              rewriteBrowserForeshadowJournalStateToken(
                projectId,
                foreshadowId,
                previousVersion,
                replayVersion,
              );
            } else {
              const expectedVersion = Number(currentJournal.result_version);
              deleteBrowserForeshadowAggregateAtVersion(
                snapshot,
                expectedVersion,
              );
            }
          } else {
            throw new Error(
              `foreshadow undo journal '${journalId}' has unsupported op '${opKind}'`,
            );
          }
        } else if (currentJournal.entity_kind === "event") {
          if (currentJournal.op_kind !== "update") {
            throw new Error(
              `scene event batch journal '${journalId}' is invalid`,
            );
          }
          replayBrowserSceneEventLinkBatchSnapshot(
            projectId,
            journalId,
            direction,
            currentJournal.before_json,
            currentJournal.after_json,
          );
        } else {
          throw new Error(
            `browser undo does not support entity kind '${String(currentJournal.entity_kind)}'`,
          );
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO idempotency_requests
            (domain, request_id, project_id, payload_hash, tombstone_json, created_at)
           VALUES ('agent_apply_undo_journal', ?, ?, ?, ?, ?)`,
          [
            requestId,
            projectId,
            payloadHash,
            JSON.stringify({ id: journalId }),
            now,
          ],
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return { ok: true };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original undo replay failure.
        }
        throw error;
      }
    });
  }

  async function handleAgentCodexCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const p = nativeCodexPayload(args);
    const projectId = browserCodexRequiredPayloadString(p, "projectId");
    const sessionId = browserCodexRequiredPayloadString(p, "sessionId");
    const surface =
      browserCodexOptionalPayloadString(p.surface, "surface") ?? "in-app-agent";
    const suppliedEntryId = browserCodexOptionalPayloadString(
      p.entryId,
      "entryId",
    );
    const explicitRequestId = browserCodexOptionalPayloadString(
      p.requestId,
      "requestId",
    );
    const requestId = explicitRequestId ?? suppliedEntryId;
    const entryId = suppliedEntryId ?? crypto.randomUUID();
    const eventUid = crypto.randomUUID();
    const undoJournalId = requestId ?? crypto.randomUUID();
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();
    const typeSlug = browserCodexRequiredPayloadString(p, "typeSlug");
    const name = browserCodexRequiredPayloadString(p, "name");
    const aliases = browserCodexOptionalPayloadString(p.aliases, "aliases");
    const excludedAliases = browserCodexOptionalPayloadString(
      p.excludedAliases,
      "excludedAliases",
    );
    const readings = browserCodexOptionalPayloadString(p.readings, "readings");
    const tagsCache = browserCodexOptionalPayloadString(
      p.tagsCache,
      "tagsCache",
    );
    const summary = browserCodexOptionalPayloadString(p.summary, "summary");
    const content = browserCodexOptionalPayloadString(p.content, "content");
    const rawParentId = browserCodexOptionalPayloadString(
      p.parentId,
      "parentId",
    );
    const parentId = rawParentId === "" ? null : rawParentId;
    const sourceChatMessageId = browserCodexOptionalPayloadString(
      p.sourceChatMessageId,
      "sourceChatMessageId",
    );
    const authorshipSpans = parseBrowserCodexAuthorshipSpans(
      p.authorshipSpans ?? [],
      "agent codex create",
    );
    const authorshipModel = browserCodexOptionalPayloadString(p.model, "model");
    const authorshipChatMsgId =
      browserCodexOptionalPayloadString(p.chatMessageId, "chatMessageId") ??
      browserCodexOptionalPayloadString(
        p.sourceChatMessageId,
        "sourceChatMessageId",
      );
    const authorshipTraceId = browserCodexOptionalPayloadString(
      p.traceId,
      "traceId",
    );

    return withAppendLedgerLock(async () => {
      const requestHash = await browserPayloadFingerprint(
        BROWSER_CODEX_CREATE_IDEMPOTENCY_DOMAIN,
        browserCodexCreateFingerprintPayload(p, authorshipSpans),
      );
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "codex",
        opType: "entry.create",
        entityType: "codex_entry",
        entityId: entryId,
        payload: JSON.stringify({
          type: typeSlug,
          name,
          parentId,
          ...(requestId === null ? {} : { requestHash }),
        }),
        sessionId,
        timestamp,
      });

      db.run("BEGIN IMMEDIATE");
      try {
        if (requestId !== null) {
          const replay = loadBrowserCodexCreateReplayResult({
            requestId,
            projectId,
            requestHash,
          });
          if (replay) {
            db.run("COMMIT");
            return replay;
          }
          const orphanedJournal = queryOne(
            "SELECT 1 AS found FROM undo_journal WHERE id = ?",
            [requestId],
          );
          const occupiedEntry =
            suppliedEntryId === null
              ? null
              : queryOne("SELECT 1 AS found FROM codex_entries WHERE id = ?", [
                  suppliedEntryId,
                ]);
          if (orphanedJournal || occupiedEntry) {
            browserCodexCreateConflict(
              "original idempotency receipt is missing",
            );
          }
        }
        if (
          !queryOne("SELECT 1 AS owned FROM projects WHERE id = ?", [projectId])
        ) {
          throw new Error(`project '${projectId}' not found`);
        }
        assertBrowserCodexEntryReferences(
          projectId,
          entryId,
          typeSlug,
          parentId,
        );
        db.run(
          `INSERT INTO codex_entries
            (id, project_id, type, name, aliases, excluded_aliases, readings,
             tags_cache, summary, content, parent_id, source_chat_message_id,
             version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            entryId,
            projectId,
            typeSlug,
            name,
            aliases,
            excludedAliases,
            readings,
            tagsCache,
            summary ?? "",
            content ?? "{}",
            parentId,
            sourceChatMessageId,
            now,
            now,
          ],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(`codex entry '${entryId}' was not created`);
        }
        mergeBrowserCodexAuthorshipSpans({
          entryId,
          spans: authorshipSpans,
          lanes: null,
          updateSummary: true,
          updateContent: true,
          model: authorshipModel,
          chatMsgId: authorshipChatMsgId,
          traceId: authorshipTraceId,
          now,
        });
        const after = loadBrowserCodexEntrySnapshot(entryId, projectId);
        if (!after || after.version !== 1) {
          throw new Error(
            `codex entry '${entryId}' could not be read after create`,
          );
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        insertBrowserCodexUndoJournal({
          id: undoJournalId,
          projectId,
          surface,
          entryId,
          opKind: "create",
          before: null,
          after,
          baseVersion: 0,
          resultVersion: after.version,
          changeEventUid: eventUid,
          now,
        });
        const result: BrowserCodexWriteResult = {
          entityId: entryId,
          version: after.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
        if (requestId !== null) {
          db.run(
            `INSERT INTO idempotency_requests
              (domain, request_id, project_id, payload_hash,
               tombstone_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              BROWSER_CODEX_CREATE_IDEMPOTENCY_DOMAIN,
              requestId,
              projectId,
              requestHash,
              JSON.stringify(result),
              now,
            ],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(
              `codex create idempotency receipt '${requestId}' was not persisted`,
            );
          }
        }
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return result;
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original Codex create failure.
        }
        throw error;
      }
    });
  }

  async function handleAgentCodexUpdate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const p = nativeCodexPayload(args);
    const projectId = browserCodexRequiredPayloadString(p, "projectId");
    const sessionId = browserCodexRequiredPayloadString(p, "sessionId");
    const surface =
      browserCodexOptionalPayloadString(p.surface, "surface") ?? "in-app-agent";
    const entryId = browserCodexRequiredPayloadString(p, "entryId");
    const baseVersion = browserCodexRequiredPayloadInteger(p, "baseVersion");
    const eventUid = crypto.randomUUID();
    const undoJournalId = crypto.randomUUID();
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();
    const columns: Record<string, string> = {
      typeSlug: "type",
      name: "name",
      summary: "summary",
      content: "content",
      aliases: "aliases",
      excludedAliases: "excluded_aliases",
      readings: "readings",
      tagsCache: "tags_cache",
      parentId: "parent_id",
      contextMode: "context_mode",
      icon: "icon",
      childrenBudget: "children_budget",
      notes: "notes",
    };
    const changedFields = Object.keys(columns).filter((key) => p[key] != null);
    for (const key of changedFields) {
      browserCodexOptionalPayloadString(p[key], key);
    }
    const nullableSentinelFields = new Set([
      "excludedAliases",
      "readings",
      "tagsCache",
      "parentId",
      "icon",
      "notes",
    ]);
    const authorshipSpans =
      p.authorshipSpans == null
        ? null
        : parseBrowserCodexAuthorshipSpans(
            p.authorshipSpans,
            "agent codex update",
          );
    const authorshipSpanLanes = parseBrowserCodexAuthorshipSpanLanes(
      p.authorshipSpanLanes,
    );
    const authorshipModel = browserCodexOptionalPayloadString(p.model, "model");
    const authorshipChatMsgId = browserCodexOptionalPayloadString(
      p.chatMessageId,
      "chatMessageId",
    );
    const authorshipTraceId = browserCodexOptionalPayloadString(
      p.traceId,
      "traceId",
    );

    return withAppendLedgerLock(async () => {
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "codex",
        opType: "entry.update",
        entityType: "codex_entry",
        entityId: entryId,
        payload: JSON.stringify({ fields: changedFields }),
        sessionId,
        timestamp,
      });

      db.run("BEGIN IMMEDIATE");
      try {
        const before = loadBrowserCodexEntrySnapshot(entryId, projectId);
        if (!before) {
          throw new Error(
            `codex entry '${entryId}' is not in project '${projectId}'`,
          );
        }
        if (before.version !== baseVersion) {
          throw new Error(
            `codex entry '${entryId}' version conflict: expected ${baseVersion} but database has ${before.version}`,
          );
        }
        const nextType = changedFields.includes("typeSlug")
          ? String(p.typeSlug)
          : before.type;
        const nextParent = changedFields.includes("parentId")
          ? p.parentId === ""
            ? null
            : String(p.parentId)
          : before.parentId;
        assertBrowserCodexEntryReferences(
          projectId,
          entryId,
          nextType,
          nextParent,
        );

        const sets: string[] = [];
        const params: SqlValue[] = [];
        for (const [key, column] of Object.entries(columns)) {
          if (!changedFields.includes(key)) continue;
          sets.push(`${column} = ?`);
          const value = String(p[key]);
          params.push(
            nullableSentinelFields.has(key) && value === "" ? null : value,
          );
        }
        sets.push("version = version + 1", "updated_at = ?");
        params.push(now, entryId, projectId, baseVersion);
        db.run(
          `UPDATE codex_entries SET ${sets.join(", ")}
            WHERE id = ? AND project_id = ? AND version = ?`,
          params,
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(`codex entry '${entryId}' version conflict`);
        }
        if (authorshipSpans !== null) {
          mergeBrowserCodexAuthorshipSpans({
            entryId,
            spans: authorshipSpans,
            lanes: authorshipSpanLanes,
            updateSummary: changedFields.includes("summary"),
            updateContent: changedFields.includes("content"),
            model: authorshipModel,
            chatMsgId: authorshipChatMsgId,
            traceId: authorshipTraceId,
            now,
          });
        }
        const after = loadBrowserCodexEntrySnapshot(entryId, projectId);
        if (!after || after.version !== baseVersion + 1) {
          throw new Error(
            `codex entry '${entryId}' version conflict after update`,
          );
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        insertBrowserCodexUndoJournal({
          id: undoJournalId,
          projectId,
          surface,
          entryId,
          opKind: "update",
          before,
          after,
          baseVersion: before.version,
          resultVersion: after.version,
          changeEventUid: eventUid,
          now,
        });
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: entryId,
          version: after.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original Codex update failure.
        }
        throw error;
      }
    });
  }

  async function handleAgentCodexDelete(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const p = nativeCodexPayload(args);
    const projectId = browserCodexRequiredPayloadString(p, "projectId");
    const sessionId = browserCodexRequiredPayloadString(p, "sessionId");
    const surface =
      browserCodexOptionalPayloadString(p.surface, "surface") ?? "in-app-agent";
    const entryId = browserCodexRequiredPayloadString(p, "entryId");
    const baseVersion = browserCodexRequiredPayloadInteger(p, "baseVersion");
    const eventUid = crypto.randomUUID();
    const undoJournalId = crypto.randomUUID();
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();

    return withAppendLedgerLock(async () => {
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "codex",
        opType: "entry.delete",
        entityType: "codex_entry",
        entityId: entryId,
        payload: JSON.stringify({}),
        sessionId,
        timestamp,
      });

      db.run("BEGIN IMMEDIATE");
      try {
        const before = loadBrowserCodexEntrySnapshot(entryId, projectId);
        if (!before) {
          throw new Error(
            `codex entry '${entryId}' is not in project '${projectId}'`,
          );
        }
        if (before.version !== baseVersion) {
          throw new Error(
            `codex entry '${entryId}' version conflict: expected ${baseVersion} but database has ${before.version}`,
          );
        }
        db.run(
          `DELETE FROM codex_entries
            WHERE id = ? AND project_id = ? AND version = ?`,
          [entryId, projectId, baseVersion],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(`codex entry '${entryId}' version conflict`);
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        insertBrowserCodexUndoJournal({
          id: undoJournalId,
          projectId,
          surface,
          entryId,
          opKind: "delete",
          before,
          after: null,
          baseVersion: before.version,
          resultVersion: before.version,
          changeEventUid: eventUid,
          now,
        });
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: entryId,
          version: before.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original Codex delete failure.
        }
        throw error;
      }
    });
  }

  async function handleBrowserCodexDetailMutation(
    p: Record<string, unknown>,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const projectId = browserCodexRequiredNonEmptyPayloadString(p, "projectId");
    const sessionId = browserCodexRequiredNonEmptyPayloadString(p, "sessionId");
    const surface =
      browserCodexOptionalPayloadString(p.surface, "surface") ?? "manual";
    const definitionId = browserCodexRequiredNonEmptyPayloadString(
      p,
      "definitionId",
    );
    const valueEntryId =
      operation === "detail.value.upsert"
        ? browserCodexRequiredNonEmptyPayloadString(p, "entryId")
        : null;
    const requestedValueId =
      operation === "detail.value.upsert"
        ? browserCodexOptionalPayloadString(p.valueId, "valueId")
        : null;
    const detailValue =
      operation === "detail.value.upsert"
        ? browserCodexOptionalPayloadString(p.value, "value")
        : null;
    const eventUid = crypto.randomUUID();
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();

    return withAppendLedgerLock(async () => {
      let entityId: string;
      let expectedValueExists = false;
      if (operation === "detail.value.upsert") {
        const existing = queryOne(
          `SELECT value_row.id
             FROM codex_detail_values value_row
             JOIN codex_entries entry ON entry.id = value_row.entry_id
             JOIN codex_detail_definitions definition
               ON definition.id = value_row.definition_id
            WHERE value_row.entry_id = ? AND value_row.definition_id = ?
              AND entry.project_id = ? AND definition.project_id = ?`,
          [valueEntryId, definitionId, projectId, projectId],
        );
        expectedValueExists = existing !== null;
        entityId = existing
          ? String(existing.id)
          : (requestedValueId ?? crypto.randomUUID());
      } else {
        entityId = definitionId;
      }
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "codex",
        opType: operation,
        entityType: "detail",
        entityId,
        payload: JSON.stringify({ surface, operation }),
        sessionId,
        timestamp,
      });

      db.run("BEGIN IMMEDIATE");
      try {
        let version: number;
        if (operation === "detail.definition.create") {
          const typeSlug = browserCodexRequiredNonEmptyPayloadString(
            p,
            "typeSlug",
          );
          const name = browserCodexRequiredNonEmptyPayloadString(p, "name");
          const fieldType =
            browserCodexOptionalPayloadString(p.fieldType, "fieldType") ??
            "text";
          const fieldConfig = browserCodexOptionalPayloadString(
            p.fieldConfig,
            "fieldConfig",
          );
          const sortOrder =
            browserCodexOptionalPayloadNumber(p, "sortOrder") ?? 0;
          const includeInContext =
            browserCodexOptionalPayloadBoolInt(p, "includeInContext") ?? 0;
          const rawSemanticBinding = p.semanticBinding;
          if (
            rawSemanticBinding !== undefined &&
            !isRecord(rawSemanticBinding)
          ) {
            throw new Error("semanticBinding must be an object");
          }
          const semanticBinding = rawSemanticBinding as
            | Record<string, unknown>
            | undefined;
          const requiredBindingString = (key: string): string => {
            const value = semanticBinding?.[key];
            if (typeof value !== "string" || value.trim().length === 0) {
              throw new Error(`semanticBinding.${key} is required`);
            }
            return value;
          };
          let confirmed = 0;
          if (semanticBinding?.confirmed !== undefined) {
            if (typeof semanticBinding.confirmed === "boolean") {
              confirmed = semanticBinding.confirmed ? 1 : 0;
            } else if (
              semanticBinding.confirmed === 0 ||
              semanticBinding.confirmed === 1
            ) {
              confirmed = semanticBinding.confirmed;
            } else {
              throw new Error(
                "semanticBinding.confirmed must be a boolean or 0/1",
              );
            }
          }
          db.run(
            `INSERT INTO codex_detail_definitions
              (id, project_id, type_slug, name, field_type, field_config,
               sort_order, include_in_context, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [
              entityId,
              projectId,
              typeSlug,
              name,
              fieldType,
              fieldConfig,
              sortOrder,
              includeInContext,
              now,
              now,
            ],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(`detail definition '${entityId}' was not created`);
          }
          if (semanticBinding) {
            db.run(
              `INSERT INTO codex_detail_semantic_bindings
                (id, project_id, definition_id, facet_key, projection_kind,
                 temporal_policy, source, confirmed, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
              [
                requiredBindingString("id"),
                projectId,
                entityId,
                requiredBindingString("facetKey"),
                requiredBindingString("projectionKind"),
                requiredBindingString("temporalPolicy"),
                requiredBindingString("source"),
                confirmed,
                now,
                now,
              ],
            );
            if (db.getRowsModified() !== 1) {
              throw new Error(
                `detail semantic binding for '${entityId}' was not created`,
              );
            }
          }
          version = 0;
        } else if (operation === "detail.definition.update") {
          const assignments: string[] = [];
          const values: SqlValue[] = [];
          const definitionColumns: Record<string, string> = {
            name: "name",
            fieldType: "field_type",
            fieldConfig: "field_config",
            sortOrder: "sort_order",
            includeInContext: "include_in_context",
          };
          for (const [key, column] of Object.entries(definitionColumns)) {
            if (!(key in p)) continue;
            assignments.push(`${column} = ?`);
            if (key === "sortOrder") {
              values.push(browserCodexOptionalPayloadNumber(p, key));
            } else if (key === "includeInContext") {
              values.push(browserCodexOptionalPayloadBoolInt(p, key) ?? 0);
            } else {
              values.push(browserCodexOptionalPayloadString(p[key], key));
            }
          }
          if (assignments.length === 0) {
            throw new Error("definition update has no fields");
          }
          const baseVersion = browserCodexRequiredPayloadInteger(
            p,
            "baseVersion",
          );
          version = baseVersion + 1;
          assignments.push("version = ?", "updated_at = ?");
          values.push(version, now, entityId, projectId, baseVersion);
          db.run(
            `UPDATE codex_detail_definitions
                SET ${assignments.join(", ")}
              WHERE id = ? AND project_id = ? AND version = ?`,
            values,
          );
          if (db.getRowsModified() !== 1) {
            throw new Error("detail definition version conflict");
          }
        } else if (operation === "detail.definition.delete") {
          db.run(
            `DELETE FROM codex_detail_definitions
              WHERE id = ? AND project_id = ?`,
            [entityId, projectId],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(`detail definition '${entityId}' not found`);
          }
          version = 0;
        } else if (operation === "detail.value.upsert") {
          const entryId = valueEntryId as string;
          if (
            !queryOne(
              "SELECT 1 AS owned FROM codex_entries WHERE id = ? AND project_id = ?",
              [entryId, projectId],
            )
          ) {
            throw new Error(
              `codex entry '${entryId}' is not in project '${projectId}'`,
            );
          }
          if (
            !queryOne(
              `SELECT 1 AS owned FROM codex_detail_definitions
                WHERE id = ? AND project_id = ?`,
              [definitionId, projectId],
            )
          ) {
            throw new Error(
              `detail definition '${definitionId}' is not in project '${projectId}'`,
            );
          }
          const existing = queryOne(
            `SELECT id, version FROM codex_detail_values
              WHERE entry_id = ? AND definition_id = ?`,
            [entryId, definitionId],
          );
          if ((existing !== null) !== expectedValueExists) {
            throw new Error("detail value identity changed during mutation");
          }
          if (!existing) {
            db.run(
              `INSERT INTO codex_detail_values
                (id, entry_id, definition_id, value, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, 1, ?, ?)`,
              [entityId, entryId, definitionId, detailValue, now, now],
            );
            if (db.getRowsModified() !== 1) {
              throw new Error(`detail value '${entityId}' was not created`);
            }
            version = 1;
          } else {
            if (String(existing.id) !== entityId) {
              throw new Error("detail value identity changed during mutation");
            }
            const baseVersion = browserCodexRequiredPayloadInteger(
              p,
              "baseVersion",
            );
            if (Number(existing.version) !== baseVersion) {
              throw new Error("detail value version conflict");
            }
            version = baseVersion + 1;
            db.run(
              `UPDATE codex_detail_values
                  SET value = ?, version = ?, updated_at = ?
                WHERE id = ? AND entry_id = ? AND definition_id = ?
                  AND version = ?`,
              [
                detailValue,
                version,
                now,
                entityId,
                entryId,
                definitionId,
                baseVersion,
              ],
            );
            if (db.getRowsModified() !== 1) {
              throw new Error("detail value version conflict");
            }
          }
        } else {
          throw new Error(`Unsupported Codex mutation: ${operation}`);
        }

        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return { entityId, version, changeEventUid: eventUid };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original Detail mutation failure.
        }
        throw error;
      }
    });
  }

  function handleAgentCodexMutate(args: Record<string, unknown>) {
    const p = nativeCodexPayload(args);
    const operation = browserCodexRequiredPayloadString(p, "operation");
    if (
      operation === "detail.definition.create" ||
      operation === "detail.definition.update" ||
      operation === "detail.definition.delete" ||
      operation === "detail.value.upsert"
    ) {
      return handleBrowserCodexDetailMutation(p, operation);
    }
    const now = new Date().toISOString();
    if (operation === "relation.create") {
      db.run(
        `INSERT INTO codex_relations
          (id, project_id, from_codex_id, to_codex_id, relation_type, label,
           directionality, inverse_label, semantic_key, version, depth_hint,
           source_map_edge_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          String(p.relationId),
          String(p.projectId),
          String(p.fromCodexId),
          String(p.toCodexId),
          String(p.relationType ?? "custom"),
          nativeNullable(p.label) ?? null,
          String(p.directionality ?? "directed"),
          nativeNullable(p.inverseLabel) ?? null,
          String(p.semanticKey ?? ""),
          p.depthHint == null ? null : Number(p.depthHint),
          nativeNullable(p.sourceMapEdgeId) ?? null,
          now,
          now,
        ],
      );
    } else if (operation === "relation.delete") {
      db.run("DELETE FROM codex_relations WHERE id = ? AND project_id = ?", [
        String(p.relationId),
        String(p.projectId),
      ]);
    } else if (operation === "phase.create") {
      const projectId = String(p.projectId);
      const entryId = String(p.entryId);
      if (p.anchorNodeId != null && typeof p.anchorNodeId !== "string") {
        throw new Error("phase anchorNodeId must be a string or null");
      }
      const anchorNodeId = nativeNullable(p.anchorNodeId) ?? null;
      db.run("BEGIN IMMEDIATE");
      try {
        if (
          !queryOne(
            "SELECT 1 AS owned FROM codex_entries WHERE id = ? AND project_id = ?",
            [entryId, projectId],
          )
        ) {
          throw new Error(
            `phase entry '${entryId}' is not in project '${projectId}'`,
          );
        }
        if (
          anchorNodeId !== null &&
          !queryOne(
            `SELECT 1 AS owned FROM tree_nodes
              WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
            [anchorNodeId, projectId],
          )
        ) {
          throw new Error(
            `phase anchor '${anchorNodeId}' is not a scene in project '${projectId}'`,
          );
        }
        db.run(
          `INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, summary_override,
             content_override, context_mode_override, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(p.phaseId),
            entryId,
            anchorNodeId,
            String(p.label ?? ""),
            nativeNullable(p.summaryOverride) ?? null,
            nativeNullable(p.contentOverride) ?? null,
            nativeNullable(p.contextModeOverride) ?? null,
            Number(p.version ?? 0),
            String(p.createdAt ?? now),
            now,
          ],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(`phase '${String(p.phaseId)}' was not created`);
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the phase create failure.
        }
        throw error;
      }
    } else if (
      operation === "phase.update" ||
      operation === "phase.aggregate"
    ) {
      return handleBrowserPhasePatch(p);
    } else if (operation === "phase.delete") {
      db.run(
        p.expectedVersion == null
          ? "DELETE FROM codex_entry_phases WHERE id = ?"
          : "DELETE FROM codex_entry_phases WHERE id = ? AND version = ?",
        p.expectedVersion == null
          ? [String(p.phaseId)]
          : [String(p.phaseId), Number(p.expectedVersion)],
      );
    } else {
      throw new Error(`Unsupported Codex mutation: ${operation}`);
    }
    options.onDatabaseDirty?.();
    return {
      entityId: String(
        p.entryId ?? p.phaseId ?? p.definitionId ?? p.relationId,
      ),
      version: 1,
      changeEventUid: crypto.randomUUID(),
    };
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

  function lintTermDictionaryRowsToWire(
    rows: Record<string, unknown>[],
  ): Array<Record<string, unknown>> {
    return rows.map((row) => {
      let variants: string[] = [];
      try {
        const parsed = JSON.parse(String(row.variants ?? "[]"));
        if (Array.isArray(parsed)) {
          variants = parsed.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          );
        }
      } catch {
        // Match the native boundary: a corrupt row is readable with no
        // variants, so one row cannot block the rest of the dictionary.
      }
      return {
        id: String(row.id),
        preferred: String(row.preferred),
        variants,
        severity: String(row.severity) === "info" ? "info" : "warning",
        note: row.note == null ? null : String(row.note),
        enabled: Number(row.enabled ?? 1) === 1,
        sortOrder: Number(row.sort_order ?? 0),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
      };
    });
  }

  function handleLintTermDictionaryList(args: Record<string, unknown>) {
    const result = handleDbExecute({
      sql: `SELECT id, preferred, variants, severity, note, enabled,
                   sort_order, created_at, updated_at
              FROM lint_term_dictionary
             WHERE project_id = ?
             ORDER BY sort_order ASC, preferred ASC`,
      params: [String(args.projectId)],
      method: "all",
    });
    return lintTermDictionaryRowsToWire(result.rows);
  }

  function selectLintTermDictionaryEntry(
    projectId: string,
    id: string,
  ): Record<string, unknown> {
    const result = handleDbExecute({
      sql: `SELECT id, preferred, variants, severity, note, enabled,
                   sort_order, created_at, updated_at
              FROM lint_term_dictionary
             WHERE project_id = ? AND id = ?`,
      params: [projectId, id],
      method: "all",
    });
    const entry = lintTermDictionaryRowsToWire(result.rows)[0];
    if (!entry) {
      throw new Error("lint term dictionary entry not found");
    }
    return entry;
  }

  function handleLintTermDictionaryInsert(args: Record<string, unknown>) {
    const payload = args.payload as Record<string, unknown>;
    handleDbExecute({
      sql: `INSERT INTO lint_term_dictionary
             (id, project_id, preferred, variants, severity, note, enabled,
              sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        String(payload.id),
        String(payload.projectId),
        String(payload.preferred),
        JSON.stringify(payload.variants),
        String(payload.severity),
        payload.note == null ? null : String(payload.note),
        payload.enabled ? 1 : 0,
        Number(payload.sortOrder),
        Number(payload.createdAt),
        Number(payload.updatedAt),
      ],
      method: "run",
    });
    return selectLintTermDictionaryEntry(
      String(payload.projectId),
      String(payload.id),
    );
  }

  function handleLintTermDictionaryUpdate(args: Record<string, unknown>) {
    const payload = args.payload as Record<string, unknown>;
    handleDbExecute({
      sql: `UPDATE lint_term_dictionary
               SET preferred = ?, variants = ?, severity = ?, note = ?,
                   enabled = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
      params: [
        String(payload.preferred),
        JSON.stringify(payload.variants),
        String(payload.severity),
        payload.note == null ? null : String(payload.note),
        payload.enabled ? 1 : 0,
        Number(payload.updatedAt),
        String(payload.projectId),
        String(payload.id),
      ],
      method: "run",
    });
    return selectLintTermDictionaryEntry(
      String(payload.projectId),
      String(payload.id),
    );
  }

  function handleLintTermDictionarySetEnabled(args: Record<string, unknown>) {
    handleDbExecute({
      sql: `UPDATE lint_term_dictionary
               SET enabled = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
      params: [
        args.enabled ? 1 : 0,
        Number(args.updatedAt),
        String(args.projectId),
        String(args.id),
      ],
      method: "run",
    });
    return selectLintTermDictionaryEntry(
      String(args.projectId),
      String(args.id),
    );
  }

  function handleLintTermDictionaryDelete(args: Record<string, unknown>) {
    handleDbExecute({
      sql: "DELETE FROM lint_term_dictionary WHERE project_id = ? AND id = ?",
      params: [String(args.projectId), String(args.id)],
      method: "run",
    });
    return null;
  }

  function handleEventGetVersion(args: Record<string, unknown>): number | null {
    const row = queryOne(
      "SELECT version FROM events WHERE id = ? AND project_id = ?",
      [String(args.eventId), String(args.projectId)],
    );
    return row ? Number(row.version) : null;
  }

  function handleEventSetParticipants(
    args: Record<string, unknown>,
  ): number | null {
    const payload = args.payload as Record<string, unknown>;
    const eventId = String(payload.eventId);
    const projectId = String(payload.projectId);
    const baseVersion = Number(payload.baseVersion);
    const currentVersion = handleEventGetVersion({ eventId, projectId });
    if (currentVersion !== baseVersion) return null;

    const codexEntryIds = payload.codexEntryIds as string[];
    for (const codexEntryId of codexEntryIds) {
      const entry = queryOne(
        "SELECT 1 FROM codex_entries WHERE id = ? AND project_id = ?",
        [codexEntryId, projectId],
      );
      if (!entry) {
        throw new Error(
          `chronicle participant '${codexEntryId}' is not in project '${projectId}'`,
        );
      }
    }

    const nextVersion = baseVersion + 1;
    handleDbExecuteBatch({
      statements: [
        {
          sql: `UPDATE events SET version = ?, updated_at = ?
                 WHERE id = ? AND project_id = ? AND version = ?`,
          params: [
            nextVersion,
            String(payload.updatedAt),
            eventId,
            projectId,
            baseVersion,
          ],
          method: "run",
        },
        {
          sql: "DELETE FROM event_participants WHERE event_id = ?",
          params: [eventId],
          method: "run",
        },
        ...codexEntryIds.map((codexEntryId) => ({
          sql: `INSERT INTO event_participants
                  (event_id, codex_entry_id, role)
                VALUES (?, ?, NULL)`,
          params: [eventId, codexEntryId],
          method: "run",
        })),
      ],
    });
    return nextVersion;
  }

  function selectProjectCalendarRow(
    projectId: string,
  ): Record<string, unknown> | null {
    const row = queryOne(
      `SELECT project_id, days_per_year, season_boundaries, start_year, months,
              weekday_names, weekday_start_index, leap_rule, age_reckoning,
              eras, reform, timezone, lunar_tz_minutes, version, created_at,
              updated_at
         FROM project_calendar WHERE project_id = ?`,
      [projectId],
    );
    if (!row) return null;
    return {
      projectId: String(row.project_id),
      daysPerYear: Number(row.days_per_year),
      seasonBoundaries: String(row.season_boundaries),
      startYear: Number(row.start_year),
      months: String(row.months),
      weekdayNames: String(row.weekday_names),
      weekdayStartIndex: Number(row.weekday_start_index),
      leapRule: String(row.leap_rule),
      ageReckoning: String(row.age_reckoning),
      eras: String(row.eras),
      reform: String(row.reform),
      timezone: String(row.timezone),
      lunarTzMinutes: Number(row.lunar_tz_minutes),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Project Calendar create/update (single-row OCC, mirrors
   * `grimodex_db::chronicle::upsert_project_calendar`). `baseVersion === null`
   * means create (conflict if a row exists); `baseVersion` set means update
   * (conflict if the row is missing or its version has moved on). Returns
   * `null` for every conflict so callers map it to the same typed error the
   * native backend produces.
   */
  function handleProjectCalendarUpsert(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const payload = args.payload as Record<string, unknown>;
    const projectId = String(payload.projectId);
    const baseVersion =
      payload.baseVersion === null || payload.baseVersion === undefined
        ? null
        : Number(payload.baseVersion);
    const existing = queryOne(
      "SELECT version FROM project_calendar WHERE project_id = ?",
      [projectId],
    );
    const existingVersion = existing ? Number(existing.version) : null;

    if (baseVersion === null && existingVersion !== null) return null;
    if (baseVersion !== null && existingVersion === null) return null;
    if (
      baseVersion !== null &&
      existingVersion !== null &&
      baseVersion !== existingVersion
    ) {
      return null;
    }

    const updatedAt = String(payload.updatedAt);
    const daysPerYear = Number(payload.daysPerYear);
    const seasonBoundaries = String(payload.seasonBoundaries);
    const startYear = Number(payload.startYear);
    const months = String(payload.months);
    const weekdayNames = String(payload.weekdayNames);
    const weekdayStartIndex = Number(payload.weekdayStartIndex);
    const leapRule = String(payload.leapRule);
    const ageReckoning = String(payload.ageReckoning);
    const eras = String(payload.eras);
    const reform = String(payload.reform);
    const timezone = String(payload.timezone);
    const lunarTzMinutes = Number(payload.lunarTzMinutes);

    if (baseVersion === null) {
      handleDbExecuteBatch({
        statements: [
          {
            sql: `INSERT INTO project_calendar (
                    project_id, days_per_year, season_boundaries, start_year,
                    months, weekday_names, weekday_start_index, leap_rule,
                    age_reckoning, eras, reform, timezone, lunar_tz_minutes,
                    version, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            params: [
              projectId,
              daysPerYear,
              seasonBoundaries,
              startYear,
              months,
              weekdayNames,
              weekdayStartIndex,
              leapRule,
              ageReckoning,
              eras,
              reform,
              timezone,
              lunarTzMinutes,
              updatedAt,
              updatedAt,
            ],
            method: "run",
          },
        ],
      });
    } else {
      handleDbExecuteBatch({
        statements: [
          {
            sql: `UPDATE project_calendar SET
                    days_per_year = ?, season_boundaries = ?, start_year = ?,
                    months = ?, weekday_names = ?, weekday_start_index = ?,
                    leap_rule = ?, age_reckoning = ?, eras = ?, reform = ?,
                    timezone = ?, lunar_tz_minutes = ?, version = ?,
                    updated_at = ?
                  WHERE project_id = ? AND version = ?`,
            params: [
              daysPerYear,
              seasonBoundaries,
              startYear,
              months,
              weekdayNames,
              weekdayStartIndex,
              leapRule,
              ageReckoning,
              eras,
              reform,
              timezone,
              lunarTzMinutes,
              baseVersion + 1,
              updatedAt,
              projectId,
              baseVersion,
            ],
            method: "run",
          },
        ],
      });
    }

    return selectProjectCalendarRow(projectId);
  }

  function handleFtsSearch(
    args: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const projectId = String(args.projectId ?? "default-project");
    const query = String(args.query ?? "").trim();
    const scope = String(args.scope ?? "all");
    const limit = Math.max(1, Number(args.limit ?? 50));
    if (!query) return [];

    const like = `%${query}%`;
    if (scope === "chat_history") {
      return queryAll(
        `SELECT
            m.id AS msg_id,
            m.session_id,
            s.title AS session_title,
            s.node_id,
            s.codex_anchor_id,
            s.snippet_anchor_id,
            m.role,
            m.content,
            m.created_at,
            s.updated_at AS session_updated_at
           FROM chat_messages m
           JOIN chat_sessions s ON m.session_id = s.id
          WHERE s.project_id = ?
            AND m.role != 'system'
            AND m.content LIKE ?
          ORDER BY s.updated_at DESC, m.created_at DESC
          LIMIT ?`,
        [projectId, like, limit],
      ).map((row) => ({
        ...row,
        highlighted_content: String(row.content).replace(
          query,
          `\x01${query}\x02`,
        ),
      }));
    }

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
        assertRendererDoesNotMutateAiAudit(s.sql);
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

  function handleAuthorshipReplaceLane(args: Record<string, unknown>): void {
    const payload = args.payload as {
      lane: Record<string, unknown>;
      spans: Array<Record<string, unknown>>;
    };
    const lane = payload.lane;
    const kind = String(lane.kind);
    let deleteSql: string;
    let deleteId: string;
    let owners: [SqlValue, SqlValue, SqlValue, SqlValue, SqlValue];
    switch (kind) {
      case "node":
        deleteSql = "DELETE FROM authorship_spans WHERE node_id = ?";
        deleteId = String(lane.nodeId);
        if (!queryOne("SELECT 1 FROM tree_nodes WHERE id = ?", [deleteId])) {
          throw new Error("authorship owner lane does not exist");
        }
        owners = [deleteId, null, null, null, null];
        break;
      case "codex":
        deleteSql = `DELETE FROM authorship_spans
          WHERE codex_entry_id = ? AND phase_id IS NULL
            AND detail_value_id IS NULL`;
        deleteId = String(lane.codexEntryId);
        if (!queryOne("SELECT 1 FROM codex_entries WHERE id = ?", [deleteId])) {
          throw new Error("authorship owner lane does not exist");
        }
        owners = [null, deleteId, null, null, null];
        break;
      case "snippet":
        deleteSql = "DELETE FROM authorship_spans WHERE snippet_id = ?";
        deleteId = String(lane.snippetId);
        if (!queryOne("SELECT 1 FROM snippets WHERE id = ?", [deleteId])) {
          throw new Error("authorship owner lane does not exist");
        }
        owners = [null, null, deleteId, null, null];
        break;
      case "detail": {
        deleteSql = "DELETE FROM authorship_spans WHERE detail_value_id = ?";
        deleteId = String(lane.detailValueId);
        const codexEntryId = String(lane.codexEntryId);
        if (
          !queryOne(
            `SELECT 1 FROM codex_detail_values
              WHERE id = ? AND entry_id = ?`,
            [deleteId, codexEntryId],
          )
        ) {
          throw new Error("authorship owner lane does not exist");
        }
        owners = [null, null, null, deleteId, null];
        break;
      }
      case "phase": {
        deleteSql = "DELETE FROM authorship_spans WHERE phase_id = ?";
        deleteId = String(lane.phaseId);
        const codexEntryId = String(lane.codexEntryId);
        if (
          !queryOne(
            `SELECT 1 FROM codex_entry_phases
              WHERE id = ? AND entry_id = ?`,
            [deleteId, codexEntryId],
          )
        ) {
          throw new Error("authorship owner lane does not exist");
        }
        owners = [null, codexEntryId, null, null, deleteId];
        break;
      }
      default:
        throw new Error("unsupported authorship owner lane");
    }

    const statements: Array<{
      sql: string;
      params: SqlValue[];
      method: string;
    }> = [{ sql: deleteSql, params: [deleteId], method: "run" }];
    for (const span of payload.spans) {
      statements.push({
        sql: `INSERT INTO authorship_spans
          (id, node_id, codex_entry_id, snippet_id, detail_value_id,
           from_pos, to_pos, source, model, timestamp, chat_msg_id, trace_id,
           phase_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          String(span.id),
          owners[0],
          owners[1],
          owners[2],
          owners[3],
          Number(span.fromPos),
          Number(span.toPos),
          String(span.source),
          (span.model as SqlValue) ?? null,
          (span.timestamp as SqlValue) ?? null,
          (span.chatMsgId as SqlValue) ?? null,
          (span.traceId as SqlValue) ?? null,
          owners[4],
        ],
        method: "run",
      });
    }
    handleDbExecuteBatch({ statements });
  }

  function handleEntityTagsSet(args: Record<string, unknown>): void {
    const payload = args.payload as {
      entityKind: "codex" | "snippet";
      entityId: string;
      tagIds: string[];
      updatedAt: string | null;
    };
    const entityTable =
      payload.entityKind === "codex" ? "codex_entries" : "snippets";
    const entity = queryOne(
      `SELECT project_id FROM ${entityTable} WHERE id = ?`,
      [payload.entityId],
    );
    if (!entity) throw new Error(`${payload.entityKind} entity not found`);
    const projectId = String(entity.project_id);
    const tags = payload.tagIds.map((tagId) => {
      const tag = queryOne(
        `SELECT name, color FROM codex_tags
          WHERE id = ? AND project_id = ?`,
        [tagId, projectId],
      );
      if (!tag) throw new Error(`tag '${tagId}' is not in the entity project`);
      return { id: tagId, name: String(tag.name), color: tag.color ?? null };
    });
    tags.sort((a, b) => a.name.localeCompare(b.name));
    const tagsCache = JSON.stringify(
      tags.map(({ name, color }) => ({ name, color })),
    );
    const statements: Array<{
      sql: string;
      params: SqlValue[];
      method: string;
    }> = [];
    if (payload.entityKind === "codex") {
      statements.push({
        sql: "DELETE FROM codex_entry_tags WHERE entry_id = ?",
        params: [payload.entityId],
        method: "run",
      });
      for (const tag of tags) {
        statements.push({
          sql: `INSERT INTO codex_entry_tags (entry_id, tag_id)
                VALUES (?, ?)`,
          params: [payload.entityId, tag.id],
          method: "run",
        });
      }
      statements.push({
        sql: `UPDATE codex_entries
                SET tags_cache = ?, updated_at = ?
              WHERE id = ? AND project_id = ?`,
        params: [tagsCache, payload.updatedAt, payload.entityId, projectId],
        method: "run",
      });
    } else {
      statements.push({
        sql: "DELETE FROM snippet_entry_tags WHERE snippet_id = ?",
        params: [payload.entityId],
        method: "run",
      });
      for (const tag of tags) {
        statements.push({
          sql: `INSERT INTO snippet_entry_tags (snippet_id, tag_id)
                VALUES (?, ?)`,
          params: [payload.entityId, tag.id],
          method: "run",
        });
      }
      statements.push({
        sql: `UPDATE snippets SET tags_cache = ?
              WHERE id = ? AND project_id = ?`,
        params: [tagsCache, payload.entityId, projectId],
        method: "run",
      });
    }
    handleDbExecuteBatch({ statements });
  }

  function handleCodexRenameUndo(args: Record<string, unknown>): {
    versions: Array<{
      kind: string;
      refId: string;
      detailDefinitionId: string | null;
      baseVersion: number;
      version: number;
    }>;
  } {
    const payload = args.payload as {
      projectId: string;
      updatedAt: string;
      updates: Array<{
        kind: string;
        refId: string;
        detailDefinitionId: string | null;
        baseVersion: number;
        value: string;
        charCount: number | null;
        placedBeatPreview: string | null;
      }>;
    };
    const statements: Array<{
      sql: string;
      params: SqlValue[];
      method: string;
    }> = [];
    const aggregateVersions = new Map<
      string,
      { initial: number; current: number }
    >();
    const persistedVersions: Array<{
      kind: string;
      refId: string;
      detailDefinitionId: string | null;
      baseVersion: number;
      version: number;
    }> = [];
    for (const update of payload.updates) {
      if (!Number.isSafeInteger(update.baseVersion) || update.baseVersion < 0) {
        throw new Error(
          "codex rename baseVersion must be a non-negative integer",
        );
      }
      const aggregateKey =
        update.kind === "codex-detail"
          ? `codex-detail:${update.refId}:${update.detailDefinitionId ?? ""}`
          : update.kind.startsWith("codex-")
            ? `codex-entry:${update.refId}`
            : `tree-node:${update.refId}`;
      const previous = aggregateVersions.get(aggregateKey);
      if (previous && previous.initial !== update.baseVersion) {
        throw new Error("CODEX_RENAME_VERSION_MISMATCH");
      }
      const expectedVersion = previous?.current ?? update.baseVersion;
      const nextVersion = expectedVersion + 1;
      aggregateVersions.set(aggregateKey, {
        initial: previous?.initial ?? update.baseVersion,
        current: nextVersion,
      });
      if (update.kind.startsWith("node-") || update.kind === "scene-body") {
        const row = queryOne(
          "SELECT version FROM tree_nodes WHERE id = ? AND project_id = ?",
          [update.refId, payload.projectId],
        );
        if (!row) {
          throw new Error("codex rename undo tree target is outside project");
        }
        if (Number(row.version) !== expectedVersion) {
          throw new Error("CODEX_RENAME_VERSION_MISMATCH");
        }
      } else if (update.kind.startsWith("codex-")) {
        const exists =
          update.kind === "codex-detail"
            ? queryOne(
                `SELECT value.version AS version
                   FROM codex_detail_values value
                   JOIN codex_entries entry ON entry.id = value.entry_id
                  WHERE value.entry_id = ? AND value.definition_id = ?
                    AND entry.project_id = ?`,
                [update.refId, update.detailDefinitionId, payload.projectId],
              )
            : update.kind === "codex-relation-label"
              ? queryOne(
                  "SELECT version FROM codex_relations WHERE id = ? AND project_id = ?",
                  [update.refId, payload.projectId],
                )
              : queryOne(
                  "SELECT version FROM codex_entries WHERE id = ? AND project_id = ?",
                  [update.refId, payload.projectId],
                );
        if (!exists) {
          throw new Error("codex rename undo target is outside project");
        }
        if (Number(exists.version) !== expectedVersion) {
          throw new Error("CODEX_RENAME_VERSION_MISMATCH");
        }
      }

      switch (update.kind) {
        case "scene-body":
          statements.push({
            sql: `UPDATE tree_nodes
                    SET content = ?, char_count = ?, placed_beat_preview = ?,
                        version = ?, updated_at = ?
                  WHERE id = ? AND project_id = ? AND node_type = 'scene'
                    AND version = ?`,
            params: [
              update.value,
              update.charCount,
              update.placedBeatPreview,
              nextVersion,
              payload.updatedAt,
              update.refId,
              payload.projectId,
              expectedVersion,
            ],
            method: "run",
          });
          break;
        case "node-title":
        case "node-synopsis": {
          const column = update.kind === "node-title" ? "title" : "synopsis";
          statements.push({
            sql: `UPDATE tree_nodes SET ${column} = ?, version = ?, updated_at = ?
                  WHERE id = ? AND project_id = ? AND version = ?`,
            params: [
              update.value,
              nextVersion,
              payload.updatedAt,
              update.refId,
              payload.projectId,
              expectedVersion,
            ],
            method: "run",
          });
          break;
        }
        case "codex-summary":
        case "codex-content":
        case "codex-notes": {
          const column =
            update.kind === "codex-summary"
              ? "summary"
              : update.kind === "codex-content"
                ? "content"
                : "notes";
          statements.push({
            sql: `UPDATE codex_entries SET ${column} = ?, version = ?, updated_at = ?
                  WHERE id = ? AND project_id = ? AND version = ?`,
            params: [
              update.value,
              nextVersion,
              payload.updatedAt,
              update.refId,
              payload.projectId,
              expectedVersion,
            ],
            method: "run",
          });
          break;
        }
        case "codex-detail":
          statements.push({
            sql: `UPDATE codex_detail_values SET value = ?, version = ?, updated_at = ?
                  WHERE entry_id = ? AND definition_id = ? AND version = ?
                    AND EXISTS (
                      SELECT 1 FROM codex_entries
                       WHERE id = ? AND project_id = ?
                    )`,
            params: [
              update.value,
              nextVersion,
              payload.updatedAt,
              update.refId,
              update.detailDefinitionId,
              expectedVersion,
              update.refId,
              payload.projectId,
            ],
            method: "run",
          });
          break;
        case "codex-relation-label":
          statements.push({
            sql: `UPDATE codex_relations SET label = ?, version = ?, updated_at = ?
                  WHERE id = ? AND project_id = ? AND version = ?`,
            params: [
              update.value,
              nextVersion,
              payload.updatedAt,
              update.refId,
              payload.projectId,
              expectedVersion,
            ],
            method: "run",
          });
          break;
        default:
          throw new Error("unsupported codex rename undo kind");
      }
      persistedVersions.push({
        kind: update.kind,
        refId: update.refId,
        detailDefinitionId: update.detailDefinitionId,
        baseVersion: expectedVersion,
        version: nextVersion,
      });
    }
    handleDbExecuteBatch({ statements });
    return { versions: persistedVersions };
  }

  function handleScanStagingProjectCreate(args: Record<string, unknown>): void {
    const payload = args.payload as {
      id: string;
      title: string;
      language: "ja" | "en";
      createdAt: string;
    };
    handleDbExecuteBatch({
      statements: [
        {
          sql: `INSERT INTO projects
            (id, title, language, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
          params: [
            payload.id,
            payload.title,
            payload.language,
            payload.createdAt,
            payload.createdAt,
          ],
          method: "run",
        },
        {
          sql: `INSERT INTO project_settings (project_id, key, value)
                VALUES (?, 'scan.import.state', 'staging')
                ON CONFLICT(project_id, key)
                DO UPDATE SET value = 'staging'`,
          params: [payload.id],
          method: "run",
        },
      ],
    });
  }

  function handleTreePlanUndo(args: Record<string, unknown>): void {
    const payload = args.payload as {
      projectId: string;
      beforeStates: Array<{
        id: string;
        parentId: string | null;
        sortOrder: string;
        title: string;
      }>;
      createdIds: string[];
      updatedAt: string;
    };
    const statements = payload.beforeStates.map((state) => ({
      sql: `UPDATE tree_nodes
              SET parent_id = ?, sort_order = ?, title = ?, updated_at = ?
            WHERE id = ? AND project_id = ?`,
      params: [
        state.parentId,
        state.sortOrder,
        state.title,
        payload.updatedAt,
        state.id,
        payload.projectId,
      ],
      method: "run",
    }));
    for (const id of [...payload.createdIds].reverse()) {
      statements.push({
        sql: "DELETE FROM tree_nodes WHERE id = ? AND project_id = ?",
        params: [id, payload.projectId],
        method: "run",
      });
    }
    handleDbExecuteBatch({ statements });
  }

  type BrowserMapRow = Record<string, unknown>;
  type BrowserMapStatement = {
    sql: string;
    params: SqlValue[];
    method: "run";
  };

  function mapValue(row: BrowserMapRow, key: string): SqlValue {
    return (row[key] as SqlValue | undefined) ?? null;
  }

  function mapStatement(sql: string, params: SqlValue[]): BrowserMapStatement {
    return { sql, params, method: "run" };
  }

  function ensureBrowserMapBoardProject(
    boardId: string,
    projectId: string,
  ): void {
    if (
      !queryOne("SELECT 1 FROM map_boards WHERE id = ? AND project_id = ?", [
        boardId,
        projectId,
      ])
    ) {
      throw new Error("map board is outside project");
    }
  }

  function validateBrowserMapGraph(
    projectId: string,
    boardId: string,
    branches: BrowserMapRow[],
    stickies: BrowserMapRow[],
    positions: BrowserMapRow[],
    edges: BrowserMapRow[],
    frames: BrowserMapRow[],
    spans: BrowserMapRow[],
  ): void {
    const branchIds = new Set(branches.map((row) => String(row.id)));
    const stickyIds = new Set(stickies.map((row) => String(row.id)));
    const positionIds = new Set(positions.map((row) => String(row.id)));
    for (const row of [
      ...branches,
      ...stickies,
      ...positions,
      ...edges,
      ...frames,
    ]) {
      if (String(row.boardId) !== boardId) {
        throw new Error("map aggregate contains a foreign board row");
      }
    }
    for (const row of stickies) {
      if (row.aiBranchId && !branchIds.has(String(row.aiBranchId))) {
        throw new Error("map sticky references a foreign AI branch");
      }
    }
    for (const row of positions) {
      const kind = String(row.nodeRefType);
      const valid =
        kind === "scene" || kind === "note"
          ? Boolean(
              row.treeNodeId &&
              queryOne(
                "SELECT 1 FROM tree_nodes WHERE id = ? AND project_id = ?",
                [String(row.treeNodeId), projectId],
              ),
            )
          : kind === "codex"
            ? Boolean(
                row.codexEntryId &&
                queryOne(
                  "SELECT 1 FROM codex_entries WHERE id = ? AND project_id = ?",
                  [String(row.codexEntryId), projectId],
                ),
              )
            : kind === "snippet"
              ? Boolean(
                  row.snippetId &&
                  queryOne(
                    "SELECT 1 FROM snippets WHERE id = ? AND project_id = ?",
                    [String(row.snippetId), projectId],
                  ),
                )
              : kind === "sticky"
                ? stickyIds.has(String(row.stickyId))
                : kind === "ai_branch"
                  ? branchIds.has(String(row.aiBranchId))
                  : false;
      if (!valid) throw new Error("map position has an invalid reference");
    }
    for (const row of edges) {
      if (
        !positionIds.has(String(row.fromPositionId)) ||
        !positionIds.has(String(row.toPositionId))
      ) {
        throw new Error("map edge references a foreign position");
      }
    }
    for (const row of spans) {
      if (!stickyIds.has(String(row.stickyId))) {
        throw new Error("map authorship span references a foreign sticky");
      }
    }
  }

  function browserMapBoardInsert(row: BrowserMapRow): BrowserMapStatement {
    return mapStatement(
      `INSERT INTO map_boards
        (id, project_id, title, sort_order, mode, viewport_x, viewport_y,
         viewport_zoom, show_config, color_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "projectId"),
        mapValue(row, "title"),
        mapValue(row, "sortOrder"),
        mapValue(row, "mode"),
        mapValue(row, "viewportX"),
        mapValue(row, "viewportY"),
        mapValue(row, "viewportZoom"),
        mapValue(row, "showConfig"),
        mapValue(row, "colorBy"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapBranchInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO map_ai_branches
        (id, board_id, prompt, seed_node_ids, session_id, model, token_usage,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "boardId"),
        mapValue(row, "prompt"),
        mapValue(row, "seedNodeIds"),
        mapValue(row, "sessionId"),
        mapValue(row, "model"),
        mapValue(row, "tokenUsage"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapStickyInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO map_stickies
        (id, board_id, title, body, preview_text, palette_id, color_slot,
         ai_branch_id, ai_derived, source_chat_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "boardId"),
        mapValue(row, "title"),
        mapValue(row, "body"),
        mapValue(row, "previewText"),
        mapValue(row, "paletteId"),
        mapValue(row, "colorSlot"),
        mapValue(row, "aiBranchId"),
        mapValue(row, "aiDerived"),
        mapValue(row, "sourceChatMessageId"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapPositionInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO map_node_positions
        (id, board_id, node_ref_type, tree_node_id, codex_entry_id, snippet_id,
         sticky_id, ai_branch_id, x, y, pinned, z_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "boardId"),
        mapValue(row, "nodeRefType"),
        mapValue(row, "treeNodeId"),
        mapValue(row, "codexEntryId"),
        mapValue(row, "snippetId"),
        mapValue(row, "stickyId"),
        mapValue(row, "aiBranchId"),
        mapValue(row, "x"),
        mapValue(row, "y"),
        mapValue(row, "pinned"),
        mapValue(row, "zIndex"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapEdgeInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO map_edges
        (id, board_id, from_position_id, to_position_id, forward_label,
         backward_label, labels, style, color, direction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "boardId"),
        mapValue(row, "fromPositionId"),
        mapValue(row, "toPositionId"),
        mapValue(row, "forwardLabel"),
        mapValue(row, "backwardLabel"),
        mapValue(row, "labels"),
        mapValue(row, "style"),
        mapValue(row, "color"),
        mapValue(row, "direction"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapFrameInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO map_frames
        (id, board_id, title, x, y, width, height, background, border_color,
         z_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "boardId"),
        mapValue(row, "title"),
        mapValue(row, "x"),
        mapValue(row, "y"),
        mapValue(row, "width"),
        mapValue(row, "height"),
        mapValue(row, "background"),
        mapValue(row, "borderColor"),
        mapValue(row, "zIndex"),
        mapValue(row, "createdAt"),
        mapValue(row, "updatedAt"),
      ],
    );
  }

  function browserMapSpanInsert(
    row: BrowserMapRow,
    restore: boolean,
  ): BrowserMapStatement {
    return mapStatement(
      `${restore ? "INSERT OR IGNORE" : "INSERT"} INTO authorship_spans
        (id, node_id, codex_entry_id, snippet_id, detail_value_id, sticky_id,
         from_pos, to_pos, source, model, timestamp, chat_msg_id, trace_id,
         phase_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapValue(row, "id"),
        mapValue(row, "nodeId"),
        mapValue(row, "codexEntryId"),
        mapValue(row, "snippetId"),
        mapValue(row, "detailValueId"),
        mapValue(row, "stickyId"),
        mapValue(row, "fromPos"),
        mapValue(row, "toPos"),
        mapValue(row, "source"),
        mapValue(row, "model"),
        mapValue(row, "timestamp"),
        mapValue(row, "chatMsgId"),
        mapValue(row, "traceId"),
        mapValue(row, "phaseId"),
      ],
    );
  }

  function handleMapWriteBundle(args: Record<string, unknown>): void {
    const payload = args.payload as BrowserMapRow;
    const kind = String(payload.kind);
    const projectId = String(payload.projectId);
    const statements: BrowserMapStatement[] = [];

    if (kind === "create-board") {
      const board = payload.board as BrowserMapRow;
      const stickies = (payload.stickies ?? []) as BrowserMapRow[];
      const positions = (payload.positions ?? []) as BrowserMapRow[];
      const edges = (payload.edges ?? []) as BrowserMapRow[];
      const frames = (payload.frames ?? []) as BrowserMapRow[];
      if (
        String(board.projectId) !== projectId ||
        !queryOne("SELECT 1 FROM projects WHERE id = ?", [projectId])
      ) {
        throw new Error("map board project is invalid");
      }
      validateBrowserMapGraph(
        projectId,
        String(board.id),
        [],
        stickies,
        positions,
        edges,
        frames,
        [],
      );
      statements.push(browserMapBoardInsert(board));
      statements.push(
        ...stickies.map((row) => browserMapStickyInsert(row, false)),
        ...positions.map((row) => browserMapPositionInsert(row, false)),
        ...edges.map((row) => browserMapEdgeInsert(row, false)),
        ...frames.map((row) => browserMapFrameInsert(row, false)),
      );
    } else if (kind === "create-ai-branch" || kind === "restore-ai-branch") {
      const restore = kind === "restore-ai-branch";
      const branch = payload.branch as BrowserMapRow;
      const branchPosition = payload.branchPosition as BrowserMapRow;
      const stickies = (payload.stickies ?? []) as BrowserMapRow[];
      const positions = (payload.positions ?? []) as BrowserMapRow[];
      const edges = (payload.edges ?? []) as BrowserMapRow[];
      const spans = (payload.spans ?? []) as BrowserMapRow[];
      const boardId = String(branch.boardId);
      ensureBrowserMapBoardProject(boardId, projectId);
      validateBrowserMapGraph(
        projectId,
        boardId,
        [branch],
        stickies,
        [branchPosition, ...positions],
        edges,
        [],
        spans,
      );
      statements.push(
        browserMapBranchInsert(branch, restore),
        browserMapPositionInsert(branchPosition, restore),
        ...stickies.map((row) => browserMapStickyInsert(row, restore)),
      );
      if (restore) {
        statements.push(
          ...stickies.map((row) =>
            mapStatement(
              `UPDATE map_stickies SET ai_branch_id = ?
                WHERE id = ? AND board_id = ?`,
              [mapValue(branch, "id"), mapValue(row, "id"), boardId],
            ),
          ),
        );
      }
      statements.push(
        ...positions.map((row) => browserMapPositionInsert(row, restore)),
        ...edges.map((row) => browserMapEdgeInsert(row, restore)),
        ...spans.map((row) => browserMapSpanInsert(row, restore)),
      );
    } else if (kind === "promote-sticky") {
      const boardId = String(payload.boardId);
      const stickyId = String(payload.stickyId);
      const positionId = String(payload.positionId);
      const newEntityId = String(payload.newEntityId);
      const targetType = String(payload.targetType);
      ensureBrowserMapBoardProject(boardId, projectId);
      if (
        !queryOne("SELECT 1 FROM map_stickies WHERE id = ? AND board_id = ?", [
          stickyId,
          boardId,
        ]) ||
        !queryOne(
          `SELECT 1 FROM map_node_positions
            WHERE id = ? AND board_id = ? AND sticky_id = ?`,
          [positionId, boardId, stickyId],
        )
      ) {
        throw new Error("map sticky promotion target is stale");
      }
      let treeNodeId: SqlValue = null;
      let codexEntryId: SqlValue = null;
      let snippetId: SqlValue = null;
      if (targetType === "scene" || targetType === "note") {
        if (
          payload.parentId &&
          !queryOne(
            "SELECT 1 FROM tree_nodes WHERE id = ? AND project_id = ?",
            [String(payload.parentId), projectId],
          )
        ) {
          throw new Error("map sticky promotion parent is outside project");
        }
        treeNodeId = newEntityId;
        statements.push(
          mapStatement(
            `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order, content,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newEntityId,
              projectId,
              mapValue(payload, "parentId"),
              targetType,
              mapValue(payload, "title"),
              mapValue(payload, "sortOrder"),
              mapValue(payload, "body"),
              mapValue(payload, "createdAt"),
              mapValue(payload, "updatedAt"),
            ],
          ),
        );
      } else if (targetType === "snippet") {
        snippetId = newEntityId;
        statements.push(
          mapStatement(
            `INSERT INTO snippets
              (id, project_id, title, content, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              newEntityId,
              projectId,
              mapValue(payload, "title"),
              mapValue(payload, "body"),
              mapValue(payload, "createdAt"),
              mapValue(payload, "updatedAt"),
            ],
          ),
        );
      } else if (targetType === "codex") {
        codexEntryId = newEntityId;
        statements.push(
          mapStatement(
            `INSERT INTO codex_entries
              (id, project_id, type, name, content, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              newEntityId,
              projectId,
              mapValue(payload, "codexType"),
              mapValue(payload, "title"),
              mapValue(payload, "body"),
              mapValue(payload, "createdAt"),
              mapValue(payload, "updatedAt"),
            ],
          ),
        );
      } else {
        throw new Error("unsupported sticky promotion target");
      }
      statements.push(
        mapStatement(
          `UPDATE map_node_positions
              SET node_ref_type = ?, tree_node_id = ?, codex_entry_id = ?,
                  snippet_id = ?, sticky_id = NULL, ai_branch_id = NULL,
                  updated_at = ?
            WHERE id = ? AND board_id = ? AND sticky_id = ?`,
          [
            targetType,
            treeNodeId,
            codexEntryId,
            snippetId,
            mapValue(payload, "updatedAt"),
            positionId,
            boardId,
            stickyId,
          ],
        ),
        mapStatement(
          `UPDATE authorship_spans
              SET node_id = ?, codex_entry_id = ?, snippet_id = ?,
                  sticky_id = NULL
            WHERE sticky_id = ?`,
          [treeNodeId, codexEntryId, snippetId, stickyId],
        ),
        mapStatement("DELETE FROM map_stickies WHERE id = ? AND board_id = ?", [
          stickyId,
          boardId,
        ]),
      );
    } else if (kind === "erase-ai-branch") {
      const branchId = String(payload.branchId);
      const branch = queryOne(
        `SELECT branch.board_id
           FROM map_ai_branches branch
           JOIN map_boards board ON board.id = branch.board_id
          WHERE branch.id = ? AND board.project_id = ?`,
        [branchId, projectId],
      );
      if (!branch) throw new Error("AI branch is outside project");
      const boardId = String(branch.board_id);
      for (const id of (payload.spanIds ?? []) as string[]) {
        statements.push(
          mapStatement(
            `DELETE FROM authorship_spans
              WHERE id = ? AND sticky_id IN (
                SELECT id FROM map_stickies
                 WHERE board_id = ? AND ai_branch_id = ?
              )`,
            [id, boardId, branchId],
          ),
        );
      }
      for (const id of (payload.stickyPositionIds ?? []) as string[]) {
        statements.push(
          mapStatement(
            `DELETE FROM map_node_positions
              WHERE id = ? AND board_id = ? AND sticky_id IN (
                SELECT id FROM map_stickies
                 WHERE board_id = ? AND ai_branch_id = ?
              )`,
            [id, boardId, boardId, branchId],
          ),
        );
      }
      for (const id of (payload.stickyIds ?? []) as string[]) {
        statements.push(
          mapStatement(
            `DELETE FROM map_stickies
              WHERE id = ? AND board_id = ? AND ai_branch_id = ?`,
            [id, boardId, branchId],
          ),
        );
      }
      statements.push(
        mapStatement(
          "DELETE FROM map_ai_branches WHERE id = ? AND board_id = ?",
          [branchId, boardId],
        ),
      );
    } else if (kind === "extract-frame-to-codex") {
      const boardId = String(payload.boardId);
      const frameId = String(payload.frameId);
      const stickyIds = (payload.stickyIds ?? []) as string[];
      ensureBrowserMapBoardProject(boardId, projectId);
      if (
        !queryOne("SELECT 1 FROM map_frames WHERE id = ? AND board_id = ?", [
          frameId,
          boardId,
        ])
      ) {
        throw new Error("map frame is stale");
      }
      for (const stickyId of stickyIds) {
        if (
          !queryOne(
            "SELECT 1 FROM map_stickies WHERE id = ? AND board_id = ?",
            [stickyId, boardId],
          )
        ) {
          throw new Error("map frame contains a foreign sticky");
        }
      }
      statements.push(
        mapStatement(
          `INSERT INTO codex_entries
            (id, project_id, type, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            mapValue(payload, "codexId"),
            projectId,
            mapValue(payload, "codexType"),
            mapValue(payload, "title"),
            mapValue(payload, "content"),
            mapValue(payload, "createdAt"),
            mapValue(payload, "updatedAt"),
          ],
        ),
      );
      for (const stickyId of stickyIds) {
        statements.push(
          mapStatement(
            `UPDATE authorship_spans
                SET codex_entry_id = ?, sticky_id = NULL
              WHERE sticky_id = ?`,
            [mapValue(payload, "codexId"), stickyId],
          ),
        );
      }
      for (const stickyId of stickyIds) {
        statements.push(
          mapStatement(
            "DELETE FROM map_stickies WHERE id = ? AND board_id = ?",
            [stickyId, boardId],
          ),
        );
      }
      statements.push(
        mapStatement("DELETE FROM map_frames WHERE id = ? AND board_id = ?", [
          frameId,
          boardId,
        ]),
      );
    } else {
      throw new Error("unsupported map write kind");
    }

    handleDbExecuteBatch({ statements });
  }

  const browserSnapshotRestoreTables = new Set<string>([
    "tree_nodes",
    "codex_entries",
    "snippets",
    ...AUX_SCOPES,
  ]);

  function browserSnapshotTableOwner(table: string): RestoreScope | null {
    if (table === "tree_nodes") return "body";
    if (table === "codex_entries") return "codex";
    if (table === "snippets") return "snippet";
    return (
      (AUX_SCOPE_OWNER as Partial<Record<string, RestoreScope>>)[table] ?? null
    );
  }

  function browserSnapshotInsertStatement(
    table: string,
    row: RawRow,
    mode: "insert" | "replace" = "insert",
  ): { sql: string; params: SqlValue[]; method: "run" } {
    const columns = Object.keys(row).sort();
    if (columns.length === 0) {
      throw new Error(`project snapshot insert for '${table}' is empty`);
    }
    const verb = mode === "replace" ? "INSERT OR REPLACE" : "INSERT";
    return {
      sql: `${verb} INTO "${table}" (${columns
        .map((column) => `"${column}"`)
        .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params: columns.map((column) => row[column]) as SqlValue[],
      method: "run",
    };
  }

  function browserSnapshotPayload(
    args: Record<string, unknown>,
    command: string,
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

  function browserSnapshotOwned(projectId: string, snapshotId: string): void {
    if (
      !queryOne(
        "SELECT 1 FROM project_snapshots WHERE id = ? AND project_id = ?",
        [snapshotId, projectId],
      )
    ) {
      throw new Error(
        `project snapshot '${snapshotId}' is not owned by project '${projectId}'`,
      );
    }
  }

  function handleProjectSnapshotCreate(args: Record<string, unknown>): void {
    const payload = browserSnapshotPayload(args, "project_snapshot_create");
    const projectId = String(payload.projectId);
    const snapshotId = String(payload.snapshotId);
    if (!queryOne("SELECT 1 FROM projects WHERE id = ?", [projectId])) {
      throw new Error(`project snapshot project '${projectId}' does not exist`);
    }
    const statements: Array<{
      sql: string;
      params: SqlValue[];
      method: "run";
    }> = [
      {
        sql: `INSERT INTO project_snapshots
                (id, project_id, name, description, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [
          snapshotId,
          projectId,
          String(payload.name),
          payload.description == null ? null : String(payload.description),
          String(payload.createdAt),
        ],
        method: "run",
      },
    ];
    for (const [table, rowsKey] of [
      ["project_snapshot_tree_nodes", "treeRows"],
      ["project_snapshot_codex_entries", "codexRows"],
      ["project_snapshot_snippets", "snippetRows"],
    ] as const) {
      const rows = payload[rowsKey] as RawRow[];
      for (const row of rows) {
        if (row.snapshot_id !== snapshotId) {
          throw new Error(
            `project snapshot ${rowsKey} row has a foreign snapshot_id`,
          );
        }
        statements.push(browserSnapshotInsertStatement(table, row));
      }
    }
    for (const versionId of payload.versionIds as string[]) {
      statements.push({
        sql: `INSERT INTO project_snapshot_entries (snapshot_id, version_id)
              VALUES (?, ?)`,
        params: [snapshotId, versionId],
        method: "run",
      });
    }
    for (const scope of AUX_SCOPES) {
      const table = AUX_TABLE[scope];
      const filter = AUX_PROJECT_FILTER[scope];
      const rows: Record<string, SqlValue>[] = (() => {
        try {
          return queryAll(
            `SELECT * FROM "${table}" WHERE ${filter.where}`,
            Array<SqlValue>(filter.binds).fill(projectId),
          );
        } catch {
          return [];
        }
      })();
      statements.push({
        sql: `INSERT INTO project_snapshot_aux
                (snapshot_id, scope, payload_json)
              VALUES (?, ?, ?)`,
        params: [snapshotId, scope, JSON.stringify({ rows })],
        method: "run",
      });
    }
    handleDbExecuteBatch({ statements });
  }

  function handleProjectSnapshotRestoreContext(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const projectId = String(args.projectId);
    const snapshotId = String(args.snapshotId);
    const scopes = new Set(args.scopes as RestoreScope[]);
    browserSnapshotOwned(projectId, snapshotId);
    const structural = Boolean(
      queryOne(
        "SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ? LIMIT 1",
        [snapshotId],
      ),
    );
    const allowedAuxScopes = new Set(
      AUX_SCOPES.filter((scope) => scopes.has(AUX_SCOPE_OWNER[scope])),
    );
    const auxRows = queryAll(
      `SELECT scope, payload_json
         FROM project_snapshot_aux
        WHERE snapshot_id = ?
        ORDER BY scope`,
      [snapshotId],
    )
      .filter((row) => allowedAuxScopes.has(String(row.scope) as AuxScope))
      .map((row) => ({
        scope: String(row.scope),
        payloadJson: String(row.payload_json),
      }));
    return {
      structural,
      liveTables: queryAll(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        [],
      ).map((row) => String(row.name)),
      treeRows: queryAll(
        "SELECT * FROM project_snapshot_tree_nodes WHERE snapshot_id = ?",
        [snapshotId],
      ),
      codexRows: queryAll(
        "SELECT * FROM project_snapshot_codex_entries WHERE snapshot_id = ?",
        [snapshotId],
      ),
      snippetRows: queryAll(
        "SELECT * FROM project_snapshot_snippets WHERE snapshot_id = ?",
        [snapshotId],
      ),
      auxRows,
      contentRows: queryAll(
        `SELECT id, content
           FROM content_versions
          WHERE id IN (
                SELECT body_version_id
                  FROM project_snapshot_tree_nodes
                 WHERE snapshot_id = ? AND body_version_id IS NOT NULL
                UNION
                SELECT body_version_id
                  FROM project_snapshot_codex_entries
                 WHERE snapshot_id = ? AND body_version_id IS NOT NULL
                UNION
                SELECT body_version_id
                  FROM project_snapshot_snippets
                 WHERE snapshot_id = ? AND body_version_id IS NOT NULL
          )`,
        [snapshotId, snapshotId, snapshotId],
      ),
      liveCodexIds: queryAll(
        "SELECT id FROM codex_entries WHERE project_id = ?",
        [projectId],
      ).map((row) => String(row.id)),
      liveCodexPhaseIds: queryAll(
        "SELECT id FROM codex_entry_phases WHERE entry_id IN (SELECT id FROM codex_entries WHERE project_id = ?)",
        [projectId],
      ).map((row) => String(row.id)),
      liveTreeNodeIds: queryAll(
        "SELECT id FROM tree_nodes WHERE project_id = ?",
        [projectId],
      ).map((row) => String(row.id)),
      liveSnippetIds: queryAll("SELECT id FROM snippets WHERE project_id = ?", [
        projectId,
      ]).map((row) => String(row.id)),
      liveEventIds: queryAll("SELECT id FROM events WHERE project_id = ?", [
        projectId,
      ]).map((row) => String(row.id)),
      liveCodexTagIds: queryAll(
        "SELECT id FROM codex_tags WHERE project_id = ?",
        [projectId],
      ).map((row) => String(row.id)),
    };
  }

  function handleProjectSnapshotApplyRestore(
    args: Record<string, unknown>,
  ): void {
    const payload = browserSnapshotPayload(
      args,
      "project_snapshot_apply_restore",
    );
    const projectId = String(payload.projectId);
    const snapshotId = String(payload.snapshotId);
    const scopes = new Set(payload.scopes as RestoreScope[]);
    browserSnapshotOwned(projectId, snapshotId);
    if (
      !queryOne(
        "SELECT 1 FROM project_snapshot_aux WHERE snapshot_id = ? LIMIT 1",
        [snapshotId],
      )
    ) {
      throw new Error("legacy project snapshots cannot use structural restore");
    }

    const restoresCalendar = (payload.inserts as Array<{ table: string }>).some(
      (insert) => insert.table === "project_calendar",
    );
    let calendarRestoreVersion: number | null = null;
    let calendarRestoreUpdatedAt: string | null = null;
    if (scopes.has("body") && restoresCalendar) {
      const liveCalendar = queryOne(
        "SELECT version FROM project_calendar WHERE project_id = ?",
        [projectId],
      );
      const snapshotCalendar = queryOne(
        `SELECT payload_json FROM project_snapshot_aux
          WHERE snapshot_id = ? AND scope = 'project_calendar'`,
        [snapshotId],
      );
      const checkedVersion = (
        value: unknown,
        source: "live" | "snapshot",
      ): number => {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0
        ) {
          throw new Error(
            `${source} project_calendar version must be a non-negative safe integer`,
          );
        }
        return value;
      };
      const liveVersion = liveCalendar
        ? checkedVersion(liveCalendar.version, "live")
        : null;
      let snapshotVersion: number | null = null;
      if (snapshotCalendar) {
        const parsed = JSON.parse(String(snapshotCalendar.payload_json)) as {
          rows?: Array<Record<string, unknown>>;
        };
        if (!Array.isArray(parsed.rows)) {
          throw new Error("project_calendar snapshot payload has no rows");
        }
        const snapshotRow = parsed.rows.find(
          (row) => row.project_id === projectId,
        );
        if (!snapshotRow) {
          throw new Error("project_calendar snapshot has no project row");
        }
        // Pre-OCC structural snapshots omit version and represent generation
        // zero. A present malformed version is rejected by checkedVersion.
        snapshotVersion =
          snapshotRow.version === undefined
            ? 0
            : checkedVersion(snapshotRow.version, "snapshot");
      }
      const baseline = Math.max(
        -1,
        ...(liveVersion === null ? [] : [liveVersion]),
        ...(snapshotVersion === null ? [] : [snapshotVersion]),
      );
      if (baseline >= Number.MAX_SAFE_INTEGER) {
        throw new Error("project_calendar version overflow during restore");
      }
      calendarRestoreVersion = baseline + 1;
      calendarRestoreUpdatedAt = new Date().toISOString();
    }

    const treePrefix = `__grimodex_snapshot_tree_${snapshotId}__`;
    const codexPrefix = `__grimodex_snapshot_codex_${snapshotId}__`;
    const statements: Array<{
      sql: string;
      params: SqlValue[];
      method: "run";
    }> = [
      {
        sql: "PRAGMA defer_foreign_keys = ON",
        params: [],
        method: "run",
      },
    ];
    const parkTree = scopes.has("body") && !scopes.has("map");
    const parkCodex = scopes.has("codex") && !scopes.has("map");
    if (parkTree) {
      statements.push({
        sql: `UPDATE map_node_positions
                 SET tree_node_id = ? || tree_node_id
               WHERE tree_node_id IS NOT NULL
                 AND board_id IN (
                     SELECT id FROM map_boards WHERE project_id = ?
                 )`,
        params: [treePrefix, projectId],
        method: "run",
      });
    }
    if (parkCodex) {
      statements.push({
        sql: `UPDATE map_node_positions
                 SET codex_entry_id = ? || codex_entry_id
               WHERE codex_entry_id IS NOT NULL
                 AND board_id IN (
                     SELECT id FROM map_boards WHERE project_id = ?
                 )`,
        params: [codexPrefix, projectId],
        method: "run",
      });
    }
    if (scopes.has("body")) {
      statements.push(
        {
          sql: "DELETE FROM tree_nodes WHERE project_id = ?",
          params: [projectId],
          method: "run",
        },
        {
          sql: "DELETE FROM plot_threads WHERE project_id = ?",
          params: [projectId],
          method: "run",
        },
      );
      if (
        queryOne(
          `SELECT 1 FROM project_snapshot_aux
            WHERE snapshot_id = ? AND scope = 'events'`,
          [snapshotId],
        )
      ) {
        statements.push({
          sql: "DELETE FROM events WHERE project_id = ?",
          params: [projectId],
          method: "run",
        });
      }
      if (
        queryOne(
          `SELECT 1 FROM project_snapshot_aux
            WHERE snapshot_id = ? AND scope = 'project_calendar'`,
          [snapshotId],
        )
      ) {
        statements.push({
          sql: "DELETE FROM project_calendar WHERE project_id = ?",
          params: [projectId],
          method: "run",
        });
      }
    }
    if (scopes.has("codex")) {
      for (const table of [
        "codex_entries",
        "codex_types",
        "codex_tags",
        "codex_detail_definitions",
      ]) {
        statements.push({
          sql: `DELETE FROM "${table}" WHERE project_id = ?`,
          params: [projectId],
          method: "run",
        });
      }
    }
    for (const [scope, table] of [
      ["snippet", "snippets"],
      ["map", "map_boards"],
      ["foreshadow", "foreshadows"],
      ["labels", "labels"],
    ] as const) {
      if (scopes.has(scope)) {
        statements.push({
          sql: `DELETE FROM "${table}" WHERE project_id = ?`,
          params: [projectId],
          method: "run",
        });
      }
    }
    if (scopes.has("lint")) {
      statements.push(
        {
          sql: `DELETE FROM lint_ignored_diagnostics
                 WHERE scene_id IN (
                     SELECT id FROM tree_nodes WHERE project_id = ?
                 )`,
          params: [projectId],
          method: "run",
        },
        {
          sql: "DELETE FROM lint_term_dictionary WHERE project_id = ?",
          params: [projectId],
          method: "run",
        },
      );
    }

    for (const insert of payload.inserts as Array<{
      table: string;
      row: RawRow;
      mode: "insert" | "replace";
    }>) {
      if (!browserSnapshotRestoreTables.has(insert.table)) {
        throw new Error(
          `project snapshot restore table '${insert.table}' is not allowed`,
        );
      }
      const owner = browserSnapshotTableOwner(insert.table);
      if (owner === null || !scopes.has(owner)) {
        throw new Error(
          `project snapshot restore table '${insert.table}' is outside the selected scopes`,
        );
      }
      if (
        insert.row.project_id !== undefined &&
        insert.row.project_id !== projectId
      ) {
        throw new Error(
          `project snapshot restore table '${insert.table}' has a foreign project_id`,
        );
      }
      if (insert.mode === "replace" && insert.table !== "codex_types") {
        throw new Error(
          "project snapshot replace mode is only valid for codex_types",
        );
      }
      const row =
        insert.table === "project_calendar"
          ? {
              ...insert.row,
              version: calendarRestoreVersion,
              updated_at: calendarRestoreUpdatedAt,
            }
          : insert.row;
      statements.push(
        browserSnapshotInsertStatement(insert.table, row, insert.mode),
      );
    }

    if (parkTree) {
      statements.push(
        {
          sql: `UPDATE map_node_positions
                   SET tree_node_id =
                       substr(tree_node_id, length(?) + 1)
                 WHERE substr(tree_node_id, 1, length(?)) = ?
                   AND board_id IN (
                       SELECT id FROM map_boards WHERE project_id = ?
                   )
                   AND EXISTS (
                       SELECT 1 FROM tree_nodes target
                        WHERE target.id =
                              substr(map_node_positions.tree_node_id, length(?) + 1)
                          AND target.project_id = ?
                   )`,
          params: [
            treePrefix,
            treePrefix,
            treePrefix,
            projectId,
            treePrefix,
            projectId,
          ],
          method: "run",
        },
        {
          sql: `DELETE FROM map_node_positions
                 WHERE substr(tree_node_id, 1, length(?)) = ?
                   AND board_id IN (
                       SELECT id FROM map_boards WHERE project_id = ?
                   )`,
          params: [treePrefix, treePrefix, projectId],
          method: "run",
        },
      );
    }
    if (parkCodex) {
      statements.push(
        {
          sql: `UPDATE map_node_positions
                   SET codex_entry_id =
                       substr(codex_entry_id, length(?) + 1)
                 WHERE substr(codex_entry_id, 1, length(?)) = ?
                   AND board_id IN (
                       SELECT id FROM map_boards WHERE project_id = ?
                   )
                   AND EXISTS (
                       SELECT 1 FROM codex_entries target
                        WHERE target.id =
                              substr(map_node_positions.codex_entry_id, length(?) + 1)
                          AND target.project_id = ?
                   )`,
          params: [
            codexPrefix,
            codexPrefix,
            codexPrefix,
            projectId,
            codexPrefix,
            projectId,
          ],
          method: "run",
        },
        {
          sql: `DELETE FROM map_node_positions
                 WHERE substr(codex_entry_id, 1, length(?)) = ?
                   AND board_id IN (
                       SELECT id FROM map_boards WHERE project_id = ?
                   )`,
          params: [codexPrefix, codexPrefix, projectId],
          method: "run",
        },
      );
    }
    handleDbExecuteBatch({ statements });
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
          "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
          [nodeId],
        );
        if (
          !currentThread ||
          !node ||
          currentThread.project_id !== node.project_id ||
          node.node_type !== "scene"
        ) {
          throw new Error(
            "plot thread link must reference a thread and scene in the same project",
          );
        }
        try {
          const semanticKey = `${threadId}|${nodeId}|${phaseType}`;
          db.run(
            `INSERT INTO plot_thread_scene_links
               (id, thread_id, node_id, phase_type, note, sort_order,
                semantic_key, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
            [id, threadId, nodeId, phaseType, note, sortOrder, semanticKey],
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
          "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
          [atNodeId],
        );
        if (
          from?.project_id !== projectId ||
          to?.project_id !== projectId ||
          node?.project_id !== projectId ||
          node?.node_type !== "scene"
        ) {
          throw new Error(
            "plot thread branch must reference a project, threads, and scene in the same project",
          );
        }
        try {
          const semanticKey = `${fromThreadId}|${toThreadId}|${atNodeId}|${kind}`;
          db.run(
            `INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                semantic_key, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
            [
              id,
              projectId,
              fromThreadId,
              toThreadId,
              atNodeId,
              kind,
              semanticKey,
            ],
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

  function browserPatchRecord(
    command: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch = args.patch;
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`${command}: patch must be an object`);
    }
    return patch as Record<string, unknown>;
  }

  function requiredBrowserBaseVersion(
    command: string,
    payload: Record<string, unknown>,
  ): number {
    const value = payload.baseVersion;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(`${command}: baseVersion must be a non-negative integer`);
    }
    return value;
  }

  function handlePlotThreadUpdate(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const command = "plot_thread_update";
    const id = requiredBrowserString(command, args, "id");
    const patch = browserPatchRecord(command, args);
    const baseVersion = requiredBrowserBaseVersion(command, patch);
    const current = queryOne("SELECT * FROM plot_threads WHERE id = ?", [id]);
    if (!current) throw new Error(`plot thread not found: ${id}`);
    if (Number(current.version) !== baseVersion) {
      throw new Error(`plot thread '${id}' version conflict during update`);
    }
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, column] of [
      ["name", "name"],
      ["color", "color"],
      ["description", "description"],
      ["sortOrder", "sort_order"],
    ] as const) {
      if (!Object.hasOwn(patch, key)) continue;
      assignments.push(`${column} = ?`);
      params.push((patch[key] ?? null) as SqlValue);
    }
    if (assignments.length === 0) return current;
    assignments.push("version = version + 1", "updated_at = ?");
    params.push(new Date().toISOString(), id, baseVersion);
    db.run(
      `UPDATE plot_threads SET ${assignments.join(", ")}
        WHERE id = ? AND version = ?`,
      params,
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(`plot thread '${id}' version conflict during update`);
    }
    const updated = queryOne("SELECT * FROM plot_threads WHERE id = ?", [id]);
    if (!updated) throw new Error(`plot thread not found: ${id}`);
    options.onDatabaseDirty?.();
    return updated;
  }

  function handlePlotThreadDelete(args: Record<string, unknown>): void {
    const command = "plot_thread_delete";
    const id = requiredBrowserString(command, args, "id");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    db.run("DELETE FROM plot_threads WHERE id = ? AND version = ?", [
      id,
      baseVersion,
    ]);
    if (db.getRowsModified() !== 1) {
      throw new Error(`PLOT_THREAD_VERSION_MISMATCH: expected ${baseVersion}`);
    }
    options.onDatabaseDirty?.();
  }

  function browserPlotSemanticKeyForUpdate(
    currentSemanticKey: SqlValue,
    nextNaturalKey: string,
  ): string {
    if (typeof currentSemanticKey !== "string") return nextNaturalKey;
    const duplicateMarker = currentSemanticKey.indexOf("#dup:");
    const currentNaturalKey =
      duplicateMarker === -1
        ? currentSemanticKey
        : currentSemanticKey.slice(0, duplicateMarker);
    return currentNaturalKey === nextNaturalKey
      ? currentSemanticKey
      : nextNaturalKey;
  }

  function handlePlotThreadLinkUpdate(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const command = "plot_thread_link_update";
    const id = requiredBrowserString(command, args, "id");
    const patch = browserPatchRecord(command, args);
    const baseVersion = requiredBrowserBaseVersion(command, patch);
    db.run("BEGIN IMMEDIATE");
    try {
      const current = queryOne(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        [id],
      );
      if (!current) {
        throw new Error(`plot thread link not found: ${id}`);
      }
      if (Number(current.version) !== baseVersion) {
        throw new Error(
          `PLOT_THREAD_LINK_VERSION_MISMATCH: expected ${baseVersion}, found ${String(current.version)}`,
        );
      }
      const owner = queryOne(
        "SELECT project_id FROM plot_threads WHERE id = ?",
        [current.thread_id as SqlValue],
      );
      if (!owner) {
        throw new Error(`plot thread link '${id}' has no owning thread`);
      }
      const ownerProjectId = String(owner.project_id);
      const threadId = Object.hasOwn(patch, "threadId")
        ? requiredBrowserString(command, patch, "threadId")
        : String(current.thread_id);
      const nodeId = Object.hasOwn(patch, "nodeId")
        ? requiredBrowserString(command, patch, "nodeId")
        : String(current.node_id);
      const phaseType = Object.hasOwn(patch, "phaseType")
        ? requiredBrowserString(command, patch, "phaseType")
        : String(current.phase_type);
      if (
        !["introduce", "develop", "turn", "climax", "resolve"].includes(
          phaseType,
        )
      ) {
        throw new Error(`invalid phase_type: ${phaseType}`);
      }
      const thread = queryOne(
        "SELECT project_id FROM plot_threads WHERE id = ?",
        [threadId],
      );
      const node = queryOne(
        "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
        [nodeId],
      );
      if (
        !thread ||
        !node ||
        thread.project_id !== ownerProjectId ||
        node.project_id !== ownerProjectId ||
        node.node_type !== "scene"
      ) {
        throw new Error(
          "plot thread link move must stay within its owning project",
        );
      }
      const assignments: string[] = [];
      const params: SqlValue[] = [];
      for (const [key, column] of [
        ["threadId", "thread_id"],
        ["nodeId", "node_id"],
        ["phaseType", "phase_type"],
        ["note", "note"],
        ["sortOrder", "sort_order"],
      ] as const) {
        if (!Object.hasOwn(patch, key)) continue;
        assignments.push(`${column} = ?`);
        params.push((patch[key] ?? null) as SqlValue);
      }
      if (assignments.length === 0) {
        db.run("COMMIT");
        return current;
      }
      assignments.push(
        "semantic_key = ?",
        "version = version + 1",
        "updated_at = ?",
      );
      const naturalSemanticKey = `${threadId}|${nodeId}|${phaseType}`;
      params.push(
        browserPlotSemanticKeyForUpdate(
          current.semantic_key,
          naturalSemanticKey,
        ),
        new Date().toISOString(),
        id,
        baseVersion,
      );
      db.run(
        `UPDATE plot_thread_scene_links SET ${assignments.join(", ")}
          WHERE id = ? AND version = ?`,
        params,
      );
      if (db.getRowsModified() !== 1) {
        throw new Error(
          `PLOT_THREAD_LINK_VERSION_MISMATCH: expected ${baseVersion}`,
        );
      }
      const updated = queryOne(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        [id],
      );
      if (!updated) throw new Error(`plot thread link not found: ${id}`);
      db.run("COMMIT");
      options.onDatabaseDirty?.();
      return updated;
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Preserve the link update failure.
      }
      throw error;
    }
  }

  function handlePlotThreadLinkDelete(args: Record<string, unknown>): void {
    const command = "plot_thread_link_delete";
    const id = requiredBrowserString(command, args, "id");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    db.run("DELETE FROM plot_thread_scene_links WHERE id = ? AND version = ?", [
      id,
      baseVersion,
    ]);
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `PLOT_THREAD_LINK_VERSION_MISMATCH: expected ${baseVersion}`,
      );
    }
    options.onDatabaseDirty?.();
  }

  function handlePlotThreadBranchUpdate(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const command = "plot_thread_branch_update";
    const id = requiredBrowserString(command, args, "id");
    const patch = browserPatchRecord(command, args);
    const baseVersion = requiredBrowserBaseVersion(command, patch);
    const current = queryOne(
      "SELECT * FROM plot_thread_branches WHERE id = ?",
      [id],
    );
    if (!current) throw new Error(`plot thread branch not found: ${id}`);
    const currentVersion = Number(current.version ?? 0);
    if (currentVersion !== baseVersion) {
      throw new Error(
        `PLOT_THREAD_BRANCH_VERSION_MISMATCH: expected ${baseVersion}, found ${currentVersion}`,
      );
    }
    const projectId = String(current.project_id);
    const fromThreadId = Object.hasOwn(patch, "fromThreadId")
      ? requiredBrowserString(command, patch, "fromThreadId")
      : String(current.from_thread_id);
    const toThreadId = Object.hasOwn(patch, "toThreadId")
      ? requiredBrowserString(command, patch, "toThreadId")
      : String(current.to_thread_id);
    const atNodeId = Object.hasOwn(patch, "atNodeId")
      ? requiredBrowserString(command, patch, "atNodeId")
      : String(current.at_node_id);
    if (fromThreadId === toThreadId) {
      throw new Error(
        "plot thread branch cannot reference the same thread twice",
      );
    }
    if (
      !Object.hasOwn(patch, "fromThreadId") &&
      !Object.hasOwn(patch, "toThreadId") &&
      !Object.hasOwn(patch, "atNodeId")
    ) {
      return current;
    }
    requireBrowserProjectMember(
      "plot_threads",
      fromThreadId,
      projectId,
      "plot thread branch source must stay in its project",
    );
    requireBrowserProjectMember(
      "plot_threads",
      toThreadId,
      projectId,
      "plot thread branch target must stay in its project",
    );
    requireBrowserPlotScene(
      atNodeId,
      projectId,
      "plot thread branch must reference a scene in its project",
    );
    const naturalSemanticKey = `${fromThreadId}|${toThreadId}|${atNodeId}|${String(current.kind)}`;
    db.run(
      `UPDATE plot_thread_branches
          SET from_thread_id = ?, to_thread_id = ?, at_node_id = ?,
              semantic_key = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?`,
      [
        fromThreadId,
        toThreadId,
        atNodeId,
        browserPlotSemanticKeyForUpdate(
          current.semantic_key,
          naturalSemanticKey,
        ),
        currentVersion + 1,
        new Date().toISOString(),
        id,
        currentVersion,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `PLOT_THREAD_BRANCH_VERSION_MISMATCH: expected ${currentVersion}`,
      );
    }
    const updated = queryOne(
      "SELECT * FROM plot_thread_branches WHERE id = ?",
      [id],
    );
    if (!updated) throw new Error(`plot thread branch not found: ${id}`);
    options.onDatabaseDirty?.();
    return updated;
  }

  function handlePlotThreadBranchDelete(args: Record<string, unknown>): void {
    const command = "plot_thread_branch_delete";
    const id = requiredBrowserString(command, args, "id");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    db.run("DELETE FROM plot_thread_branches WHERE id = ? AND version = ?", [
      id,
      baseVersion,
    ]);
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `PLOT_THREAD_BRANCH_VERSION_MISMATCH: expected ${baseVersion}`,
      );
    }
    options.onDatabaseDirty?.();
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
      version: browserPlotSnapshotVersion(command, raw, "version"),
      createdAt: requiredBrowserString(command, raw, "createdAt"),
      updatedAt: requiredBrowserString(command, raw, "updatedAt"),
    };
  }

  function browserPlotSnapshotVersion(
    command: string,
    raw: Record<string, unknown>,
    key: string,
  ): number {
    const value = raw[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(`${command}: ${key} must be a non-negative integer`);
    }
    return value;
  }

  function nextBrowserPlotSnapshotVersion(
    command: string,
    label: string,
    version: number,
  ): number {
    if (version === Number.MAX_SAFE_INTEGER) {
      throw new Error(`${command}: ${label} version overflow`);
    }
    return version + 1;
  }

  function browserPlotLinkNaturalKey(row: {
    threadId: string;
    nodeId: string;
    phaseType: string;
  }): string {
    return `${row.threadId}|${row.nodeId}|${row.phaseType}`;
  }

  function browserPlotBranchNaturalKey(row: {
    fromThreadId: string;
    toThreadId: string;
    atNodeId: string;
    kind: string;
  }): string {
    return `${row.fromThreadId}|${row.toThreadId}|${row.atNodeId}|${row.kind}`;
  }

  function browserPlotEffectiveSemanticKey(
    explicit: string | null,
    natural: string,
  ): string {
    return explicit && explicit.length > 0 ? explicit : natural;
  }

  function validateBrowserPlotSnapshotSemanticKey(
    command: string,
    label: string,
    explicit: string | null,
    natural: string,
  ): void {
    if (explicit === null || explicit.length === 0) return;
    const suffix = explicit.startsWith(natural)
      ? explicit.slice(natural.length)
      : "";
    if (
      explicit !== natural &&
      !(suffix.startsWith("#dup:") && suffix.length > 5)
    ) {
      throw new Error(
        `${command}: ${label} semanticKey does not match topology`,
      );
    }
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
      semanticKey: nullableBrowserString(command, raw, "semanticKey"),
      version: browserPlotSnapshotVersion(command, raw, "version"),
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
      semanticKey: nullableBrowserString(command, raw, "semanticKey"),
      version: browserPlotSnapshotVersion(command, raw, "version"),
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
      version: expected.version,
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
      semantic_key: browserPlotEffectiveSemanticKey(
        expected.semanticKey,
        browserPlotLinkNaturalKey(expected),
      ),
      version: expected.version,
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
      semantic_key: browserPlotEffectiveSemanticKey(
        expected.semanticKey,
        browserPlotBranchNaturalKey(expected),
      ),
      version: expected.version,
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

  function requireBrowserPlotScene(
    id: string,
    projectId: string,
    message: string,
  ): void {
    const row = queryOne(
      "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
      [id],
    );
    if (row?.project_id !== projectId || row.node_type !== "scene") {
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
    const parsedMarkerBefore = parseBrowserLinkSnapshot(
      command,
      browserSnapshotRecord(command, payload.markerBefore, "markerBefore"),
    );
    const parsedMarkerAfter = parseBrowserLinkSnapshot(
      command,
      browserSnapshotRecord(command, payload.markerAfter, "markerAfter"),
    );
    const markerBefore = {
      ...parsedMarkerBefore,
      semanticKey: browserPlotEffectiveSemanticKey(
        parsedMarkerBefore.semanticKey,
        browserPlotLinkNaturalKey(parsedMarkerBefore),
      ),
    };
    if (markerBefore.version === Number.MAX_SAFE_INTEGER) {
      throw new Error("plot marker version overflow");
    }
    const markerAfter = {
      ...parsedMarkerAfter,
      semanticKey: browserPlotEffectiveSemanticKey(
        parsedMarkerAfter.semanticKey,
        browserPlotLinkNaturalKey(parsedMarkerAfter),
      ),
      version: markerBefore.version + 1,
    };
    const parsedBranchTransitions = browserSnapshotArray(
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
    const branchTransitions = parsedBranchTransitions.map((transition) => {
      const before = transition.before
        ? {
            ...transition.before,
            semanticKey: browserPlotEffectiveSemanticKey(
              transition.before.semanticKey,
              browserPlotBranchNaturalKey(transition.before),
            ),
          }
        : null;
      if (before?.version === Number.MAX_SAFE_INTEGER) {
        throw new Error("plot branch version overflow");
      }
      const after = transition.after
        ? {
            ...transition.after,
            semanticKey: browserPlotEffectiveSemanticKey(
              transition.after.semanticKey,
              browserPlotBranchNaturalKey(transition.after),
            ),
            version:
              before === null ? transition.after.version : before.version + 1,
          }
        : null;
      return { before, after };
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
    validateBrowserPlotSnapshotSemanticKey(
      command,
      "markerBefore",
      markerBefore.semanticKey,
      browserPlotLinkNaturalKey(markerBefore),
    );
    validateBrowserPlotSnapshotSemanticKey(
      command,
      "markerAfter",
      markerAfter.semanticKey,
      browserPlotLinkNaturalKey(markerAfter),
    );
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
        validateBrowserPlotSnapshotSemanticKey(
          command,
          "branch transition",
          branch.semanticKey,
          browserPlotBranchNaturalKey(branch),
        );
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
        (transition.before.toThreadId !== markerBefore.threadId ||
          transition.before.atNodeId !== markerBefore.nodeId)
      ) {
        throw new Error(
          "plot marker move branch before snapshot must belong to the old marker anchor",
        );
      }
      if (
        transition.after !== null &&
        (transition.after.toThreadId !== markerAfter.threadId ||
          transition.after.atNodeId !== markerAfter.nodeId)
      ) {
        throw new Error(
          "plot marker move branch after snapshot must belong to the new marker anchor",
        );
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
          requireBrowserPlotScene(
            marker.nodeId,
            projectId,
            "plot marker move must reference a scene in the bundle project",
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
            requireBrowserPlotScene(
              branch.atNodeId,
              projectId,
              "plot marker move branch must reference a scene in the bundle project",
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
        if (
          markerBefore.threadId !== markerAfter.threadId ||
          markerBefore.nodeId !== markerAfter.nodeId
        ) {
          const otherAnchorCount = Number(
            queryOne(
              `SELECT COUNT(*) AS count FROM plot_thread_scene_links
                WHERE id <> ? AND thread_id = ? AND node_id = ?`,
              [markerBefore.id, markerBefore.threadId, markerBefore.nodeId],
            )?.count ?? 0,
          );
          const currentDependencyIds =
            otherAnchorCount > 0
              ? []
              : queryAll(
                  `SELECT id FROM plot_thread_branches
                    WHERE to_thread_id = ? AND at_node_id = ?
                    ORDER BY id`,
                  [markerBefore.threadId, markerBefore.nodeId],
                ).map((row) => String(row.id));
          const snapshotDependencyIds = branchTransitions
            .flatMap((transition) =>
              transition.before === null ? [] : [transition.before.id],
            )
            .sort();
          if (
            currentDependencyIds.join("\u0000") !==
            snapshotDependencyIds.join("\u0000")
          ) {
            throw new Error(
              "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker branch dependencies changed since snapshot",
            );
          }
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
                  sort_order = ?, semantic_key = ?, version = ?,
                  created_at = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
          [
            markerAfter.threadId,
            markerAfter.nodeId,
            markerAfter.phaseType,
            markerAfter.note,
            markerAfter.sortOrder,
            markerAfter.semanticKey,
            markerAfter.version,
            markerAfter.createdAt,
            markerAfter.updatedAt,
            markerAfter.id,
            markerBefore.version,
          ],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(
            "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker version changed",
          );
        }
        for (const transition of branchTransitions) {
          if (transition.before === null && transition.after !== null) {
            const branch = transition.after;
            db.run(
              `INSERT INTO plot_thread_branches
                 (id, project_id, from_thread_id, to_thread_id, at_node_id,
                  kind, semantic_key, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                branch.id,
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                branch.semanticKey,
                branch.version,
                branch.createdAt,
                branch.updatedAt,
              ],
            );
          } else if (transition.before !== null && transition.after !== null) {
            const branch = transition.after;
            db.run(
              `UPDATE plot_thread_branches
                  SET project_id = ?, from_thread_id = ?, to_thread_id = ?,
                      at_node_id = ?, kind = ?, semantic_key = ?, version = ?,
                      created_at = ?, updated_at = ?
                WHERE id = ? AND version = ?`,
              [
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                branch.semanticKey,
                branch.version,
                branch.createdAt,
                branch.updatedAt,
                branch.id,
                transition.before.version,
              ],
            );
            if (db.getRowsModified() !== 1) {
              throw new Error(
                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch version changed",
              );
            }
          } else if (transition.before !== null && transition.after === null) {
            db.run(
              "DELETE FROM plot_thread_branches WHERE id = ? AND version = ?",
              [transition.before.id, transition.before.version],
            );
            if (db.getRowsModified() !== 1) {
              throw new Error(
                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch version changed",
              );
            }
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
    const sourceThread =
      rawThread === null || rawThread === undefined
        ? null
        : parseBrowserThreadSnapshot(
            command,
            browserSnapshotRecord(command, rawThread, "thread"),
          );
    const sourceLinks = browserSnapshotArray(command, payload, "links").map(
      (row) => parseBrowserLinkSnapshot(command, row),
    );
    const sourceBranches = browserSnapshotArray(
      command,
      payload,
      "branches",
    ).map((row) => parseBrowserBranchSnapshot(command, row));
    if (
      sourceThread === null &&
      sourceLinks.length === 0 &&
      sourceBranches.length === 0
    ) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot must contain at least one row",
      );
    }
    if (new Set(sourceLinks.map((row) => row.id)).size !== sourceLinks.length) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot contains duplicate link ids",
      );
    }
    if (
      new Set(sourceBranches.map((row) => row.id)).size !==
      sourceBranches.length
    ) {
      throw new Error(
        "plot_thread_restore_snapshot: snapshot contains duplicate branch ids",
      );
    }
    for (const link of sourceLinks) {
      validateBrowserPlotSnapshotSemanticKey(
        command,
        "link",
        link.semanticKey,
        browserPlotLinkNaturalKey(link),
      );
    }
    for (const branch of sourceBranches) {
      validateBrowserPlotSnapshotSemanticKey(
        command,
        "branch",
        branch.semanticKey,
        browserPlotBranchNaturalKey(branch),
      );
    }
    const thread =
      sourceThread === null
        ? null
        : {
            ...sourceThread,
            version: nextBrowserPlotSnapshotVersion(
              command,
              "thread",
              sourceThread.version,
            ),
          };
    const links = sourceLinks.map((link) => ({
      ...link,
      version: nextBrowserPlotSnapshotVersion(
        command,
        `link '${link.id}'`,
        link.version,
      ),
    }));
    const branches = sourceBranches.map((branch) => ({
      ...branch,
      version: nextBrowserPlotSnapshotVersion(
        command,
        `branch '${branch.id}'`,
        branch.version,
      ),
    }));
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
      fingerprintPayload: {
        projectId,
        thread: sourceThread,
        links: sourceLinks,
        branches: sourceBranches,
      },
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
              requireBrowserPlotScene(
                nodeId,
                projectId,
                "plot restore thread boundary must reference a scene in the snapshot project",
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
                  start_node_id, end_node_id, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                thread.id,
                thread.projectId,
                thread.name,
                thread.color,
                thread.description,
                thread.sortOrder,
                thread.startNodeId,
                thread.endNodeId,
                thread.version,
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
          requireBrowserPlotScene(
            link.nodeId,
            projectId,
            "plot restore link must reference a scene in the snapshot project",
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
                  semantic_key, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                link.id,
                link.threadId,
                link.nodeId,
                link.phaseType,
                link.note,
                link.sortOrder,
                browserPlotEffectiveSemanticKey(
                  link.semanticKey,
                  browserPlotLinkNaturalKey(link),
                ),
                link.version,
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
          requireBrowserPlotScene(
            branch.atNodeId,
            projectId,
            "plot restore branch must reference a scene in the snapshot project",
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
                  semantic_key, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                branch.id,
                branch.projectId,
                branch.fromThreadId,
                branch.toThreadId,
                branch.atNodeId,
                branch.kind,
                browserPlotEffectiveSemanticKey(
                  branch.semanticKey,
                  browserPlotBranchNaturalKey(branch),
                ),
                branch.version,
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
    const rawThread = payload.thread;
    const rawLink = payload.link;
    const thread =
      rawThread === null || rawThread === undefined
        ? null
        : parseBrowserThreadSnapshot(
            command,
            browserSnapshotRecord(command, rawThread, "thread"),
          );
    const link =
      rawLink === null || rawLink === undefined
        ? null
        : parseBrowserLinkSnapshot(
            command,
            browserSnapshotRecord(command, rawLink, "link"),
          );
    if ((thread === null) === (link === null)) {
      throw new Error(
        `${command}: exactly one of thread and link must be provided`,
      );
    }
    if (!Array.isArray(payload.branches)) {
      throw new Error(`${command}: branches must be an array`);
    }
    const links = browserSnapshotArray(command, payload, "links").map((row) =>
      parseBrowserLinkSnapshot(command, row),
    );
    const branches = browserSnapshotArray(command, payload, "branches").map(
      (row) => parseBrowserBranchSnapshot(command, row),
    );
    if (thread === null && links.length > 0) {
      throw new Error(`${command}: marker snapshot must not contain links`);
    }
    if (new Set(links.map((row) => row.id)).size !== links.length) {
      throw new Error(`${command}: links contains duplicate ids`);
    }
    if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
      throw new Error(`${command}: branches contains duplicate ids`);
    }
    for (const childLink of link === null ? links : [link]) {
      validateBrowserPlotSnapshotSemanticKey(
        command,
        "link",
        childLink.semanticKey,
        browserPlotLinkNaturalKey(childLink),
      );
    }
    for (const branch of branches) {
      validateBrowserPlotSnapshotSemanticKey(
        command,
        "branch",
        branch.semanticKey,
        browserPlotBranchNaturalKey(branch),
      );
    }
    const loadEntity = (): Record<string, SqlValue> | null => {
      if (thread !== null) {
        if (queryOne("SELECT id FROM plot_threads WHERE id = ?", [thread.id])) {
          return null;
        }
        if (
          links.some((childLink) =>
            queryOne("SELECT id FROM plot_thread_scene_links WHERE id = ?", [
              childLink.id,
            ]),
          ) ||
          branches.some((branch) =>
            queryOne("SELECT id FROM plot_thread_branches WHERE id = ?", [
              branch.id,
            ]),
          )
        ) {
          return null;
        }
        return { id: requestId, deleted: 1 };
      }
      if (link === null) return null;
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
      fingerprintPayload: { projectId, thread, link, links, branches },
      conflictMarker: "PLOT_THREAD_DELETE_IDEMPOTENCY_CONFLICT",
      loadEntity,
      createEntity: () => {
        if (!queryOne("SELECT id FROM projects WHERE id = ?", [projectId])) {
          throw new Error("plot snapshot project does not exist");
        }
        if (thread !== null) {
          if (thread.projectId !== projectId) {
            throw new Error(
              "plot delete snapshot thread must belong to the snapshot project",
            );
          }
          for (const nodeId of [thread.startNodeId, thread.endNodeId]) {
            if (nodeId !== null) {
              requireBrowserPlotScene(
                nodeId,
                projectId,
                "plot delete snapshot thread boundary must reference a scene in the snapshot project",
              );
            }
          }
          const currentThread = queryOne(
            "SELECT * FROM plot_threads WHERE id = ?",
            [thread.id],
          );
          if (!currentThread) {
            throw new Error("plot delete snapshot thread does not exist");
          }
          if (!browserThreadSnapshotMatches(currentThread, thread)) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread changed since snapshot",
            );
          }

          const currentLinks = queryAll(
            `SELECT * FROM plot_thread_scene_links
              WHERE thread_id = ? ORDER BY id`,
            [thread.id],
          );
          const currentLinkIds = currentLinks.map((row) => String(row.id));
          const snapshotLinkIds = links.map((row) => row.id).sort();
          if (
            currentLinkIds.join("\u0000") !== snapshotLinkIds.join("\u0000")
          ) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: owned links changed since snapshot",
            );
          }
          const currentLinksById = new Map(
            currentLinks.map((row) => [String(row.id), row] as const),
          );
          for (const childLink of links) {
            if (
              !["introduce", "develop", "turn", "climax", "resolve"].includes(
                childLink.phaseType,
              )
            ) {
              throw new Error(`invalid phase_type: ${childLink.phaseType}`);
            }
            if (childLink.threadId !== thread.id) {
              throw new Error(
                "plot delete snapshot owned link must belong to the deleted thread",
              );
            }
            requireBrowserPlotScene(
              childLink.nodeId,
              projectId,
              "plot delete snapshot owned link must reference a scene in the snapshot project",
            );
            const currentChildLink = currentLinksById.get(childLink.id);
            if (
              !currentChildLink ||
              !browserLinkSnapshotMatches(currentChildLink, childLink)
            ) {
              throw new Error(
                "PLOT_THREAD_DELETE_PRECONDITION_FAILED: owned link changed since snapshot",
              );
            }
          }

          const currentBranches = queryAll(
            `SELECT * FROM plot_thread_branches
              WHERE from_thread_id = ? OR to_thread_id = ?
              ORDER BY id`,
            [thread.id, thread.id],
          );
          const currentBranchIds = currentBranches.map((row) => String(row.id));
          const snapshotBranchIds = branches.map((row) => row.id).sort();
          if (
            currentBranchIds.join("\u0000") !== snapshotBranchIds.join("\u0000")
          ) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: related branches changed since snapshot",
            );
          }
          const currentBranchesById = new Map(
            currentBranches.map((row) => [String(row.id), row] as const),
          );
          for (const branch of branches) {
            if (!["branch", "merge"].includes(branch.kind)) {
              throw new Error(`invalid plot branch kind: ${branch.kind}`);
            }
            if (
              branch.projectId !== projectId ||
              (branch.fromThreadId !== thread.id &&
                branch.toThreadId !== thread.id)
            ) {
              throw new Error(
                "plot delete snapshot related branch must belong to the deleted thread and project",
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
            requireBrowserPlotScene(
              branch.atNodeId,
              projectId,
              "plot delete snapshot branch must reference a scene in the snapshot project",
            );
            const currentBranch = currentBranchesById.get(branch.id);
            if (
              !currentBranch ||
              !browserBranchSnapshotMatches(currentBranch, branch)
            ) {
              throw new Error(
                "PLOT_THREAD_DELETE_PRECONDITION_FAILED: related branch changed since snapshot",
              );
            }
          }

          db.run("DELETE FROM plot_threads WHERE id = ? AND version = ?", [
            thread.id,
            thread.version,
          ]);
          if (db.getRowsModified() !== 1) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread version changed",
            );
          }
          return { id: requestId, deleted: 1 };
        }
        if (link === null) {
          throw new Error("plot delete snapshot is missing its target");
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
        requireBrowserPlotScene(
          link.nodeId,
          projectId,
          "plot delete snapshot link must reference a scene in the snapshot project",
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
          requireBrowserPlotScene(
            branch.atNodeId,
            projectId,
            "plot delete snapshot branch must reference a scene in the snapshot project",
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
          db.run(
            "DELETE FROM plot_thread_branches WHERE id = ? AND version = ?",
            [branch.id, branch.version],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(
              "PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch version changed",
            );
          }
        }
        db.run(
          "DELETE FROM plot_thread_scene_links WHERE id = ? AND version = ?",
          [link.id, link.version],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(
            "PLOT_THREAD_DELETE_PRECONDITION_FAILED: link version changed",
          );
        }
        return { id: requestId, deleted: 1 };
      },
    });
  }

  function requireBrowserForeshadowPayoffScene(
    sceneId: string,
    projectId: string,
  ): void {
    const scene = queryOne(
      `SELECT 1 AS valid
         FROM tree_nodes
        WHERE id = ?
          AND project_id = ?
          AND node_type = 'scene'`,
      [sceneId, projectId],
    );
    if (!scene) {
      throw new Error(
        "foreshadow payoff scene must reference an existing same project scene",
      );
    }
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
          requireBrowserForeshadowPayoffScene(payoffSceneId, projectId);
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

  function requireBrowserForeshadowStrength(
    command: string,
    value: unknown,
  ): string | null {
    if (value === null || value === undefined) return null;
    if (
      typeof value !== "string" ||
      !["subtle", "moderate", "overt"].includes(value)
    ) {
      throw new Error(`${command}: invalid setup strength`);
    }
    return value;
  }

  function browserForeshadowSetupSemanticKey(
    setupId: string,
    foreshadowId: string,
    sceneId: string,
    fromPos: number,
    toPos: number,
    existingSemanticKey?: SqlValue,
  ): string {
    const base = `${foreshadowId}|${sceneId}|${fromPos}|${toPos}`;
    const duplicateSuffix = `#dup:${setupId}`;
    return typeof existingSemanticKey === "string" &&
      existingSemanticKey.endsWith(duplicateSuffix)
      ? `${base}${duplicateSuffix}`
      : base;
  }

  function handleForeshadowUpdate(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const command = "foreshadow_update";
    const id = requiredBrowserString(command, args, "id");
    const patch = browserPatchRecord(command, args);
    if (
      typeof patch.baseVersion !== "number" ||
      !Number.isSafeInteger(patch.baseVersion) ||
      patch.baseVersion < 0
    ) {
      throw new Error(`${command}: baseVersion must be a non-negative integer`);
    }
    for (const key of ["payoffConfirmed", "abandoned", "secret"] as const) {
      if (Object.hasOwn(patch, key) && typeof patch[key] !== "boolean") {
        throw new Error(`${command}: ${key} must be a boolean`);
      }
    }
    for (const key of [
      "title",
      "intent",
      "notes",
      "payoffSceneId",
      "loadBearing",
    ] as const) {
      if (
        Object.hasOwn(patch, key) &&
        patch[key] !== null &&
        typeof patch[key] !== "string"
      ) {
        throw new Error(`${command}: ${key} must be a string or null`);
      }
    }
    for (const key of ["payoffFromPos", "payoffToPos"] as const) {
      if (
        Object.hasOwn(patch, key) &&
        patch[key] !== null &&
        (typeof patch[key] !== "number" || !Number.isSafeInteger(patch[key]))
      ) {
        throw new Error(`${command}: ${key} must be an integer or null`);
      }
    }
    const current = queryOne("SELECT * FROM foreshadows WHERE id = ?", [id]);
    if (!current) {
      throw new Error("FORESHADOW_VERSION_MISMATCH: row missing");
    }
    const currentVersion = Number(current.version ?? 0);
    const baseVersion = patch.baseVersion;
    if (baseVersion !== currentVersion) {
      throw new Error(
        `foreshadow version conflict: expected ${baseVersion}, found ${currentVersion}`,
      );
    }
    if (
      Object.hasOwn(patch, "loadBearing") &&
      patch.loadBearing !== null &&
      !["critical", "supporting", "optional"].includes(
        String(patch.loadBearing),
      )
    ) {
      throw new Error(
        `invalid load_bearing value: ${String(patch.loadBearing)}`,
      );
    }
    const projectId = String(current.project_id);
    const payoffSceneId = Object.hasOwn(patch, "payoffSceneId")
      ? patch.payoffSceneId == null
        ? null
        : String(patch.payoffSceneId)
      : current.payoff_scene_id == null
        ? null
        : String(current.payoff_scene_id);
    const payoffFromPos = Object.hasOwn(patch, "payoffFromPos")
      ? patch.payoffFromPos == null
        ? null
        : Number(patch.payoffFromPos)
      : current.payoff_from_pos == null
        ? null
        : Number(current.payoff_from_pos);
    const payoffToPos = Object.hasOwn(patch, "payoffToPos")
      ? patch.payoffToPos == null
        ? null
        : Number(patch.payoffToPos)
      : current.payoff_to_pos == null
        ? null
        : Number(current.payoff_to_pos);
    if (payoffSceneId !== null) {
      requireBrowserForeshadowPayoffScene(payoffSceneId, projectId);
    }
    if (
      payoffSceneId === null
        ? payoffFromPos !== null || payoffToPos !== null
        : !(
            (payoffFromPos === null && payoffToPos === null) ||
            (payoffFromPos !== null &&
              payoffToPos !== null &&
              Number.isSafeInteger(payoffFromPos) &&
              Number.isSafeInteger(payoffToPos) &&
              0 <= payoffFromPos &&
              payoffFromPos <= payoffToPos)
          )
    ) {
      throw new Error("foreshadow payoff anchor is invalid");
    }

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, column] of [
      ["title", "title"],
      ["intent", "intent"],
      ["notes", "notes"],
      ["payoffSceneId", "payoff_scene_id"],
      ["payoffFromPos", "payoff_from_pos"],
      ["payoffToPos", "payoff_to_pos"],
      ["payoffConfirmed", "payoff_confirmed"],
      ["abandoned", "abandoned"],
      ["secret", "secret"],
      ["loadBearing", "load_bearing"],
    ] as const) {
      if (!Object.hasOwn(patch, key)) continue;
      assignments.push(`${column} = ?`);
      const value = patch[key];
      params.push(
        typeof value === "boolean"
          ? value
            ? 1
            : 0
          : ((value ?? null) as SqlValue),
      );
    }
    if (assignments.length === 0) return current;
    assignments.push("version = version + 1", "updated_at = ?");
    params.push(Date.now(), id, currentVersion);
    db.run(
      `UPDATE foreshadows SET ${assignments.join(", ")}
        WHERE id = ? AND version = ?`,
      params,
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(
        `foreshadow version conflict: expected ${currentVersion}`,
      );
    }
    const updated = queryOne("SELECT * FROM foreshadows WHERE id = ?", [id]);
    if (!updated) throw new Error(`foreshadow not found: ${id}`);
    options.onDatabaseDirty?.();
    return updated;
  }

  async function handleForeshadowDelete(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "foreshadow_delete";
    const id = requiredBrowserString(command, args, "id");
    const projectId = requiredBrowserString(command, args, "projectId");
    const sessionId = requiredBrowserString(command, args, "sessionId");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    return withAppendLedgerLock(async () => {
      const captured = loadBrowserForeshadowAggregateSnapshot(id, projectId);
      if (!captured) {
        throw new Error("FORESHADOW_VERSION_MISMATCH: row missing");
      }
      if (captured.version !== baseVersion) {
        throw new Error(
          `FORESHADOW_VERSION_MISMATCH: expected ${baseVersion}, found ${captured.version}`,
        );
      }
      const eventUid = crypto.randomUUID();
      const undoJournalId = crypto.randomUUID();
      const timestamp = Date.now();
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "foreshadow",
        opType: "foreshadow.delete",
        entityType: "foreshadow",
        entityId: id,
        payload: JSON.stringify({ baseVersion }),
        sessionId,
        timestamp,
      });
      db.run("BEGIN IMMEDIATE");
      try {
        const current = loadBrowserForeshadowAggregateSnapshot(id, projectId);
        if (!current || current.version !== baseVersion) {
          throw new Error(
            `FORESHADOW_VERSION_MISMATCH: expected ${baseVersion}`,
          );
        }
        ensureBrowserForeshadowAggregateValid(current, projectId, id);
        db.run(
          "DELETE FROM foreshadows WHERE id = ? AND project_id = ? AND version = ?",
          [id, projectId, baseVersion],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(
            `FORESHADOW_VERSION_MISMATCH: expected ${baseVersion}`,
          );
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind,
             before_json, after_json, base_version, result_version,
             change_event_uid, created_at)
           VALUES (?, ?, 'manual', 'foreshadow', ?, 'delete', ?, NULL, ?, ?, ?, ?)`,
          [
            undoJournalId,
            projectId,
            id,
            JSON.stringify(current),
            current.version,
            current.version,
            eventUid,
            new Date(timestamp).toISOString(),
          ],
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: id,
          projectId,
          version: current.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original delete conflict/failure.
        }
        throw error;
      }
    });
  }

  function handleForeshadowGetSetup(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const command = "foreshadow_get_setup";
    const setupId = requiredBrowserString(command, args, "setupId");
    return queryOne("SELECT * FROM foreshadow_setups WHERE id = ?", [setupId]);
  }

  function finishBrowserForeshadowChildWrite(
    foreshadowId: string,
    changed: boolean,
    baseVersion: number,
    now: number,
  ): Record<string, SqlValue> | null {
    const current = queryOne("SELECT * FROM foreshadows WHERE id = ?", [
      foreshadowId,
    ]);
    if (!current) return null;
    if (changed) {
      const currentVersion = Number(current.version ?? 0);
      if (currentVersion !== baseVersion) {
        throw new Error(
          `FORESHADOW_VERSION_MISMATCH: expected ${baseVersion}, found ${currentVersion}`,
        );
      }
      db.run(
        `UPDATE foreshadows
            SET version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        [now, foreshadowId, baseVersion],
      );
      if (db.getRowsModified() !== 1) {
        throw new Error(`FORESHADOW_VERSION_MISMATCH: expected ${baseVersion}`);
      }
    }
    return queryOne("SELECT * FROM foreshadows WHERE id = ?", [foreshadowId]);
  }

  function runBrowserForeshadowChildWrite<T>(
    operation: () => { value: T; changed: boolean },
  ): T {
    db.run("BEGIN IMMEDIATE");
    try {
      const { value, changed } = operation();
      db.run("COMMIT");
      if (changed) options.onDatabaseDirty?.();
      return value;
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Preserve the original child-write conflict/failure.
      }
      throw error;
    }
  }

  function handleForeshadowUpdateSetup(
    args: Record<string, unknown>,
  ): Record<string, SqlValue> | null {
    const command = "foreshadow_update_setup";
    const id = requiredBrowserString(command, args, "id");
    const patch = browserPatchRecord(command, args);
    const baseVersion = requiredBrowserBaseVersion(command, patch);
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const valuesByColumn = new Map<string, SqlValue>();
    for (const [key, column] of [
      ["strength", "strength"],
      ["aiStrength", "ai_strength"],
      ["aiReasoning", "ai_reasoning"],
      ["isOrphan", "is_orphan"],
      ["lastEvaluatedAt", "last_evaluated_at"],
    ] as const) {
      if (!Object.hasOwn(patch, key)) continue;
      if (key === "strength" || key === "aiStrength") {
        requireBrowserForeshadowStrength(command, patch[key]);
      }
      assignments.push(`${column} = ?`);
      const value = patch[key];
      params.push(
        typeof value === "boolean"
          ? value
            ? 1
            : 0
          : ((value ?? null) as SqlValue),
      );
      valuesByColumn.set(column, params.at(-1) ?? null);
    }
    return runBrowserForeshadowChildWrite(() => {
      const current = queryOne("SELECT * FROM foreshadow_setups WHERE id = ?", [
        id,
      ]);
      if (!current) return { value: null, changed: false };
      const changed = [...valuesByColumn].some(
        ([column, value]) => current[column] !== value,
      );
      const now = Date.now();
      if (changed && assignments.length > 0) {
        assignments.push("updated_at = ?");
        params.push(now, id);
        db.run(
          `UPDATE foreshadow_setups SET ${assignments.join(", ")} WHERE id = ?`,
          params,
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(`foreshadow setup '${id}' vanished during update`);
        }
      }
      const row = finishBrowserForeshadowChildWrite(
        String(current.foreshadow_id),
        changed,
        baseVersion,
        now,
      );
      return { value: row, changed };
    });
  }

  function handleForeshadowSetupCreateAi(
    args: Record<string, unknown>,
  ): Record<string, SqlValue> | null {
    const command = "foreshadow_setup_create_ai";
    const id = requiredBrowserString(command, args, "id");
    const foreshadowId = requiredBrowserString(command, args, "foreshadowId");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    const sceneId = requiredBrowserString(command, args, "sceneId");
    const fromPos = Number(args.fromPos);
    const toPos = Number(args.toPos);
    if (
      !Number.isSafeInteger(fromPos) ||
      !Number.isSafeInteger(toPos) ||
      fromPos < 0 ||
      fromPos > toPos
    ) {
      throw new Error(`${command}: invalid setup range`);
    }
    const owner = queryOne("SELECT project_id FROM foreshadows WHERE id = ?", [
      foreshadowId,
    ]);
    const scene = queryOne(
      "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
      [sceneId],
    );
    if (
      !owner ||
      !scene ||
      scene.node_type !== "scene" ||
      owner.project_id !== scene.project_id
    ) {
      throw new Error("foreshadow setup must stay within one project");
    }
    const existing = queryOne(
      `SELECT foreshadow_id, scene_id, semantic_key, from_pos, to_pos, is_orphan
         FROM foreshadow_setups WHERE id = ?`,
      [id],
    );
    if (
      existing &&
      (String(existing.foreshadow_id) !== foreshadowId ||
        String(existing.scene_id) !== sceneId)
    ) {
      throw new Error(
        `foreshadow setup '${id}' owner or scene conflicts with the existing row`,
      );
    }
    const strength = requireBrowserForeshadowStrength(command, args.strength);
    const aiStrength = requireBrowserForeshadowStrength(
      command,
      args.aiStrength,
    );
    const now = Date.now();
    const semanticKey = browserForeshadowSetupSemanticKey(
      id,
      foreshadowId,
      sceneId,
      fromPos,
      toPos,
      existing?.semantic_key,
    );
    const changed =
      !existing ||
      Number(existing.from_pos) !== fromPos ||
      Number(existing.to_pos) !== toPos ||
      String(existing.semantic_key) !== semanticKey ||
      Number(existing.is_orphan) !== 0;
    return runBrowserForeshadowChildWrite(() => {
      if (changed) {
        db.run(
          `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
         ai_strength, attribution, ai_rationale, ai_reasoning,
         last_evaluated_at, is_orphan, semantic_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_pos = excluded.from_pos,
         to_pos = excluded.to_pos,
         semantic_key = excluded.semantic_key,
         is_orphan = 0,
         updated_at = excluded.updated_at`,
          [
            id,
            foreshadowId,
            sceneId,
            fromPos,
            toPos,
            String(args.kind ?? "designated_existing"),
            strength,
            aiStrength,
            String(args.attribution ?? "human"),
            args.aiRationale == null ? null : String(args.aiRationale),
            args.aiReasoning == null ? null : String(args.aiReasoning),
            args.lastEvaluatedAt == null ? null : Number(args.lastEvaluatedAt),
            semanticKey,
            now,
            now,
          ],
        );
      }
      const row = finishBrowserForeshadowChildWrite(
        foreshadowId,
        changed,
        baseVersion,
        now,
      );
      return { value: row, changed };
    });
  }

  function handleForeshadowLinkCodex(
    args: Record<string, unknown>,
    linked: boolean,
  ): Record<string, SqlValue> | null {
    const command = linked
      ? "foreshadow_link_codex"
      : "foreshadow_unlink_codex";
    const foreshadowId = requiredBrowserString(command, args, "foreshadowId");
    const codexId = requiredBrowserString(command, args, "codexId");
    const baseVersion = requiredBrowserBaseVersion(command, args);
    if (linked) {
      const foreshadow = queryOne(
        "SELECT project_id FROM foreshadows WHERE id = ?",
        [foreshadowId],
      );
      const codex = queryOne(
        "SELECT project_id FROM codex_entries WHERE id = ?",
        [codexId],
      );
      if (!foreshadow || !codex || foreshadow.project_id !== codex.project_id) {
        throw new Error("foreshadow Codex link must stay within one project");
      }
    }
    return runBrowserForeshadowChildWrite(() => {
      if (linked) {
        db.run(
          `INSERT OR IGNORE INTO foreshadow_codex_links
            (foreshadow_id, codex_entry_id) VALUES (?, ?)`,
          [foreshadowId, codexId],
        );
      } else {
        db.run(
          `DELETE FROM foreshadow_codex_links
            WHERE foreshadow_id = ? AND codex_entry_id = ?`,
          [foreshadowId, codexId],
        );
      }
      const changed = db.getRowsModified() === 1;
      const row = finishBrowserForeshadowChildWrite(
        foreshadowId,
        changed,
        baseVersion,
        Date.now(),
      );
      return { value: row, changed };
    });
  }

  function handleForeshadowMarkLinkedCodexDirty(
    args: Record<string, unknown>,
  ): Record<string, SqlValue>[] {
    const command = "foreshadow_mark_linked_codex_dirty";
    const projectId = requiredBrowserString(command, args, "projectId");
    const codexEntryId = requiredBrowserString(command, args, "codexEntryId");
    const now = Date.now();
    db.run("BEGIN IMMEDIATE");
    try {
      db.run(
        `UPDATE foreshadows
          SET codex_link_dirty_at = ?, updated_at = ?, version = version + 1
        WHERE project_id = ?
          AND id IN (
            SELECT foreshadow_id FROM foreshadow_codex_links
             WHERE codex_entry_id = ?
          )`,
        [now, now, projectId, codexEntryId],
      );
      const mutated = db.getRowsModified() > 0;
      const rows = queryAll(
        `SELECT foreshadow.*
           FROM foreshadows foreshadow
           JOIN foreshadow_codex_links link
             ON link.foreshadow_id = foreshadow.id
          WHERE foreshadow.project_id = ? AND link.codex_entry_id = ?
          ORDER BY foreshadow.id`,
        [projectId, codexEntryId],
      );
      db.run("COMMIT");
      if (mutated) options.onDatabaseDirty?.();
      return rows;
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Preserve the dirty-mark failure.
      }
      throw error;
    }
  }

  function handleForeshadowSetSetupStrength(
    args: Record<string, unknown>,
  ): Record<string, SqlValue> | null {
    const command = "foreshadow_set_setup_strength";
    const setupId = requiredBrowserString(command, args, "setupId");
    const strength = requireBrowserForeshadowStrength(command, args.strength);
    const baseVersion = requiredBrowserBaseVersion(command, args);
    return runBrowserForeshadowChildWrite(() => {
      const current = queryOne("SELECT * FROM foreshadow_setups WHERE id = ?", [
        setupId,
      ]);
      if (!current) return { value: null, changed: false };
      const changed = current.strength !== strength;
      const now = Date.now();
      if (changed) {
        db.run(
          "UPDATE foreshadow_setups SET strength = ?, updated_at = ? WHERE id = ?",
          [strength, now, setupId],
        );
      }
      const row = finishBrowserForeshadowChildWrite(
        String(current.foreshadow_id),
        changed,
        baseVersion,
        now,
      );
      return { value: row, changed };
    });
  }

  function handleForeshadowResolveOrphan(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const command = "foreshadow_resolve_orphan";
    const payload = browserCommandPayload(command, args);
    const setupId = requiredBrowserString(command, payload, "setupId");
    const action = requiredBrowserString(command, payload, "action");
    const baseVersion = requiredBrowserBaseVersion(command, payload);
    if (action === "delete") {
      return runBrowserForeshadowChildWrite(() => {
        const current = queryOne(
          "SELECT foreshadow_id FROM foreshadow_setups WHERE id = ?",
          [setupId],
        );
        if (!current) {
          return {
            value: { setupId: null, foreshadow: null },
            changed: false,
          };
        }
        db.run("DELETE FROM foreshadow_setups WHERE id = ?", [setupId]);
        const changed = db.getRowsModified() === 1;
        const foreshadow = finishBrowserForeshadowChildWrite(
          String(current.foreshadow_id),
          changed,
          baseVersion,
          Date.now(),
        );
        return {
          value: { setupId: null, foreshadow },
          changed,
        };
      });
    }
    if (action !== "reanchor" && action !== "reinsert") {
      return { setupId: null, foreshadow: null };
    }
    const sceneId = requiredBrowserString(command, payload, "sceneId");
    const fromPos = Number(payload.fromPos);
    const toPos = Number(payload.toPos);
    if (
      !Number.isSafeInteger(fromPos) ||
      !Number.isSafeInteger(toPos) ||
      fromPos < 0 ||
      fromPos > toPos
    ) {
      throw new Error(`${command}: invalid anchor range`);
    }
    if (action === "reinsert") {
      const newId = crypto.randomUUID();
      db.run("BEGIN IMMEDIATE");
      try {
        const current = queryOne(
          `SELECT setup.*, foreshadow.project_id
             FROM foreshadow_setups setup
             JOIN foreshadows foreshadow ON foreshadow.id = setup.foreshadow_id
            WHERE setup.id = ?`,
          [setupId],
        );
        if (!current) {
          db.run("COMMIT");
          return { setupId: null, foreshadow: null };
        }
        const scene = queryOne(
          "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
          [sceneId],
        );
        if (
          scene?.node_type !== "scene" ||
          scene.project_id !== current.project_id
        ) {
          throw new Error(
            "foreshadow orphan anchor must stay within one project",
          );
        }
        const now = Date.now();
        const semanticKey = browserForeshadowSetupSemanticKey(
          newId,
          String(current.foreshadow_id),
          sceneId,
          fromPos,
          toPos,
        );
        db.run("DELETE FROM foreshadow_setups WHERE id = ?", [setupId]);
        if (db.getRowsModified() !== 1) {
          throw new Error(
            `foreshadow setup '${setupId}' vanished during reinsert`,
          );
        }
        db.run(
          `INSERT INTO foreshadow_setups
            (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role,
             strength, ai_strength, ai_reasoning, attribution, ai_rationale,
             last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'inserted_new', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          [
            newId,
            current.foreshadow_id,
            sceneId,
            fromPos,
            toPos,
            current.role,
            current.strength,
            current.ai_strength,
            current.ai_reasoning,
            current.attribution,
            current.ai_rationale,
            current.last_evaluated_at,
            current.evidence_anchor_id,
            semanticKey,
            now,
            now,
          ],
        );
        const foreshadow = finishBrowserForeshadowChildWrite(
          String(current.foreshadow_id),
          true,
          baseVersion,
          now,
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return { setupId: newId, foreshadow };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original orphan reinsert failure.
        }
        throw error;
      }
    }

    return runBrowserForeshadowChildWrite(() => {
      const current = queryOne(
        `SELECT setup.*, foreshadow.project_id
           FROM foreshadow_setups setup
           JOIN foreshadows foreshadow ON foreshadow.id = setup.foreshadow_id
          WHERE setup.id = ?`,
        [setupId],
      );
      if (!current) {
        return {
          value: { setupId: null, foreshadow: null },
          changed: false,
        };
      }
      const scene = queryOne(
        "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
        [sceneId],
      );
      if (
        scene?.node_type !== "scene" ||
        scene.project_id !== current.project_id
      ) {
        throw new Error(
          "foreshadow orphan anchor must stay within one project",
        );
      }
      const now = Date.now();
      const semanticKey = browserForeshadowSetupSemanticKey(
        setupId,
        String(current.foreshadow_id),
        sceneId,
        fromPos,
        toPos,
        current.semantic_key,
      );
      const changed =
        String(current.scene_id) !== sceneId ||
        Number(current.from_pos) !== fromPos ||
        Number(current.to_pos) !== toPos ||
        String(current.semantic_key) !== semanticKey ||
        Number(current.is_orphan) !== 0;
      if (changed) {
        db.run(
          `UPDATE foreshadow_setups
              SET scene_id = ?, from_pos = ?, to_pos = ?, semantic_key = ?,
                  is_orphan = 0, updated_at = ?
            WHERE id = ?`,
          [sceneId, fromPos, toPos, semanticKey, now, setupId],
        );
      }
      const foreshadow = finishBrowserForeshadowChildWrite(
        String(current.foreshadow_id),
        changed,
        baseVersion,
        now,
      );
      return {
        value: { setupId: null, foreshadow },
        changed,
      };
    });
  }

  function handleForeshadowSaveAnchorsForScene(
    args: Record<string, unknown>,
  ): Record<string, SqlValue>[] {
    const command = "foreshadow_save_anchors_for_scene";
    const sceneId = requiredBrowserString(command, args, "sceneId");
    const setups = args.setups;
    const payoffs = args.payoffs;
    const rawBaseVersions = browserSnapshotRecord(
      command,
      args.baseVersions,
      "baseVersions",
    );
    const baseVersions = new Map<string, number>();
    for (const [foreshadowId, rawVersion] of Object.entries(rawBaseVersions)) {
      if (
        typeof rawVersion !== "number" ||
        !Number.isSafeInteger(rawVersion) ||
        rawVersion < 0
      ) {
        throw new Error(
          `${command}: invalid baseVersion for '${foreshadowId}'`,
        );
      }
      baseVersions.set(foreshadowId, rawVersion);
    }
    const docContentSize = Number(args.docContentSize);
    if (!Array.isArray(setups) || !Array.isArray(payoffs)) {
      throw new Error(`${command}: setups and payoffs must be arrays`);
    }
    if (!Number.isSafeInteger(docContentSize) || docContentSize < 0) {
      throw new Error(
        `${command}: docContentSize must be a non-negative integer`,
      );
    }
    const scene = queryOne(
      "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
      [sceneId],
    );
    if (!scene || scene.node_type !== "scene")
      throw new Error(`foreshadow anchor scene '${sceneId}' not found`);
    const projectId = String(scene.project_id);
    const parsedSetups = setups.map((raw, index) => {
      const setup = browserSnapshotRecord(command, raw, `setups[${index}]`);
      const id = requiredBrowserString(command, setup, "id");
      const foreshadowId = requiredBrowserString(
        command,
        setup,
        "foreshadowId",
      );
      const baseVersion = setup.baseVersion;
      const anchorSceneId = requiredBrowserString(command, setup, "sceneId");
      const fromPos = Number(setup.fromPos);
      const toPos = Number(setup.toPos);
      if (
        anchorSceneId !== sceneId ||
        typeof baseVersion !== "number" ||
        !Number.isSafeInteger(baseVersion) ||
        baseVersion < 0 ||
        baseVersions.get(foreshadowId) !== baseVersion ||
        !Number.isSafeInteger(fromPos) ||
        !Number.isSafeInteger(toPos) ||
        fromPos < 0 ||
        fromPos > toPos ||
        toPos > docContentSize
      ) {
        throw new Error(`${command}: setups[${index}] has an invalid anchor`);
      }
      const owner = queryOne(
        "SELECT project_id FROM foreshadows WHERE id = ?",
        [foreshadowId],
      );
      if (owner?.project_id !== projectId) {
        throw new Error(
          `${command}: setup foreshadow is outside the scene project`,
        );
      }
      return { id, foreshadowId, baseVersion, fromPos, toPos };
    });
    const payoffIds = new Set<string>();
    const parsedPayoffs = payoffs.map((raw, index) => {
      const payoff = browserSnapshotRecord(command, raw, `payoffs[${index}]`);
      const foreshadowId = requiredBrowserString(
        command,
        payoff,
        "foreshadowId",
      );
      const anchorSceneId = requiredBrowserString(command, payoff, "sceneId");
      const baseVersion = payoff.baseVersion;
      const fromPos = Number(payoff.fromPos);
      const toPos = Number(payoff.toPos);
      if (
        anchorSceneId !== sceneId ||
        typeof baseVersion !== "number" ||
        !Number.isSafeInteger(baseVersion) ||
        baseVersion < 0 ||
        baseVersions.get(foreshadowId) !== baseVersion ||
        !Number.isSafeInteger(fromPos) ||
        !Number.isSafeInteger(toPos) ||
        fromPos < 0 ||
        fromPos > toPos ||
        toPos > docContentSize
      ) {
        throw new Error(`${command}: payoffs[${index}] has an invalid anchor`);
      }
      if (payoffIds.has(foreshadowId)) {
        throw new Error(
          `${command}: duplicate payoff foreshadow '${foreshadowId}'`,
        );
      }
      payoffIds.add(foreshadowId);
      const owner = queryOne(
        "SELECT project_id FROM foreshadows WHERE id = ?",
        [foreshadowId],
      );
      if (owner?.project_id !== projectId) {
        throw new Error(
          `${command}: payoff foreshadow is outside the scene project`,
        );
      }
      return { foreshadowId, baseVersion, fromPos, toPos };
    });

    const now = Date.now();
    const touchedRoots = new Set<string>();
    const changedRoots = new Set<string>();
    const authoritative: Record<string, SqlValue>[] = [];
    db.run("BEGIN IMMEDIATE");
    try {
      for (const setup of parsedSetups) {
        const existing = queryOne(
          `SELECT setup.foreshadow_id, setup.scene_id, setup.semantic_key,
                  setup.from_pos, setup.to_pos, setup.is_orphan,
                  stored_scene.project_id AS scene_project_id,
                  stored_scene.node_type AS scene_node_type
             FROM foreshadow_setups setup
             JOIN tree_nodes stored_scene ON stored_scene.id = setup.scene_id
            WHERE setup.id = ?`,
          [setup.id],
        );
        if (existing && String(existing.foreshadow_id) !== setup.foreshadowId) {
          throw new Error(
            `${command}: setup '${setup.id}' belongs to a different foreshadow`,
          );
        }
        if (
          existing &&
          (existing.scene_project_id !== projectId ||
            existing.scene_node_type !== "scene")
        ) {
          throw new Error(
            `${command}: setup '${setup.id}' scene is outside the target project`,
          );
        }
        const semanticKey = browserForeshadowSetupSemanticKey(
          setup.id,
          setup.foreshadowId,
          sceneId,
          setup.fromPos,
          setup.toPos,
          existing?.semantic_key,
        );
        const changed =
          !existing ||
          String(existing.scene_id) !== sceneId ||
          Number(existing.from_pos) !== setup.fromPos ||
          Number(existing.to_pos) !== setup.toPos ||
          String(existing.semantic_key) !== semanticKey ||
          Number(existing.is_orphan) !== 0;
        if (changed) {
          db.run(
            `INSERT INTO foreshadow_setups
            (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
             attribution, is_orphan, semantic_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', 0, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             scene_id = excluded.scene_id,
             from_pos = excluded.from_pos,
             to_pos = excluded.to_pos,
             semantic_key = excluded.semantic_key,
             is_orphan = 0,
             updated_at = excluded.updated_at`,
            [
              setup.id,
              setup.foreshadowId,
              sceneId,
              setup.fromPos,
              setup.toPos,
              semanticKey,
              now,
              now,
            ],
          );
          changedRoots.add(setup.foreshadowId);
        }
        touchedRoots.add(setup.foreshadowId);
      }
      for (const payoff of parsedPayoffs) {
        const current = queryOne(
          "SELECT * FROM foreshadows WHERE id = ? AND project_id = ?",
          [payoff.foreshadowId, projectId],
        );
        if (!current) {
          throw new Error(`${command}: payoff foreshadow vanished`);
        }
        const unchanged =
          current.payoff_scene_id === sceneId &&
          current.payoff_from_pos !== null &&
          current.payoff_to_pos !== null &&
          Number(current.payoff_from_pos) === payoff.fromPos &&
          Number(current.payoff_to_pos) === payoff.toPos;
        if (!unchanged) {
          const currentVersion = Number(current.version ?? 0);
          if (currentVersion !== payoff.baseVersion) {
            throw new Error(
              `FORESHADOW_VERSION_MISMATCH: payoff '${payoff.foreshadowId}' expected ${payoff.baseVersion}, found ${currentVersion}`,
            );
          }
          db.run(
            `UPDATE foreshadows
              SET payoff_scene_id = ?, payoff_from_pos = ?, payoff_to_pos = ?,
                  updated_at = updated_at
             WHERE id = ? AND project_id = ? AND version = ?`,
            [
              sceneId,
              payoff.fromPos,
              payoff.toPos,
              payoff.foreshadowId,
              projectId,
              payoff.baseVersion,
            ],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(
              `FORESHADOW_VERSION_MISMATCH: payoff '${payoff.foreshadowId}' expected ${payoff.baseVersion}`,
            );
          }
          changedRoots.add(payoff.foreshadowId);
        }
        touchedRoots.add(payoff.foreshadowId);
      }
      const validSetupIds = new Set(parsedSetups.map((setup) => setup.id));
      if (parsedSetups.length > 0 || docContentSize <= 2) {
        const sceneSetups = queryAll(
          `SELECT id, foreshadow_id, is_orphan
             FROM foreshadow_setups WHERE scene_id = ?`,
          [sceneId],
        );
        for (const setup of sceneSetups) {
          const setupId = String(setup.id);
          if (!validSetupIds.has(setupId) && Number(setup.is_orphan) !== 1) {
            const foreshadowId = String(setup.foreshadow_id);
            if (!baseVersions.has(foreshadowId)) {
              throw new Error(
                `FORESHADOW_VERSION_MISMATCH: scene snapshot has no baseVersion for '${foreshadowId}'`,
              );
            }
            db.run(
              `UPDATE foreshadow_setups
                  SET is_orphan = 1, updated_at = ?
                WHERE id = ? AND is_orphan IS NOT 1`,
              [now, setupId],
            );
            if (db.getRowsModified() === 1) {
              changedRoots.add(foreshadowId);
              touchedRoots.add(foreshadowId);
            }
          }
        }
      }
      for (const foreshadowId of [...touchedRoots].sort()) {
        const baseVersion = baseVersions.get(foreshadowId);
        if (baseVersion === undefined) {
          throw new Error(
            `FORESHADOW_VERSION_MISMATCH: scene snapshot has no baseVersion for '${foreshadowId}'`,
          );
        }
        const row = finishBrowserForeshadowChildWrite(
          foreshadowId,
          changedRoots.has(foreshadowId),
          baseVersion,
          now,
        );
        if (!row) {
          throw new Error(`${command}: foreshadow '${foreshadowId}' vanished`);
        }
        authoritative.push(row);
      }
      const mutated = changedRoots.size > 0;
      db.run("COMMIT");
      if (mutated) options.onDatabaseDirty?.();
      return authoritative;
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Preserve the original anchor persistence failure.
      }
      throw error;
    }
  }

  interface BrowserForeshadowSnapshot {
    id: string;
    projectId: string;
    title: string;
    intent: string | null;
    notes: string | null;
    payoffSceneId: string | null;
    payoffFromPos: number | null;
    payoffToPos: number | null;
    payoffConfirmed: number;
    abandoned: number;
    secret: number;
    loadBearing: string | null;
    mechanism: string | null;
    version: number;
    codexLinkDirtyAt: number | null;
    createdAt: number;
    updatedAt: number;
  }

  function browserForeshadowSnapshot(
    row: Record<string, SqlValue>,
  ): BrowserForeshadowSnapshot {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      intent: row.intent == null ? null : String(row.intent),
      notes: row.notes == null ? null : String(row.notes),
      payoffSceneId:
        row.payoff_scene_id == null ? null : String(row.payoff_scene_id),
      payoffFromPos:
        row.payoff_from_pos == null ? null : Number(row.payoff_from_pos),
      payoffToPos: row.payoff_to_pos == null ? null : Number(row.payoff_to_pos),
      payoffConfirmed: Number(row.payoff_confirmed ?? 0),
      abandoned: Number(row.abandoned ?? 0),
      secret: Number(row.secret ?? 0),
      loadBearing: row.load_bearing == null ? null : String(row.load_bearing),
      mechanism: row.mechanism == null ? null : String(row.mechanism),
      version: Number(row.version ?? 0),
      codexLinkDirtyAt:
        row.codex_link_dirty_at == null
          ? null
          : Number(row.codex_link_dirty_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  function loadBrowserForeshadowSnapshot(
    foreshadowId: string,
    projectId: string,
  ): BrowserForeshadowSnapshot | null {
    const row = queryOne(
      "SELECT * FROM foreshadows WHERE id = ? AND project_id = ?",
      [foreshadowId, projectId],
    );
    return row ? browserForeshadowSnapshot(row) : null;
  }

  type BrowserForeshadowChildSnapshot = Record<string, string | number | null>;

  type BrowserForeshadowAggregateSnapshot = Omit<
    BrowserForeshadowSnapshot,
    "createdAt" | "updatedAt"
  > & {
    setups: BrowserForeshadowChildSnapshot[];
    payoffs: BrowserForeshadowChildSnapshot[];
    supportEdges: BrowserForeshadowChildSnapshot[];
    codexEntryIds: string[];
  };

  function loadBrowserForeshadowAggregateSnapshot(
    foreshadowId: string,
    projectId: string,
  ): BrowserForeshadowAggregateSnapshot | null {
    const root = loadBrowserForeshadowSnapshot(foreshadowId, projectId);
    if (!root) return null;
    const {
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...domainRoot
    } = root;
    const setups = queryAll(
      `SELECT * FROM foreshadow_setups
        WHERE foreshadow_id = ? ORDER BY id`,
      [foreshadowId],
    ).map((row) => ({
      id: String(row.id),
      foreshadowId: String(row.foreshadow_id),
      sceneId: String(row.scene_id),
      fromPos: Number(row.from_pos),
      toPos: Number(row.to_pos),
      kind: String(row.kind),
      role: String(row.role),
      strength: row.strength == null ? null : String(row.strength),
      aiStrength: row.ai_strength == null ? null : String(row.ai_strength),
      aiReasoning: row.ai_reasoning == null ? null : String(row.ai_reasoning),
      attribution: String(row.attribution),
      aiRationale: row.ai_rationale == null ? null : String(row.ai_rationale),
      lastEvaluatedAt:
        row.last_evaluated_at == null ? null : Number(row.last_evaluated_at),
      isOrphan: Number(row.is_orphan),
      evidenceAnchorId:
        row.evidence_anchor_id == null ? null : String(row.evidence_anchor_id),
      semanticKey: String(row.semantic_key),
    }));
    const payoffs = queryAll(
      `SELECT * FROM foreshadow_payoffs
        WHERE foreshadow_id = ? ORDER BY id`,
      [foreshadowId],
    ).map((row) => ({
      id: String(row.id),
      foreshadowId: String(row.foreshadow_id),
      sceneId: String(row.scene_id),
      fromPos: row.from_pos == null ? null : Number(row.from_pos),
      toPos: row.to_pos == null ? null : Number(row.to_pos),
      role: String(row.role),
      confirmed: Number(row.confirmed),
      isPrimary: Number(row.is_primary),
      attribution: String(row.attribution),
      aiRationale: row.ai_rationale == null ? null : String(row.ai_rationale),
      isOrphan: Number(row.is_orphan),
      evidenceAnchorId:
        row.evidence_anchor_id == null ? null : String(row.evidence_anchor_id),
      semanticKey: String(row.semantic_key),
    }));
    const supportEdges = queryAll(
      `SELECT * FROM foreshadow_setup_payoff_links
        WHERE foreshadow_id = ? ORDER BY setup_id, payoff_id`,
      [foreshadowId],
    ).map((row) => ({
      foreshadowId: String(row.foreshadow_id),
      setupId: String(row.setup_id),
      payoffId: String(row.payoff_id),
      bridgeKind: String(row.bridge_kind),
      explanation: row.explanation == null ? null : String(row.explanation),
    }));
    const codexEntryIds = queryAll(
      `SELECT codex_entry_id FROM foreshadow_codex_links
        WHERE foreshadow_id = ? ORDER BY codex_entry_id`,
      [foreshadowId],
    ).map((row) => String(row.codex_entry_id));
    return {
      ...domainRoot,
      setups,
      payoffs,
      supportEdges,
      codexEntryIds,
    };
  }

  function ensureBrowserForeshadowAggregateValid(
    snapshot: BrowserForeshadowAggregateSnapshot,
    projectId: string,
    foreshadowId: string,
  ): void {
    if (snapshot.id !== foreshadowId || snapshot.projectId !== projectId) {
      throw new Error("foreshadow aggregate snapshot ownership mismatch");
    }
    const setupIds = new Set(snapshot.setups.map((row) => String(row.id)));
    const payoffIds = new Set(snapshot.payoffs.map((row) => String(row.id)));
    if (
      setupIds.size !== snapshot.setups.length ||
      payoffIds.size !== snapshot.payoffs.length
    ) {
      throw new Error("foreshadow aggregate snapshot has duplicate children");
    }
    const sceneIds = [
      snapshot.payoffSceneId,
      ...snapshot.setups.map((row) => String(row.sceneId)),
      ...snapshot.payoffs.map((row) => String(row.sceneId)),
    ].filter((id): id is string => typeof id === "string");
    for (const sceneId of new Set(sceneIds)) {
      const scene = queryOne(
        "SELECT project_id, node_type FROM tree_nodes WHERE id = ?",
        [sceneId],
      );
      if (scene?.project_id !== projectId || scene.node_type !== "scene") {
        throw new Error(
          `foreshadow replay scene '${sceneId}' is outside project '${projectId}'`,
        );
      }
    }
    for (const row of snapshot.setups) {
      if (row.foreshadowId !== foreshadowId) {
        throw new Error("foreshadow setup is outside its aggregate");
      }
    }
    for (const row of snapshot.payoffs) {
      if (row.foreshadowId !== foreshadowId) {
        throw new Error("foreshadow payoff is outside its aggregate");
      }
    }
    const edgeKeys = new Set<string>();
    for (const edge of snapshot.supportEdges) {
      const key = `${String(edge.setupId)}\0${String(edge.payoffId)}`;
      if (
        edge.foreshadowId !== foreshadowId ||
        !setupIds.has(String(edge.setupId)) ||
        !payoffIds.has(String(edge.payoffId)) ||
        edgeKeys.has(key)
      ) {
        throw new Error("foreshadow support edge is outside its aggregate");
      }
      edgeKeys.add(key);
    }
    for (const codexEntryId of snapshot.codexEntryIds) {
      const codex = queryOne(
        "SELECT project_id FROM codex_entries WHERE id = ?",
        [codexEntryId],
      );
      if (codex?.project_id !== projectId) {
        throw new Error(
          `foreshadow replay Codex entry '${codexEntryId}' is outside project '${projectId}'`,
        );
      }
    }
    const crossEdges = queryOne(
      `SELECT COUNT(*) AS count
         FROM foreshadow_setup_payoff_links edge
         JOIN foreshadow_setups setup ON setup.id = edge.setup_id
         JOIN foreshadow_payoffs payoff ON payoff.id = edge.payoff_id
        WHERE (setup.foreshadow_id = ? OR payoff.foreshadow_id = ?)
          AND edge.foreshadow_id <> ?`,
      [foreshadowId, foreshadowId, foreshadowId],
    );
    if (Number(crossEdges?.count ?? 0) !== 0) {
      throw new Error(
        `foreshadow '${foreshadowId}' has a cross-aggregate support edge`,
      );
    }
  }

  function parseBrowserForeshadowAggregateSnapshot(
    raw: SqlValue,
    journalId: string,
  ): BrowserForeshadowAggregateSnapshot {
    if (typeof raw !== "string") {
      throw new Error(
        `foreshadow undo journal '${journalId}' is missing a snapshot`,
      );
    }
    const parsed = JSON.parse(
      raw,
    ) as Partial<BrowserForeshadowAggregateSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.version !== "number" ||
      !Array.isArray(parsed.setups) ||
      !Array.isArray(parsed.payoffs) ||
      !Array.isArray(parsed.supportEdges) ||
      !Array.isArray(parsed.codexEntryIds)
    ) {
      throw new Error(
        `foreshadow undo journal '${journalId}' has an invalid aggregate snapshot`,
      );
    }
    return parsed as BrowserForeshadowAggregateSnapshot;
  }

  function insertBrowserForeshadowAggregateSnapshot(
    snapshot: BrowserForeshadowAggregateSnapshot,
    replayVersion: number,
    timestamp: number,
  ): void {
    ensureBrowserForeshadowAggregateValid(
      snapshot,
      snapshot.projectId,
      snapshot.id,
    );
    insertBrowserForeshadowSnapshot(
      { ...snapshot, createdAt: timestamp, updatedAt: timestamp },
      replayVersion,
      timestamp,
    );
    for (const row of snapshot.setups) {
      db.run(
        `INSERT INTO foreshadow_setups
          (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role,
           strength, ai_strength, ai_reasoning, attribution, ai_rationale,
           last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.foreshadowId,
          row.sceneId,
          row.fromPos,
          row.toPos,
          row.kind,
          row.role,
          row.strength,
          row.aiStrength,
          row.aiReasoning,
          row.attribution,
          row.aiRationale,
          row.lastEvaluatedAt,
          row.isOrphan,
          row.evidenceAnchorId,
          row.semanticKey,
          timestamp,
          timestamp,
        ],
      );
    }
    for (const row of snapshot.payoffs) {
      db.run(
        `INSERT INTO foreshadow_payoffs
          (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
           is_primary, attribution, ai_rationale, is_orphan,
           evidence_anchor_id, semantic_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.foreshadowId,
          row.sceneId,
          row.fromPos,
          row.toPos,
          row.role,
          row.confirmed,
          row.isPrimary,
          row.attribution,
          row.aiRationale,
          row.isOrphan,
          row.evidenceAnchorId,
          row.semanticKey,
          timestamp,
          timestamp,
        ],
      );
    }
    for (const row of snapshot.supportEdges) {
      db.run(
        `INSERT INTO foreshadow_setup_payoff_links
          (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.foreshadowId,
          row.setupId,
          row.payoffId,
          row.bridgeKind,
          row.explanation,
          timestamp,
        ],
      );
    }
    for (const codexEntryId of snapshot.codexEntryIds) {
      db.run(
        `INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
         VALUES (?, ?)`,
        [snapshot.id, codexEntryId],
      );
    }
  }

  function deleteBrowserForeshadowAggregateAtVersion(
    snapshot: BrowserForeshadowAggregateSnapshot,
    expectedVersion: number,
  ): void {
    ensureBrowserForeshadowAggregateValid(
      snapshot,
      snapshot.projectId,
      snapshot.id,
    );
    const live = loadBrowserForeshadowAggregateSnapshot(
      snapshot.id,
      snapshot.projectId,
    );
    const expected = { ...snapshot, version: expectedVersion };
    if (!live || JSON.stringify(live) !== JSON.stringify(expected)) {
      throw new Error(
        `foreshadow '${snapshot.id}' aggregate changed before delete redo`,
      );
    }
    db.run(
      `DELETE FROM foreshadows
        WHERE id = ? AND project_id = ? AND version = ?`,
      [snapshot.id, snapshot.projectId, expectedVersion],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(`foreshadow '${snapshot.id}' changed before delete redo`);
    }
  }

  function insertBrowserForeshadowSnapshot(
    snapshot: BrowserForeshadowSnapshot,
    replayVersion = snapshot.version,
    replayUpdatedAt = snapshot.updatedAt,
  ): void {
    db.run(
      `INSERT INTO foreshadows
        (id, project_id, title, intent, notes, payoff_scene_id,
         payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned, secret,
         load_bearing, mechanism, version, codex_link_dirty_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.projectId,
        snapshot.title,
        snapshot.intent,
        snapshot.notes,
        snapshot.payoffSceneId,
        snapshot.payoffFromPos,
        snapshot.payoffToPos,
        snapshot.payoffConfirmed,
        snapshot.abandoned,
        snapshot.secret,
        snapshot.loadBearing,
        snapshot.mechanism,
        replayVersion,
        snapshot.codexLinkDirtyAt,
        snapshot.createdAt,
        replayUpdatedAt,
      ],
    );
  }

  function restoreBrowserForeshadowSnapshot(
    snapshot: BrowserForeshadowSnapshot,
    expectedVersion: number,
    targetVersion: number,
    replayUpdatedAt: number,
  ): void {
    db.run(
      `UPDATE foreshadows
          SET title = ?, intent = ?, notes = ?, payoff_scene_id = ?,
              payoff_from_pos = ?, payoff_to_pos = ?, payoff_confirmed = ?,
              abandoned = ?, secret = ?, load_bearing = ?, mechanism = ?,
              version = ?, codex_link_dirty_at = ?, created_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND version = ?`,
      [
        snapshot.title,
        snapshot.intent,
        snapshot.notes,
        snapshot.payoffSceneId,
        snapshot.payoffFromPos,
        snapshot.payoffToPos,
        snapshot.payoffConfirmed,
        snapshot.abandoned,
        snapshot.secret,
        snapshot.loadBearing,
        snapshot.mechanism,
        targetVersion,
        snapshot.codexLinkDirtyAt,
        snapshot.createdAt,
        replayUpdatedAt,
        snapshot.id,
        snapshot.projectId,
        expectedVersion,
      ],
    );
    if (db.getRowsModified() !== 1) {
      throw new Error(`foreshadow '${snapshot.id}' changed before undo replay`);
    }
  }

  function rewriteBrowserForeshadowJournalStateToken(
    projectId: string,
    foreshadowId: string,
    previousVersion: number,
    replayVersion: number,
  ): void {
    db.run(
      `UPDATE undo_journal
          SET base_version = CASE
                WHEN base_version = ? THEN ? ELSE base_version END,
              result_version = CASE
                WHEN result_version = ? THEN ? ELSE result_version END
        WHERE project_id = ? AND entity_kind = 'foreshadow' AND entity_id = ?
          AND (base_version = ? OR result_version = ?)`,
      [
        previousVersion,
        replayVersion,
        previousVersion,
        replayVersion,
        projectId,
        foreshadowId,
        previousVersion,
        previousVersion,
      ],
    );
    if (db.getRowsModified() === 0) {
      throw new Error(
        `foreshadow undo journal chain for '${foreshadowId}' lost state version ${previousVersion}`,
      );
    }
  }

  function parseBrowserForeshadowSnapshot(
    raw: SqlValue,
    journalId: string,
  ): BrowserForeshadowSnapshot {
    if (typeof raw !== "string") {
      throw new Error(
        `foreshadow undo journal '${journalId}' is missing a snapshot`,
      );
    }
    const parsed = JSON.parse(raw) as Partial<BrowserForeshadowSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.version !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      throw new Error(
        `foreshadow undo journal '${journalId}' has an invalid snapshot`,
      );
    }
    return parsed as BrowserForeshadowSnapshot;
  }

  async function handleAgentForeshadowCreate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "agent_foreshadow_create";
    const p = browserCommandPayload(command, args);
    const projectId = requiredBrowserString(command, p, "projectId");
    const sessionId = requiredBrowserString(command, p, "sessionId");
    const foreshadowId = requiredBrowserString(command, p, "foreshadowId");
    const title = requiredBrowserString(command, p, "title");
    const requestId = optionalBrowserString(command, p, "requestId");
    const intent = nullableBrowserString(command, p, "intent");
    const notes = nullableBrowserString(command, p, "notes");
    const loadBearing = nullableBrowserString(command, p, "loadBearing");
    if (
      loadBearing !== null &&
      !["critical", "supporting", "optional"].includes(loadBearing)
    ) {
      throw new Error(`invalid load_bearing value: ${loadBearing}`);
    }
    const secret = browserBoolean(command, p, "secret", true);
    const fingerprintPayload = {
      projectId,
      foreshadowId,
      title,
      intent,
      notes,
      loadBearing,
      secret,
    };

    return withAppendLedgerLock(async () => {
      const requestHash = await browserPayloadFingerprint(
        command,
        fingerprintPayload,
      );
      if (requestId !== null) {
        const ledger = queryOne(
          `SELECT payload_hash, tombstone_json
             FROM idempotency_requests
            WHERE domain = ? AND request_id = ?`,
          [command, requestId],
        );
        if (ledger) {
          if (String(ledger.payload_hash) !== requestHash) {
            throw new Error(
              "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload",
            );
          }
          const journal = queryOne(
            `SELECT id, result_version, change_event_uid
               FROM undo_journal
              WHERE id = ? AND project_id = ? AND entity_kind = 'foreshadow'
                AND entity_id = ? AND op_kind = 'create'`,
            [requestId, projectId, foreshadowId],
          );
          if (!journal) {
            throw new Error(
              "AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: original state is missing",
            );
          }
          return {
            entityId: foreshadowId,
            version: Number(journal.result_version),
            changeEventUid: String(journal.change_event_uid),
            undoJournalId: String(journal.id),
          };
        }
      }

      const timestamp = Date.now();
      const eventUid = crypto.randomUUID();
      const undoJournalId = requestId ?? crypto.randomUUID();
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "foreshadow",
        opType: "foreshadow.create",
        entityType: "foreshadow",
        entityId: foreshadowId,
        payload: JSON.stringify({ title, loadBearing, secret, requestHash }),
        sessionId,
        timestamp,
      });
      db.run("BEGIN IMMEDIATE");
      try {
        if (!queryOne("SELECT id FROM projects WHERE id = ?", [projectId])) {
          throw new Error(`project '${projectId}' not found`);
        }
        db.run(
          `INSERT INTO foreshadows
            (id, project_id, title, intent, notes, payoff_scene_id,
             payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned,
             secret, load_bearing, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?, 0, ?, ?)`,
          [
            foreshadowId,
            projectId,
            title,
            intent,
            notes,
            secret ? 1 : 0,
            loadBearing,
            timestamp,
            timestamp,
          ],
        );
        const after = loadBrowserForeshadowSnapshot(foreshadowId, projectId);
        if (!after) throw new Error("foreshadow row missing after insert");
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind,
             before_json, after_json, base_version, result_version,
             change_event_uid, created_at)
           VALUES (?, ?, 'in-app-agent', 'foreshadow', ?, 'create',
                   NULL, ?, 0, ?, ?, ?)`,
          [
            undoJournalId,
            projectId,
            foreshadowId,
            JSON.stringify(after),
            after.version,
            eventUid,
            new Date(timestamp).toISOString(),
          ],
        );
        if (requestId !== null) {
          db.run(
            `INSERT INTO idempotency_requests
              (domain, request_id, project_id, payload_hash, tombstone_json)
             VALUES (?, ?, ?, ?, ?)`,
            [
              command,
              requestId,
              projectId,
              requestHash,
              JSON.stringify({ id: foreshadowId }),
            ],
          );
        }
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: foreshadowId,
          version: after.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the tracked create failure.
        }
        throw error;
      }
    });
  }

  async function handleAgentForeshadowUpdate(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "agent_foreshadow_update";
    const p = browserCommandPayload(command, args);
    const projectId = requiredBrowserString(command, p, "projectId");
    const sessionId = requiredBrowserString(command, p, "sessionId");
    const foreshadowId = requiredBrowserString(command, p, "foreshadowId");
    const requestedBaseVersion = p.baseVersion;
    if (
      typeof requestedBaseVersion !== "number" ||
      !Number.isSafeInteger(requestedBaseVersion) ||
      requestedBaseVersion < 0
    ) {
      throw new Error(
        "agent foreshadow baseVersion must be a non-negative integer",
      );
    }
    for (const field of ["title", "intent", "notes", "loadBearing"] as const) {
      if (
        p[field] !== null &&
        p[field] !== undefined &&
        typeof p[field] !== "string"
      ) {
        throw new Error(`${command}: ${field} must be a string or null`);
      }
    }
    for (const field of ["payoffConfirmed", "abandoned", "secret"] as const) {
      if (
        p[field] !== null &&
        p[field] !== undefined &&
        typeof p[field] !== "boolean"
      ) {
        throw new Error(`${command}: ${field} must be a boolean or null`);
      }
    }
    const fields = [
      "title",
      "intent",
      "notes",
      "loadBearing",
      "payoffConfirmed",
      "abandoned",
      "secret",
    ].filter((field) => p[field] !== null && p[field] !== undefined);
    if (fields.length === 0) throw new Error("no fields provided to update");
    if (
      p.loadBearing != null &&
      !["critical", "supporting", "optional"].includes(String(p.loadBearing))
    ) {
      throw new Error(`invalid load_bearing value: ${String(p.loadBearing)}`);
    }

    return withAppendLedgerLock(async () => {
      const captured = loadBrowserForeshadowSnapshot(foreshadowId, projectId);
      if (!captured) {
        throw new Error(`Foreshadow ${foreshadowId} not found after reload`);
      }
      if (captured.version !== requestedBaseVersion) {
        throw new Error(
          `foreshadow version conflict: expected ${requestedBaseVersion}, found ${captured.version}`,
        );
      }
      const timestamp = Math.max(Date.now(), captured.updatedAt + 1);
      const eventUid = crypto.randomUUID();
      const undoJournalId = crypto.randomUUID();
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "foreshadow",
        opType: "foreshadow.update",
        entityType: "foreshadow",
        entityId: foreshadowId,
        payload: JSON.stringify({ fields }),
        sessionId,
        timestamp,
      });
      db.run("BEGIN IMMEDIATE");
      try {
        const before = loadBrowserForeshadowSnapshot(foreshadowId, projectId);
        if (
          !before ||
          before.version !== captured.version ||
          before.updatedAt !== captured.updatedAt
        ) {
          throw new Error(
            "foreshadow changed during tracked update preparation",
          );
        }
        const assignments: string[] = [];
        const params: SqlValue[] = [];
        const columns: Record<string, string> = {
          title: "title",
          intent: "intent",
          notes: "notes",
          loadBearing: "load_bearing",
          payoffConfirmed: "payoff_confirmed",
          abandoned: "abandoned",
          secret: "secret",
        };
        for (const field of fields) {
          assignments.push(`${columns[field]} = ?`);
          const value = p[field];
          params.push(
            typeof value === "boolean" ? (value ? 1 : 0) : String(value),
          );
        }
        assignments.push("version = version + 1", "updated_at = ?");
        params.push(timestamp, foreshadowId, projectId, before.version);
        db.run(
          `UPDATE foreshadows SET ${assignments.join(", ")}
            WHERE id = ? AND project_id = ? AND version = ?`,
          params,
        );
        if (db.getRowsModified() !== 1) {
          throw new Error("foreshadow changed during tracked update");
        }
        const after = loadBrowserForeshadowSnapshot(foreshadowId, projectId);
        if (
          !after ||
          after.updatedAt !== timestamp ||
          after.version !== before.version + 1
        ) {
          throw new Error("foreshadow row missing after tracked update");
        }
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind,
             before_json, after_json, base_version, result_version,
             change_event_uid, created_at)
           VALUES (?, ?, 'in-app-agent', 'foreshadow', ?, 'update',
                   ?, ?, ?, ?, ?, ?)`,
          [
            undoJournalId,
            projectId,
            foreshadowId,
            JSON.stringify(before),
            JSON.stringify(after),
            before.version,
            after.version,
            eventUid,
            new Date(timestamp).toISOString(),
          ],
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: foreshadowId,
          version: after.version,
          changeEventUid: eventUid,
          undoJournalId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the tracked update failure.
        }
        throw error;
      }
    });
  }

  interface BrowserSceneEventLinkState {
    sceneId: string;
    linked: boolean;
    incarnationToken: string | null;
  }

  const MAX_BROWSER_SCENE_EVENT_LINK_BATCH_SIZE = 10_000;
  const BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND =
    "sceneEventLinkBatch" as const;

  interface BrowserSceneEventLinkBatchSnapshot {
    snapshotKind: typeof BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND;
    eventId: string;
    sceneIds: string[];
    linked: boolean;
    incarnationTokens?: Record<string, string>;
  }

  interface BrowserSceneEventLinkBatchState {
    eventId: string;
    sceneLinks: BrowserSceneEventLinkState[];
  }

  function collectBrowserSceneEventLinkBatchState(
    eventId: string,
    sceneIds: readonly string[],
  ): BrowserSceneEventLinkBatchState {
    return {
      eventId,
      sceneLinks: sceneIds.map((sceneId) => {
        const row = queryOne(
          `SELECT incarnation_token FROM scene_events
            WHERE scene_id = ? AND event_id = ?`,
          [sceneId, eventId],
        );
        return {
          sceneId,
          linked: Boolean(row),
          incarnationToken: row ? String(row.incarnation_token) : null,
        };
      }),
    };
  }

  function browserSceneEventLinkBatchSnapshot(
    eventId: string,
    sceneIds: readonly string[],
    linked: boolean,
    incarnationTokens?: Readonly<Record<string, string>>,
  ): BrowserSceneEventLinkBatchSnapshot {
    const snapshot: BrowserSceneEventLinkBatchSnapshot = {
      snapshotKind: BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND,
      eventId,
      sceneIds: [...sceneIds],
      linked,
    };
    if (linked && sceneIds.length > 0) {
      snapshot.incarnationTokens = Object.fromEntries(
        sceneIds.map((sceneId) => [
          sceneId,
          incarnationTokens?.[sceneId] ?? "",
        ]),
      );
    }
    return snapshot;
  }

  function parseBrowserSceneEventLinkBatchSnapshot(
    raw: SqlValue,
    journalId: string,
  ): BrowserSceneEventLinkBatchSnapshot {
    if (typeof raw !== "string") {
      throw new Error(
        `scene event batch journal '${journalId}' is missing a snapshot`,
      );
    }
    const parsed = JSON.parse(
      raw,
    ) as Partial<BrowserSceneEventLinkBatchSnapshot>;
    if (
      parsed.snapshotKind !== BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND ||
      typeof parsed.eventId !== "string" ||
      !Array.isArray(parsed.sceneIds) ||
      typeof parsed.linked !== "boolean"
    ) {
      throw new Error(
        `scene event batch journal '${journalId}' has an invalid snapshot`,
      );
    }
    const sceneIds = parsed.sceneIds.map((rawSceneId) => {
      if (typeof rawSceneId !== "string") {
        throw new Error(
          `scene event batch journal '${journalId}' has a non-string scene id`,
        );
      }
      return rawSceneId;
    });
    if (new Set(sceneIds).size !== sceneIds.length) {
      throw new Error(
        `scene event batch journal '${journalId}' has duplicate scene ids`,
      );
    }
    sceneIds.sort();
    let incarnationTokens: Record<string, string> | undefined;
    if (parsed.linked) {
      if (parsed.incarnationTokens === undefined) {
        incarnationTokens = Object.fromEntries(
          sceneIds.map((sceneId) => [sceneId, ""]),
        );
      } else {
        if (
          parsed.incarnationTokens === null ||
          typeof parsed.incarnationTokens !== "object" ||
          Array.isArray(parsed.incarnationTokens) ||
          Object.keys(parsed.incarnationTokens).length !== sceneIds.length
        ) {
          throw new Error(
            `scene event batch journal '${journalId}' has invalid incarnation tokens`,
          );
        }
        incarnationTokens = Object.fromEntries(
          sceneIds.map((sceneId) => {
            const token = parsed.incarnationTokens?.[sceneId];
            if (typeof token !== "string") {
              throw new Error(
                `scene event batch journal '${journalId}' is missing an incarnation token`,
              );
            }
            return [sceneId, token];
          }),
        );
      }
    } else if (
      parsed.incarnationTokens !== undefined &&
      (parsed.incarnationTokens === null ||
        typeof parsed.incarnationTokens !== "object" ||
        Array.isArray(parsed.incarnationTokens) ||
        Object.keys(parsed.incarnationTokens).length > 0)
    ) {
      throw new Error(
        `scene event batch journal '${journalId}' has tokens for an unlinked snapshot`,
      );
    }
    return {
      snapshotKind: BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND,
      eventId: parsed.eventId,
      sceneIds,
      linked: parsed.linked,
      ...(incarnationTokens ? { incarnationTokens } : {}),
    };
  }

  function validateBrowserSceneEventLinkBatchScope(
    projectId: string,
    snapshot: BrowserSceneEventLinkBatchSnapshot,
  ): void {
    const event = queryOne(
      "SELECT 1 AS owned FROM events WHERE id = ? AND project_id = ?",
      [snapshot.eventId, projectId],
    );
    if (!event) {
      throw new Error(
        `event '${snapshot.eventId}' not found in project '${projectId}' during scene-link replay`,
      );
    }
    for (const sceneId of snapshot.sceneIds) {
      const scene = queryOne(
        `SELECT 1 AS owned FROM tree_nodes
          WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
        [sceneId, projectId],
      );
      if (!scene) {
        throw new Error(
          `scene '${sceneId}' not found in project '${projectId}'`,
        );
      }
    }
  }

  function validateBrowserSceneEventLinkBatchSource(
    snapshot: BrowserSceneEventLinkBatchSnapshot,
  ): void {
    const current = collectBrowserSceneEventLinkBatchState(
      snapshot.eventId,
      snapshot.sceneIds,
    );
    for (const link of current.sceneLinks) {
      const valid = snapshot.linked
        ? link.linked &&
          link.incarnationToken === snapshot.incarnationTokens?.[link.sceneId]
        : !link.linked;
      if (!valid) {
        throw new Error(
          `scene-event association '${link.sceneId}' incarnation conflict during journal replay`,
        );
      }
    }
  }

  function rewriteBrowserSceneEventSnapshotIncarnation(
    raw: SqlValue,
    eventId: string,
    sceneId: string,
    previousToken: string,
    replayToken: string,
  ): string | null {
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(
      raw,
    ) as Partial<BrowserSceneEventLinkBatchSnapshot>;
    if (
      parsed.snapshotKind !== BROWSER_SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND ||
      parsed.eventId !== eventId ||
      parsed.linked !== true ||
      !Array.isArray(parsed.sceneIds) ||
      !parsed.sceneIds.includes(sceneId) ||
      parsed.incarnationTokens?.[sceneId] !== previousToken
    ) {
      return null;
    }
    parsed.incarnationTokens = {
      ...parsed.incarnationTokens,
      [sceneId]: replayToken,
    };
    return JSON.stringify(parsed);
  }

  function rewriteBrowserSceneEventJournalIncarnationChain(
    projectId: string,
    eventId: string,
    excludedJournalId: string,
    sceneId: string,
    previousToken: string,
    replayToken: string,
  ): void {
    if (previousToken === "") return;
    const journals = queryAll(
      `SELECT id, before_json, after_json FROM undo_journal
        WHERE project_id = ? AND entity_kind = 'event' AND entity_id = ?
          AND op_kind = 'update' AND id <> ?`,
      [projectId, eventId, excludedJournalId],
    );
    for (const journal of journals) {
      const before = rewriteBrowserSceneEventSnapshotIncarnation(
        journal.before_json,
        eventId,
        sceneId,
        previousToken,
        replayToken,
      );
      const after = rewriteBrowserSceneEventSnapshotIncarnation(
        journal.after_json,
        eventId,
        sceneId,
        previousToken,
        replayToken,
      );
      if (before !== null || after !== null) {
        db.run(
          `UPDATE undo_journal SET before_json = ?, after_json = ?
            WHERE id = ? AND project_id = ?`,
          [
            before ?? journal.before_json,
            after ?? journal.after_json,
            journal.id,
            projectId,
          ],
        );
      }
    }
  }

  function replayBrowserSceneEventLinkBatchSnapshot(
    projectId: string,
    journalId: string,
    direction: "undo" | "redo",
    beforeRaw: SqlValue,
    afterRaw: SqlValue,
  ): void {
    const source = parseBrowserSceneEventLinkBatchSnapshot(
      direction === "undo" ? afterRaw : beforeRaw,
      journalId,
    );
    const target = parseBrowserSceneEventLinkBatchSnapshot(
      direction === "undo" ? beforeRaw : afterRaw,
      journalId,
    );
    if (
      source.eventId !== target.eventId ||
      JSON.stringify(source.sceneIds) !== JSON.stringify(target.sceneIds)
    ) {
      throw new Error(
        `scene event batch journal '${journalId}' has mismatched association identity`,
      );
    }
    if (
      source.linked === target.linked &&
      source.linked &&
      JSON.stringify(source.incarnationTokens) !==
        JSON.stringify(target.incarnationTokens)
    ) {
      throw new Error(
        `scene event batch journal '${journalId}' has mismatched no-op incarnations`,
      );
    }
    validateBrowserSceneEventLinkBatchScope(projectId, source);
    validateBrowserSceneEventLinkBatchSource(source);

    if (source.linked && !target.linked) {
      for (const sceneId of source.sceneIds) {
        db.run(
          `DELETE FROM scene_events
            WHERE scene_id = ? AND event_id = ? AND incarnation_token = ?`,
          [sceneId, source.eventId, source.incarnationTokens?.[sceneId] ?? ""],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(
            `scene-event association '${sceneId}' incarnation conflict during journal replay`,
          );
        }
      }
    } else if (!source.linked && target.linked) {
      const freshTokens: Record<string, string> = {};
      for (const sceneId of target.sceneIds) {
        const token = crypto.randomUUID();
        db.run(
          `INSERT INTO scene_events (scene_id, event_id, incarnation_token)
           VALUES (?, ?, ?)`,
          [sceneId, target.eventId, token],
        );
        if (db.getRowsModified() !== 1) {
          throw new Error(
            `scene-event association '${sceneId}' changed before insertion`,
          );
        }
        freshTokens[sceneId] = token;
      }
      const updatedTarget: BrowserSceneEventLinkBatchSnapshot = {
        ...target,
        ...(target.sceneIds.length > 0
          ? { incarnationTokens: freshTokens }
          : {}),
      };
      db.run(
        `UPDATE undo_journal SET ${
          direction === "undo" ? "before_json" : "after_json"
        } = ? WHERE id = ? AND project_id = ?`,
        [JSON.stringify(updatedTarget), journalId, projectId],
      );
      if (db.getRowsModified() !== 1) {
        throw new Error(
          `scene event batch journal '${journalId}' disappeared during replay`,
        );
      }
      for (const sceneId of target.sceneIds) {
        rewriteBrowserSceneEventJournalIncarnationChain(
          projectId,
          target.eventId,
          journalId,
          sceneId,
          target.incarnationTokens?.[sceneId] ?? "",
          freshTokens[sceneId],
        );
      }
    }
  }

  async function handleAgentSceneEventLinkBatch(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const command = "agent_scene_event_link_batch";
    const p = browserCommandPayload(command, args);
    const requestId = requiredBrowserString(command, p, "requestId");
    const projectId = requiredBrowserString(command, p, "projectId");
    const sessionId = requiredBrowserString(command, p, "sessionId");
    const eventId = requiredBrowserString(command, p, "eventId");
    if (!Array.isArray(p.sceneIds) || p.sceneIds.length === 0) {
      throw new Error(
        "agent scene event link batch sceneIds must not be empty",
      );
    }
    if (p.sceneIds.length > MAX_BROWSER_SCENE_EVENT_LINK_BATCH_SIZE) {
      throw new Error(
        `agent scene event link batch sceneIds must contain at most ${MAX_BROWSER_SCENE_EVENT_LINK_BATCH_SIZE} ids`,
      );
    }
    p.sceneIds.forEach((sceneId, index) => {
      if (typeof sceneId !== "string" || sceneId.length === 0) {
        throw new Error(
          `agent scene event link batch sceneIds[${index}] must be a non-empty string`,
        );
      }
    });
    const sceneIds = [...new Set(p.sceneIds as string[])].sort();
    if (sceneIds.length > MAX_BROWSER_SCENE_EVENT_LINK_BATCH_SIZE) {
      throw new Error(
        `agent scene event link batch deduped sceneIds must contain at most ${MAX_BROWSER_SCENE_EVENT_LINK_BATCH_SIZE} ids`,
      );
    }
    const surface = String(p.surface ?? "in-app-agent");

    return withAppendLedgerLock(async () => {
      const requestHash = await browserPayloadFingerprint(command, {
        projectId,
        eventId,
        sceneIds,
      });
      const replayLedger = queryOne(
        `SELECT payload_hash FROM idempotency_requests
          WHERE domain = ? AND request_id = ?`,
        [command, requestId],
      );
      if (replayLedger) {
        if (String(replayLedger.payload_hash) !== requestHash) {
          throw new Error(
            "AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT: request id reused with different payload",
          );
        }
        const journal = queryOne(
          `SELECT result_version, change_event_uid, after_json
             FROM undo_journal
            WHERE id = ? AND project_id = ? AND entity_kind = 'event'
              AND entity_id = ? AND op_kind = 'update'`,
          [requestId, projectId, eventId],
        );
        if (!journal) {
          throw new Error(
            "AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT: original receipt is missing",
          );
        }
        const current = collectBrowserSceneEventLinkBatchState(
          eventId,
          sceneIds,
        );
        const originalAfter = parseBrowserSceneEventLinkBatchSnapshot(
          journal.after_json,
          requestId,
        );
        const currentBySceneId = new Map(
          current.sceneLinks.map((link) => [link.sceneId, link]),
        );
        const ownedDeltaMatches = originalAfter.sceneIds.every((sceneId) => {
          const link = currentBySceneId.get(sceneId);
          return (
            link?.linked === true &&
            link.incarnationToken === originalAfter.incarnationTokens?.[sceneId]
          );
        });
        if (
          current.sceneLinks.some((link) => !link.linked) ||
          !ownedDeltaMatches
        ) {
          throw new Error(
            "AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT: association state changed after original request",
          );
        }
        return {
          entityId: eventId,
          version: Number(journal.result_version),
          changeEventUid: String(journal.change_event_uid),
          undoJournalId: requestId,
        };
      }

      const capturedRequestedState = collectBrowserSceneEventLinkBatchState(
        eventId,
        sceneIds,
      );
      const addedSceneIds = capturedRequestedState.sceneLinks
        .filter((link) => !link.linked)
        .map((link) => link.sceneId);
      const eventUid = crypto.randomUUID();
      const timestamp = Date.now();
      const preparedEvent = await prepareBrowserTrackedChangeEvent({
        eventUid,
        projectId,
        sceneId: null,
        domain: "event",
        opType: "event.stamp",
        entityType: "event",
        entityId: eventId,
        payload: JSON.stringify({
          eventId,
          sceneIds: addedSceneIds,
          requestHash,
        }),
        sessionId,
        timestamp,
      });
      const now = new Date(timestamp).toISOString();
      db.run("BEGIN IMMEDIATE");
      try {
        const event = queryOne(
          "SELECT version FROM events WHERE id = ? AND project_id = ?",
          [eventId, projectId],
        );
        if (!event) {
          throw new Error(
            `event '${eventId}' not found in project '${projectId}'`,
          );
        }
        const eventVersion = Number(event.version);
        for (const sceneId of sceneIds) {
          if (
            !queryOne(
              `SELECT 1 AS owned FROM tree_nodes
                WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
              [sceneId, projectId],
            )
          ) {
            throw new Error(
              `scene '${sceneId}' not found in project '${projectId}'`,
            );
          }
        }
        const currentRequestedState = collectBrowserSceneEventLinkBatchState(
          eventId,
          sceneIds,
        );
        if (
          JSON.stringify(currentRequestedState) !==
          JSON.stringify(capturedRequestedState)
        ) {
          throw new Error(
            "AGENT_SCENE_EVENT_LINK_BATCH_STATE_DRIFT: association state changed while preparing the request",
          );
        }
        const before = browserSceneEventLinkBatchSnapshot(
          eventId,
          addedSceneIds,
          false,
        );
        const addedIncarnations: Record<string, string> = {};
        for (const sceneId of addedSceneIds) {
          const incarnationToken = crypto.randomUUID();
          db.run(
            `INSERT INTO scene_events (scene_id, event_id, incarnation_token)
             VALUES (?, ?, ?)`,
            [sceneId, eventId, incarnationToken],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(
              `scene-event association '${sceneId}' changed before insertion`,
            );
          }
          addedIncarnations[sceneId] = incarnationToken;
        }
        const after = browserSceneEventLinkBatchSnapshot(
          eventId,
          addedSceneIds,
          true,
          addedIncarnations,
        );
        insertPreparedBrowserTrackedChangeEvent(preparedEvent);
        db.run(
          `INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind,
             before_json, after_json, base_version, result_version,
             change_event_uid, created_at)
           VALUES (?, ?, ?, 'event', ?, 'update', ?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            projectId,
            surface,
            eventId,
            JSON.stringify(before),
            JSON.stringify(after),
            eventVersion,
            eventVersion,
            eventUid,
            now,
          ],
        );
        db.run(
          `INSERT INTO idempotency_requests
            (domain, request_id, project_id, payload_hash, tombstone_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            command,
            requestId,
            projectId,
            requestHash,
            JSON.stringify({ id: eventId }),
            now,
          ],
        );
        db.run("COMMIT");
        options.onDatabaseDirty?.();
        return {
          entityId: eventId,
          version: eventVersion,
          changeEventUid: eventUid,
          undoJournalId: requestId,
        };
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original batch-link failure.
        }
        throw error;
      }
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

  interface PreparedBrowserTrackedChangeEvent {
    eventUid: string;
    projectId: string;
    sceneId: string | null;
    domain: string;
    opType: string;
    entityType: string | null;
    entityId: string | null;
    payload: string;
    sessionId: string;
    sequence: number;
    timestamp: number;
    prevHash: string;
    hash: string;
    capturedTail: { sequence: number; hash: string };
  }

  async function prepareBrowserTrackedChangeEvent(input: {
    eventUid: string;
    projectId: string;
    sceneId: string | null;
    domain: string;
    opType: string;
    entityType: string | null;
    entityId: string | null;
    payload: string;
    sessionId: string;
    timestamp: number;
  }): Promise<PreparedBrowserTrackedChangeEvent> {
    const capturedTail = readTimelapseTail(input.projectId);
    const sequence = capturedTail.sequence + 1;
    const hash = bytesToHex(
      await computeEventHash({
        projectId: input.projectId,
        sceneId: input.sceneId,
        domain: input.domain,
        opType: input.opType,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
        sessionId: input.sessionId,
        sequence,
        timestamp: input.timestamp,
        prevHash: hexToBytes(capturedTail.hash),
      }),
    );
    return {
      ...input,
      sequence,
      prevHash: capturedTail.hash,
      hash,
      capturedTail,
    };
  }

  function insertPreparedBrowserTrackedChangeEvent(
    prepared: PreparedBrowserTrackedChangeEvent,
  ): void {
    const currentTail = readTimelapseTail(prepared.projectId);
    if (
      currentTail.sequence !== prepared.capturedTail.sequence ||
      currentTail.hash !== prepared.capturedTail.hash
    ) {
      throw new Error(
        "TIMELAPSE_TAIL_DRIFT: change-event tail changed during hash preparation",
      );
    }
    db.run(
      `INSERT INTO change_events
        (event_uid, project_id, scene_id, domain, op_type, entity_type,
         entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prepared.eventUid,
        prepared.projectId,
        prepared.sceneId,
        prepared.domain,
        prepared.opType,
        prepared.entityType,
        prepared.entityId,
        prepared.payload,
        prepared.sessionId,
        prepared.sequence,
        prepared.timestamp,
        prepared.prevHash,
        prepared.hash,
      ],
    );
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

  let appendLedgerQueue: Promise<void> = Promise.resolve();

  function withAppendLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = appendLedgerQueue.then(operation, operation);
    appendLedgerQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function handleTimelapseAppendBatch(
    args: Record<string, unknown>,
  ): Promise<{
    insertedCount: number;
    tailSequence: number;
    tailHash: string;
  }> {
    return withAppendLedgerLock(async () => {
      const projectId = args.projectId as string;
      const sessionId = args.sessionId as string;
      const events = (args.events ?? []) as TimelapseAppendEvent[];

      // Per-event idempotency (mirror of the Rust allocator): a committed-but-
      // rejected flush can be re-sent merged with new events; skip the
      // already-present uids and append only the genuinely-new suffix so the
      // merged-in events are never dropped.
      const firstUid = events[0]?.eventUid;
      const firstPresent = firstUid
        ? eventUidExists(projectId, firstUid)
        : false;

      const capturedTail = readTimelapseTail(projectId);
      let sequence = capturedTail.sequence;
      let prevHash = capturedTail.hash;
      const preparedEvents: Array<{
        event: TimelapseAppendEvent;
        sceneId: string | null;
        sequence: number;
        prevHash: string;
        hash: string;
      }> = [];
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
        preparedEvents.push({
          event: ev,
          sceneId,
          sequence,
          prevHash,
          hash,
        });
        prevHash = hash;
      }

      // WebCrypto yields to other browser-mock commands. Keep the SQLite
      // transaction itself yield-free, and refuse hashes derived from a tail
      // that changed while they were being prepared.
      db.run("BEGIN IMMEDIATE");
      try {
        const currentTail = readTimelapseTail(projectId);
        if (
          currentTail.sequence !== capturedTail.sequence ||
          currentTail.hash !== capturedTail.hash
        ) {
          throw new Error(
            "TIMELAPSE_TAIL_DRIFT: change-event tail changed during hash preparation",
          );
        }
        for (const prepared of preparedEvents) {
          const ev = prepared.event;
          db.run(
            "insert into change_events (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id, payload, session_id, sequence, timestamp, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              ev.eventUid,
              projectId,
              prepared.sceneId,
              ev.domain,
              ev.opType,
              ev.entityType,
              ev.entityId,
              ev.payload,
              sessionId,
              prepared.sequence,
              ev.timestamp,
              prepared.prevHash,
              prepared.hash,
            ],
          );
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the append failure.
        }
        throw error;
      }
      const insertedCount = preparedEvents.length;
      if (insertedCount > 0) {
        options.onDatabaseDirty?.();
      }
      return {
        insertedCount,
        tailSequence: sequence,
        tailHash: prevHash,
      };
    });
  }

  function browserAiAuditProjectId(
    args: Record<string, unknown>,
  ): string | null {
    if (!("projectId" in args)) {
      throw new Error("projectId must be a non-empty string or null");
    }
    if (args.projectId === null) return null;
    if (
      typeof args.projectId !== "string" ||
      !args.projectId.trim() ||
      args.projectId !== args.projectId.trim()
    ) {
      throw new Error("projectId must be a non-empty string or null");
    }
    return args.projectId;
  }

  function assertBrowserAiAuditWorkspace(args: Record<string, unknown>): void {
    if (
      typeof args.expectedWorkspacePath !== "string" ||
      !args.expectedWorkspacePath.trim()
    ) {
      throw new Error("expectedWorkspacePath is required");
    }
    const settingsIdentity = handleGetGlobalSettings().lastActiveWorkspace;
    const activeIdentity =
      options.workspaceIdentity ??
      (typeof settingsIdentity === "string" && settingsIdentity.trim()
        ? settingsIdentity
        : BROWSER_WORKSPACE_PATH);
    if (args.expectedWorkspacePath !== activeIdentity) {
      throw new Error(
        `AI_AUDIT_WORKSPACE_CHANGED: expected ${args.expectedWorkspacePath}, active ${activeIdentity}`,
      );
    }
  }

  function assertBrowserSemanticIndexAuthority(
    args: Record<string, unknown>,
  ): void {
    assertBrowserAiAuditWorkspace(args);
    if (args.projectId !== "default-project") {
      throw new Error(
        `SEMANTIC_INDEX_AUTHORITY_MISMATCH: expected default-project, received ${String(args.projectId)}`,
      );
    }
  }

  function browserAiAuditScopeId(projectId: string | null): string {
    return projectId === null ? "workspace" : `project:${projectId}`;
  }

  function readBrowserAiAuditTail(scopeId: string): {
    sequence: number;
    hash: string;
  } {
    const row = queryOne(
      `SELECT sequence, hash FROM ai_audit_events
        WHERE scope_id = ? ORDER BY sequence DESC LIMIT 1`,
      [scopeId],
    );
    return row
      ? { sequence: Number(row.sequence), hash: String(row.hash) }
      : { sequence: 0, hash: AI_AUDIT_GENESIS_HASH };
  }

  function browserAiAuditHighWaterHash(
    scopeId: string,
    highWaterSequence: number,
    tail: { sequence: number; hash: string },
  ): string {
    if (highWaterSequence === 0) return AI_AUDIT_GENESIS_HASH;
    if (highWaterSequence === tail.sequence) return tail.hash;
    const row = queryOne(
      "SELECT hash FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
      [scopeId, highWaterSequence],
    );
    if (!row) throw new Error("high-water event is missing");
    return String(row.hash);
  }

  function browserAiAuditRow(row: Record<string, SqlValue>) {
    return {
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      scopeId: String(row.scope_id),
      projectId: row.project_id == null ? null : String(row.project_id),
      executionId: String(row.execution_id),
      operationId: String(row.operation_id),
      parentExecutionId:
        row.parent_execution_id == null
          ? null
          : String(row.parent_execution_id),
      pathId: String(row.path_id),
      eventType: String(row.event_type),
      timestamp: Number(row.timestamp),
      recordedAt: Number(row.recorded_at),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      payloadSha256: String(row.payload_sha256),
      prevHash: String(row.prev_hash),
      hash: String(row.hash),
    };
  }

  async function handleAiAuditAppendBatch(args: Record<string, unknown>) {
    return withAppendLedgerLock(async () => {
      assertBrowserAiAuditWorkspace(args);
      const projectId = browserAiAuditProjectId(args);
      const scopeId = browserAiAuditScopeId(projectId);
      if (
        !Array.isArray(args.events) ||
        args.events.length < 1 ||
        args.events.length > 256
      ) {
        throw new Error("events must contain 1..256 entries");
      }
      const events = args.events as BrowserAiAuditEventInput[];
      events.forEach(validateBrowserAiAuditEvent);
      let { sequence, hash: prevHash } = readBrowserAiAuditTail(scopeId);
      const materializedEvents = new Map<
        string,
        AiAuditJournalMaterializedEvent
      >();
      const preparedEvents: Array<{
        event: BrowserAiAuditEventInput;
        payload: string;
        payloadSha256: string;
        sequence: number;
        recordedAt: number;
        prevHash: string;
        hash: string;
        materialized: AiAuditJournalMaterializedEvent;
      }> = [];
      const preparedEventIds = new Map<
        string,
        {
          event: BrowserAiAuditEventInput;
          payloadSha256: string;
          materialized: AiAuditJournalMaterializedEvent;
        }
      >();
      const executionStates = new Map<string, BrowserAiAuditExecutionState>();

      for (const event of events) {
        const payload = canonicalAiAuditPayloadForAppend(event.payload);
        const payloadSha256 = await sha256AuditHex(payload);
        const existing = queryOne(
          `SELECT sequence, event_id, scope_id, project_id, execution_id,
                  operation_id, parent_execution_id, path_id, event_type,
                  timestamp, recorded_at, payload, payload_sha256, prev_hash, hash
             FROM ai_audit_events
            WHERE scope_id = ? AND event_id = ?`,
          [scopeId, event.eventId],
        );
        const sameEvent = (candidate: {
          event: BrowserAiAuditEventInput;
          payloadSha256: string;
        }) =>
          candidate.event.executionId === event.executionId &&
          candidate.event.operationId === event.operationId &&
          candidate.event.parentExecutionId === event.parentExecutionId &&
          candidate.event.pathId === event.pathId &&
          candidate.event.eventType === event.eventType &&
          candidate.event.timestamp === event.timestamp &&
          candidate.payloadSha256 === payloadSha256;
        if (existing) {
          const same =
            existing.execution_id === event.executionId &&
            existing.operation_id === event.operationId &&
            existing.parent_execution_id === event.parentExecutionId &&
            existing.path_id === event.pathId &&
            existing.event_type === event.eventType &&
            Number(existing.timestamp) === event.timestamp &&
            existing.payload_sha256 === payloadSha256;
          if (!same) {
            throw new Error(
              `eventId collision with different AI audit payload: ${event.eventId}`,
            );
          }
          const materialized = browserAiAuditRow(existing);
          materializedEvents.set(materialized.eventId, materialized);
          continue;
        }
        const preparedDuplicate = preparedEventIds.get(event.eventId);
        if (preparedDuplicate) {
          if (!sameEvent(preparedDuplicate)) {
            throw new Error(
              `eventId collision with different AI audit payload: ${event.eventId}`,
            );
          }
          materializedEvents.set(
            preparedDuplicate.materialized.eventId,
            preparedDuplicate.materialized,
          );
          continue;
        }

        let identity = executionStates.get(event.executionId);
        if (!identity) {
          const storedEvents = queryAll(
            `SELECT operation_id, parent_execution_id, path_id, event_type
               FROM ai_audit_events
              WHERE scope_id = ? AND execution_id = ?
              ORDER BY sequence ASC`,
            [scopeId, event.executionId],
          );
          const storedIdentity = storedEvents[0];
          if (storedIdentity) {
            identity = {
              operationId: String(storedIdentity.operation_id),
              parentExecutionId:
                storedIdentity.parent_execution_id == null
                  ? null
                  : String(storedIdentity.parent_execution_id),
              pathId: String(storedIdentity.path_id),
              started: false,
              preparedBeforeDispatch: false,
              dispatched: false,
              responseCompleted: false,
              terminalEventType: null,
            };
            storedEvents.forEach((storedEvent) => {
              observeBrowserAiAuditLifecycleEvent(
                identity!,
                String(storedEvent.event_type),
              );
            });
            executionStates.set(event.executionId, identity);
          }
        }
        if (identity) {
          if (
            identity.operationId !== event.operationId ||
            identity.parentExecutionId !== event.parentExecutionId ||
            identity.pathId !== event.pathId
          ) {
            throw new Error(
              `execution identity mismatch for AI audit execution: ${event.executionId}`,
            );
          }
          if (identity.terminalEventType) {
            throw new Error(
              `AI audit execution already reached terminal event ${identity.terminalEventType}: ${event.executionId}`,
            );
          }
          validateBrowserAiAuditLifecycleTransition(identity, event);
        } else {
          validateBrowserAiAuditLifecycleTransition(null, event);
          identity = {
            operationId: event.operationId,
            parentExecutionId: event.parentExecutionId,
            pathId: event.pathId,
            started: false,
            preparedBeforeDispatch: false,
            dispatched: false,
            responseCompleted: false,
            terminalEventType: null,
          };
          executionStates.set(event.executionId, identity);
        }

        sequence += 1;
        const recordedAt = Date.now();
        const hash = await browserAiAuditHash({
          scopeId,
          projectId,
          sequence,
          eventId: event.eventId,
          executionId: event.executionId,
          operationId: event.operationId,
          parentExecutionId: event.parentExecutionId,
          pathId: event.pathId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          recordedAt,
          payloadSha256,
          prevHash,
        });
        const materialized: AiAuditJournalMaterializedEvent = {
          sequence,
          scopeId,
          projectId,
          eventId: event.eventId,
          executionId: event.executionId,
          operationId: event.operationId,
          parentExecutionId: event.parentExecutionId,
          pathId: event.pathId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          recordedAt,
          payload: JSON.parse(payload) as Record<string, unknown>,
          payloadSha256,
          prevHash,
          hash,
        };
        preparedEvents.push({
          event,
          payload,
          payloadSha256,
          sequence,
          recordedAt,
          prevHash,
          hash,
          materialized,
        });
        preparedEventIds.set(event.eventId, {
          event,
          payloadSha256,
          materialized,
        });
        materializedEvents.set(event.eventId, materialized);
        observeBrowserAiAuditLifecycleEvent(identity, event.eventType);
        prevHash = hash;
      }
      const orderedMaterializedEvents = [...materializedEvents.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const firstMaterializedEvent = orderedMaterializedEvents[0];
      const journalBatch = await browserAiAuditJournalBatch({
        journalVersion: AI_AUDIT_JOURNAL_FORMAT_VERSION,
        auditSchemaVersion: AI_AUDIT_SCHEMA_VERSION,
        captureContractVersion: AI_AUDIT_CAPTURE_CONTRACT_VERSION,
        expectedWorkspacePath: String(args.expectedWorkspacePath),
        projectId,
        scopeId,
        baseSequence: firstMaterializedEvent
          ? firstMaterializedEvent.sequence - 1
          : sequence,
        baseTailHash: firstMaterializedEvent?.prevHash ?? prevHash,
        events: orderedMaterializedEvents,
      });
      // The external journal is the recovery source. Persist it before SQLite
      // so a crash cannot leave a committed audit tail with no replay record.
      // withAppendLedgerLock keeps another append from materializing against
      // this batch while the journal durability barrier is pending.
      await options.onAiAuditDurabilityRequired?.(journalBatch);

      // All async hashing and journal durability are complete. Nothing between
      // BEGIN and COMMIT may yield, otherwise unrelated browser DB commands can
      // join this txn.
      db.run("BEGIN IMMEDIATE");
      try {
        for (const prepared of preparedEvents) {
          const event = prepared.event;
          db.run(
            `INSERT INTO ai_audit_events
              (scope_id, project_id, sequence, event_id, execution_id, operation_id,
               parent_execution_id, path_id, event_type, timestamp, recorded_at,
               payload, payload_sha256, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              scopeId,
              projectId,
              prepared.sequence,
              event.eventId,
              event.executionId,
              event.operationId,
              event.parentExecutionId,
              event.pathId,
              event.eventType,
              event.timestamp,
              prepared.recordedAt,
              prepared.payload,
              prepared.payloadSha256,
              prepared.prevHash,
              prepared.hash,
            ],
          );
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the append failure.
        }
        throw error;
      }
      const insertedCount = preparedEvents.length;
      if (insertedCount > 0) options.onDatabaseDirty?.();
      return { insertedCount, tailSequence: sequence, tailHash: prevHash };
    });
  }

  function parseAiAuditMaterializedBatch(
    args: Record<string, unknown>,
    projectId: string | null,
    scopeId: string,
  ): AiAuditJournalMaterializedBatch {
    if (args.journalVersion !== AI_AUDIT_JOURNAL_FORMAT_VERSION) {
      throw new Error("unsupported AI audit journal version");
    }
    if (args.auditSchemaVersion !== AI_AUDIT_SCHEMA_VERSION) {
      throw new Error("unsupported AI audit schema version");
    }
    if (args.captureContractVersion !== AI_AUDIT_CAPTURE_CONTRACT_VERSION) {
      throw new Error("unsupported AI audit capture contract version");
    }
    if (args.scopeId !== scopeId) {
      throw new Error("AI audit journal scope does not match project");
    }
    if (
      !Number.isSafeInteger(args.baseSequence) ||
      Number(args.baseSequence) < 0
    ) {
      throw new Error("AI audit journal baseSequence is invalid");
    }
    if (
      typeof args.baseTailHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(args.baseTailHash)
    ) {
      throw new Error("AI audit journal baseTailHash is invalid");
    }
    if (
      !Array.isArray(args.events) ||
      args.events.length < 1 ||
      args.events.length > 256
    ) {
      throw new Error("AI audit journal events must contain 1..256 rows");
    }
    const events = args.events.map((candidate, index) => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        throw new Error(`AI audit journal events[${index}] is invalid`);
      }
      const row = candidate as Record<string, unknown>;
      const event: AiAuditJournalMaterializedEvent = {
        sequence: Number(row.sequence),
        scopeId: String(row.scopeId),
        projectId: row.projectId === null ? null : String(row.projectId),
        eventId: String(row.eventId),
        executionId: String(row.executionId),
        operationId: String(row.operationId),
        parentExecutionId:
          row.parentExecutionId === null ? null : String(row.parentExecutionId),
        pathId: String(row.pathId),
        eventType: String(row.eventType),
        timestamp: Number(row.timestamp),
        recordedAt: Number(row.recordedAt),
        payload: row.payload as Record<string, unknown>,
        payloadSha256: String(row.payloadSha256),
        prevHash: String(row.prevHash),
        hash: String(row.hash),
      };
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        !Number.isSafeInteger(event.recordedAt) ||
        event.recordedAt < 0 ||
        event.scopeId !== scopeId ||
        event.projectId !== projectId ||
        !/^[0-9a-f]{64}$/u.test(event.payloadSha256) ||
        !/^[0-9a-f]{64}$/u.test(event.prevHash) ||
        !/^[0-9a-f]{64}$/u.test(event.hash)
      ) {
        throw new Error(
          `AI audit journal events[${index}] has invalid row data`,
        );
      }
      validateBrowserAiAuditEvent(
        {
          eventId: event.eventId,
          executionId: event.executionId,
          operationId: event.operationId,
          parentExecutionId: event.parentExecutionId,
          pathId: event.pathId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          payload: event.payload,
        },
        index,
      );
      return event;
    });
    return {
      journalVersion: AI_AUDIT_JOURNAL_FORMAT_VERSION,
      auditSchemaVersion: AI_AUDIT_SCHEMA_VERSION,
      captureContractVersion: AI_AUDIT_CAPTURE_CONTRACT_VERSION,
      expectedWorkspacePath: String(args.expectedWorkspacePath),
      projectId,
      scopeId,
      baseSequence: Number(args.baseSequence),
      baseTailHash: args.baseTailHash,
      events,
    };
  }

  function materializedEventsEqual(
    left: AiAuditJournalMaterializedEvent,
    right: AiAuditJournalMaterializedEvent,
  ): boolean {
    const scalarKeys = [
      "sequence",
      "scopeId",
      "projectId",
      "eventId",
      "executionId",
      "operationId",
      "parentExecutionId",
      "pathId",
      "eventType",
      "timestamp",
      "recordedAt",
      "payloadSha256",
      "prevHash",
      "hash",
    ] as const;
    if (scalarKeys.some((key) => left[key] !== right[key])) return false;
    return (
      JSON.stringify(canonicalizeAiAuditJson(left.payload)) ===
      JSON.stringify(canonicalizeAiAuditJson(right.payload))
    );
  }

  async function verifyMaterializedAiAuditEvent(
    event: AiAuditJournalMaterializedEvent,
  ): Promise<void> {
    const contractError = validateStoredAiAuditCaptureContract(event.payload);
    if (contractError) {
      throw new Error(
        `AI audit journal payload contract mismatch: ${contractError}`,
      );
    }
    const payload = canonicalStoredAiAuditPayload(event.payload);
    const payloadSha256 = await sha256AuditHex(payload);
    if (payloadSha256 !== event.payloadSha256) {
      throw new Error(
        `AI audit journal payloadSha256 mismatch: ${event.eventId}`,
      );
    }
    const hash = await browserAiAuditHash({
      scopeId: event.scopeId,
      projectId: event.projectId,
      sequence: event.sequence,
      eventId: event.eventId,
      executionId: event.executionId,
      operationId: event.operationId,
      parentExecutionId: event.parentExecutionId,
      pathId: event.pathId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      recordedAt: event.recordedAt,
      payloadSha256: event.payloadSha256,
      prevHash: event.prevHash,
    });
    if (hash !== event.hash) {
      throw new Error(`AI audit journal hash mismatch: ${event.eventId}`);
    }
  }

  async function handleAiAuditRestoreBatch(args: Record<string, unknown>) {
    return withAppendLedgerLock(async () => {
      assertBrowserAiAuditWorkspace(args);
      const projectId = browserAiAuditProjectId(args);
      const scopeId = browserAiAuditScopeId(projectId);
      const batch = parseAiAuditMaterializedBatch(args, projectId, scopeId);
      let previousSequence = batch.baseSequence;
      let previousHash = batch.baseTailHash;
      const eventIds = new Set<string>();
      for (const event of batch.events) {
        if (
          event.sequence !== previousSequence + 1 ||
          event.prevHash !== previousHash ||
          eventIds.has(event.eventId)
        ) {
          throw new Error("AI audit journal chain is not contiguous");
        }
        eventIds.add(event.eventId);
        await verifyMaterializedAiAuditEvent(event);
        previousSequence = event.sequence;
        previousHash = event.hash;
      }

      const existingEvents = new Map<string, AiAuditJournalMaterializedEvent>();
      let firstMissingIndex = -1;
      batch.events.forEach((event, index) => {
        const row = queryOne(
          `SELECT sequence, event_id, scope_id, project_id, execution_id,
                  operation_id, parent_execution_id, path_id, event_type,
                  timestamp, recorded_at, payload, payload_sha256, prev_hash, hash
             FROM ai_audit_events
            WHERE scope_id = ? AND event_id = ?`,
          [scopeId, event.eventId],
        );
        if (!row) {
          firstMissingIndex = firstMissingIndex < 0 ? index : firstMissingIndex;
          return;
        }
        const stored = browserAiAuditRow(row);
        existingEvents.set(event.eventId, stored);
        if (!materializedEventsEqual(stored, event)) {
          throw new Error(
            `AI audit journal row differs from SQLite: ${event.eventId}`,
          );
        }
      });
      if (firstMissingIndex < 0) {
        const tail = readBrowserAiAuditTail(scopeId);
        return {
          insertedCount: 0,
          tailSequence: tail.sequence,
          tailHash: tail.hash,
        };
      }

      const priorSequence =
        firstMissingIndex === 0
          ? batch.baseSequence
          : batch.events[firstMissingIndex - 1].sequence;
      const priorHash =
        firstMissingIndex === 0
          ? batch.baseTailHash
          : batch.events[firstMissingIndex - 1].hash;
      const tail = readBrowserAiAuditTail(scopeId);
      if (tail.sequence !== priorSequence || tail.hash !== priorHash) {
        throw new Error(
          "AI audit journal restore would create a sequence gap or rewrite the tail",
        );
      }
      if (
        batch.events
          .slice(firstMissingIndex)
          .some((event) => existingEvents.has(event.eventId))
      ) {
        throw new Error("AI audit journal has an existing row after a gap");
      }

      db.run("BEGIN IMMEDIATE");
      try {
        for (const event of batch.events.slice(firstMissingIndex)) {
          db.run(
            `INSERT INTO ai_audit_events
              (scope_id, project_id, sequence, event_id, execution_id, operation_id,
               parent_execution_id, path_id, event_type, timestamp, recorded_at,
               payload, payload_sha256, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              event.scopeId,
              event.projectId,
              event.sequence,
              event.eventId,
              event.executionId,
              event.operationId,
              event.parentExecutionId,
              event.pathId,
              event.eventType,
              event.timestamp,
              event.recordedAt,
              canonicalStoredAiAuditPayload(event.payload),
              event.payloadSha256,
              event.prevHash,
              event.hash,
            ],
          );
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Preserve the original restore failure.
        }
        throw error;
      }
      options.onDatabaseDirty?.();
      const restoredTail = batch.events.at(-1)!;
      return {
        insertedCount: batch.events.length - firstMissingIndex,
        tailSequence: restoredTail.sequence,
        tailHash: restoredTail.hash,
      };
    });
  }

  async function handleAiAuditReadSnapshot(args: Record<string, unknown>) {
    return withAppendLedgerLock(async () => {
      assertBrowserAiAuditWorkspace(args);
      const projectId = browserAiAuditProjectId(args);
      const scopeId = browserAiAuditScopeId(projectId);
      const afterSequence =
        args.afterSequence == null ? 0 : Number(args.afterSequence);
      const limit = args.limit == null ? 500 : Number(args.limit);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new Error("afterSequence must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("limit must be between 1 and 1000");
      }
      const tail = readBrowserAiAuditTail(scopeId);
      const highWaterSequence =
        args.highWaterSequence == null
          ? tail.sequence
          : Number(args.highWaterSequence);
      if (
        !Number.isSafeInteger(highWaterSequence) ||
        highWaterSequence < afterSequence ||
        highWaterSequence > tail.sequence
      ) {
        throw new Error("highWaterSequence is outside the available range");
      }
      const highWaterHash = browserAiAuditHighWaterHash(
        scopeId,
        highWaterSequence,
        tail,
      );
      const rows = queryAll(
        `SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                parent_execution_id, path_id, event_type, timestamp, recorded_at,
                payload, payload_sha256, prev_hash, hash
           FROM ai_audit_events
          WHERE scope_id = ? AND sequence > ? AND sequence <= ?
          ORDER BY sequence ASC LIMIT ?`,
        [scopeId, afterSequence, highWaterSequence, limit],
      );
      const events = rows.map(browserAiAuditRow);
      const last = events.at(-1)?.sequence;
      return {
        scopeId,
        projectId,
        afterSequence,
        highWaterSequence,
        highWaterHash,
        nextAfterSequence:
          events.length === limit &&
          last !== undefined &&
          last < highWaterSequence
            ? last
            : null,
        events,
      };
    });
  }

  async function handleAiAuditVerify(args: Record<string, unknown>) {
    return withAppendLedgerLock(async () => {
      assertBrowserAiAuditWorkspace(args);
      const projectId = browserAiAuditProjectId(args);
      const scopeId = browserAiAuditScopeId(projectId);
      const tail = readBrowserAiAuditTail(scopeId);
      const highWaterSequence =
        args.highWaterSequence == null
          ? tail.sequence
          : Number(args.highWaterSequence);
      if (
        !Number.isSafeInteger(highWaterSequence) ||
        highWaterSequence < 0 ||
        highWaterSequence > tail.sequence
      ) {
        throw new Error("highWaterSequence is outside the available range");
      }
      const highWaterHash = browserAiAuditHighWaterHash(
        scopeId,
        highWaterSequence,
        tail,
      );
      let expectedSequence = 1;
      let prevHash = AI_AUDIT_GENESIS_HASH;
      while (expectedSequence <= highWaterSequence) {
        const rows = queryAll(
          `SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                  parent_execution_id, path_id, event_type, timestamp, recorded_at,
                  payload, payload_sha256, prev_hash, hash
             FROM ai_audit_events
            WHERE scope_id = ? AND sequence >= ? AND sequence <= ?
            ORDER BY sequence ASC LIMIT 500`,
          [scopeId, expectedSequence, highWaterSequence],
        );
        if (rows.length === 0) {
          return {
            ok: false,
            verifiedThroughSequence: expectedSequence - 1,
            brokenAtSequence: expectedSequence,
            reason: "sequence gap before pinned high-water mark",
            tailHash: highWaterHash,
          };
        }
        for (const row of rows) {
          const event = browserAiAuditRow(row);
          const broken = (reason: string) => ({
            ok: false,
            verifiedThroughSequence: expectedSequence - 1,
            brokenAtSequence: expectedSequence,
            reason,
            tailHash: highWaterHash,
          });
          if (event.sequence !== expectedSequence) {
            return broken(
              `sequence gap: expected ${expectedSequence}, found ${event.sequence}`,
            );
          }
          if (event.prevHash !== prevHash) return broken("prevHash mismatch");
          const contractError = validateStoredAiAuditCaptureContract(
            event.payload,
          );
          if (contractError) {
            return broken(`stored payload contract mismatch: ${contractError}`);
          }
          const payload = canonicalStoredAiAuditPayload(event.payload);
          const payloadSha256 = await sha256AuditHex(payload);
          if (payloadSha256 !== event.payloadSha256) {
            return broken("payloadSha256 mismatch");
          }
          const hash = await browserAiAuditHash({
            scopeId: event.scopeId,
            projectId: event.projectId,
            sequence: event.sequence,
            eventId: event.eventId,
            executionId: event.executionId,
            operationId: event.operationId,
            parentExecutionId: event.parentExecutionId,
            pathId: event.pathId,
            eventType: event.eventType,
            timestamp: event.timestamp,
            recordedAt: event.recordedAt,
            payloadSha256: event.payloadSha256,
            prevHash: event.prevHash,
          });
          if (hash !== event.hash) return broken("hash mismatch");
          prevHash = event.hash;
          expectedSequence += 1;
        }
      }
      return {
        ok: true,
        verifiedThroughSequence: highWaterSequence,
        brokenAtSequence: null,
        reason: null,
        tailHash: highWaterHash,
      };
    });
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

  function browserTreeNodeRow(
    nodeId: string,
    projectId: string,
  ): Record<string, unknown> | null {
    const result = executeBrowserDbStatement(
      db,
      `SELECT id, project_id AS projectId, parent_id AS parentId,
        node_type AS nodeType, title, synopsis, intent,
        sort_order AS sortOrder, story_time_order AS storyTimeOrder,
        story_time_label AS storyTimeLabel,
        pov_character_id AS povCharacterId, location_id AS locationId,
        chronicle_start_time AS chronicleStartTime,
        chronicle_start_minute AS chronicleStartMinute,
        chronicle_start_granularity AS chronicleStartGranularity,
        chronicle_end_time AS chronicleEndTime,
        chronicle_end_minute AS chronicleEndMinute,
        chronicle_end_granularity AS chronicleEndGranularity,
        chronicle_precision AS chroniclePrecision, status, content,
        unplaced_beats_doc AS unplacedBeatsDoc, char_count AS charCount,
        unplaced_beat_preview AS unplacedBeatPreview,
        placed_beat_preview AS placedBeatPreview, source_uri AS sourceUri,
        source_mtime AS sourceMtime, archived_at AS archivedAt,
        context_mode AS contextMode, aliases,
        excluded_aliases AS excludedAliases, created_at AS createdAt,
        updated_at AS updatedAt, version
        FROM tree_nodes WHERE id = ? AND project_id = ?`,
      [nodeId, projectId],
    );
    return result.rows[0] ?? null;
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
      case "project_delete": {
        const command = "project_delete";
        const payload = browserCommandPayload(command, args);
        const projectId = requiredBrowserString(command, payload, "projectId");
        db.run("BEGIN IMMEDIATE");
        try {
          db.run("DELETE FROM lint_term_dictionary WHERE project_id = ?", [
            projectId,
          ]);
          db.run("DELETE FROM projects WHERE id = ?", [projectId]);
          if (db.getRowsModified() !== 1) {
            throw new Error(`project '${projectId}' not found`);
          }
          db.run("COMMIT");
          options.onDatabaseDirty?.();
        } catch (error) {
          try {
            db.run("ROLLBACK");
          } catch {
            // Preserve the original project deletion failure.
          }
          throw error;
        }
        return undefined as T;
      }
      case "agent_codex_create":
        return handleAgentCodexCreate(args) as T;
      case "agent_codex_update":
        return handleAgentCodexUpdate(args) as T;
      case "agent_codex_delete":
        return handleAgentCodexDelete(args) as T;
      case "agent_codex_mutate":
        return handleAgentCodexMutate(args) as T;
      case "agent_foreshadow_create":
        return (await handleAgentForeshadowCreate(args)) as T;
      case "agent_foreshadow_update":
        return (await handleAgentForeshadowUpdate(args)) as T;
      case "agent_scene_event_link_batch":
        return (await handleAgentSceneEventLinkBatch(args)) as T;
      case "agent_apply_undo_journal":
        return handleBrowserApplyUndoJournal(args) as T;
      case "editor_sticky_list":
        return listBrowserEditorStickies(args) as T;
      case "editor_sticky_create":
        return createBrowserEditorSticky(args) as T;
      case "editor_sticky_update":
        return updateBrowserEditorSticky(args) as T;
      case "editor_sticky_delete":
        return deleteBrowserEditorSticky(args) as T;
      case "ai_audit_append_batch":
        return (await handleAiAuditAppendBatch(args)) as T;
      case "ai_audit_restore_batch":
        return (await handleAiAuditRestoreBatch(args)) as T;
      case "ai_audit_read_snapshot":
        return (await handleAiAuditReadSnapshot(args)) as T;
      case "ai_audit_verify":
        return (await handleAiAuditVerify(args)) as T;
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
      case "lint_term_dictionary_list":
        return handleLintTermDictionaryList(args) as T;
      case "lint_term_dictionary_insert":
        return handleLintTermDictionaryInsert(args) as T;
      case "lint_term_dictionary_update":
        return handleLintTermDictionaryUpdate(args) as T;
      case "lint_term_dictionary_set_enabled":
        return handleLintTermDictionarySetEnabled(args) as T;
      case "lint_term_dictionary_delete":
        return handleLintTermDictionaryDelete(args) as T;
      case "event_get_version":
        return handleEventGetVersion(args) as T;
      case "event_set_participants":
        return handleEventSetParticipants(args) as T;
      case "project_calendar_upsert":
        return handleProjectCalendarUpsert(args) as T;
      case "authorship_replace_lane":
        handleAuthorshipReplaceLane(args);
        return undefined as T;
      case "entity_tags_set":
        handleEntityTagsSet(args);
        return undefined as T;
      case "codex_rename_undo":
        return handleCodexRenameUndo(args) as T;
      case "codex_rename_apply": {
        const renameResult = handleCodexRenameUndo(args);
        return {
          entityId: String((args.payload as Record<string, unknown>).entryId),
          version: renameResult.versions.at(-1)?.version ?? 0,
          versions: renameResult.versions,
          changeEventUid: crypto.randomUUID(),
          undoJournalId: crypto.randomUUID(),
        } as T;
      }
      case "scan_staging_project_create":
        handleScanStagingProjectCreate(args);
        return undefined as T;
      case "tree_plan_undo":
        handleTreePlanUndo(args);
        return undefined as T;
      case "tree_node_create": {
        const command = "tree_node_create";
        const payload = browserCommandPayload(command, args);
        const now = new Date().toISOString();
        const id = requiredBrowserString(command, payload, "id");
        const projectId = requiredBrowserString(command, payload, "projectId");
        const nodeType = requiredBrowserString(command, payload, "nodeType");
        const title = requiredBrowserString(command, payload, "title");
        const sortOrder = requiredBrowserString(command, payload, "sortOrder");
        if (!["folder", "scene", "note"].includes(nodeType)) {
          throw new Error(`${command}: invalid nodeType '${nodeType}'`);
        }
        const parentId = nullableBrowserString(command, payload, "parentId");
        const synopsis = nullableBrowserString(command, payload, "synopsis");
        const status = nullableBrowserString(command, payload, "status");
        const sourceUri = nullableBrowserString(command, payload, "sourceUri");
        const sourceMtime = nullableBrowserString(
          command,
          payload,
          "sourceMtime",
        );
        const content = nullableBrowserString(command, payload, "content");
        db.run("BEGIN IMMEDIATE");
        try {
          if (
            parentId !== null &&
            !queryOne(
              `SELECT 1 AS owned FROM tree_nodes
                WHERE id = ? AND project_id = ? AND node_type = 'folder'`,
              [parentId, projectId],
            )
          ) {
            throw new Error(
              `tree node parent '${parentId}' is not a folder in project '${projectId}'`,
            );
          }
          db.run(
            `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order, synopsis,
               status, source_uri, source_mtime, content, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              projectId,
              parentId,
              nodeType,
              title,
              sortOrder,
              synopsis,
              status,
              sourceUri,
              sourceMtime,
              content ?? "{}",
              now,
              now,
            ],
          );
          if (db.getRowsModified() !== 1) {
            throw new Error(`tree node '${id}' was not created`);
          }
          const row = browserTreeNodeRow(id, projectId);
          if (!row) throw new Error("tree node not found after create");
          db.run("COMMIT");
          options.onDatabaseDirty?.();
          return row as T;
        } catch (error) {
          try {
            db.run("ROLLBACK");
          } catch {
            // Preserve the tree create failure.
          }
          throw error;
        }
      }
      case "tree_node_delete": {
        const command = "tree_node_delete";
        const payload = browserCommandPayload(command, args);
        db.run("DELETE FROM tree_nodes WHERE id = ? AND project_id = ?", [
          requiredBrowserString(command, payload, "nodeId"),
          requiredBrowserString(command, payload, "projectId"),
        ]);
        if (db.getRowsModified() > 0) options.onDatabaseDirty?.();
        return undefined as T;
      }
      case "tree_node_patch": {
        const command = "tree_node_patch";
        const payload = browserCommandPayload(command, args);
        const projectId = requiredBrowserString(command, payload, "projectId");
        const nodeId = requiredBrowserString(command, payload, "nodeId");
        const updatedAt = requiredBrowserString(command, payload, "updatedAt");
        if (typeof payload.bumpVersion !== "boolean") {
          throw new Error(`${command}: bumpVersion must be a boolean`);
        }
        if (
          Object.hasOwn(payload, "baseVersion") &&
          (typeof payload.baseVersion !== "number" ||
            !Number.isSafeInteger(payload.baseVersion) ||
            payload.baseVersion < 0)
        ) {
          throw new Error(
            `${command}: baseVersion must be a non-negative integer`,
          );
        }
        if (
          payload.patch === null ||
          typeof payload.patch !== "object" ||
          Array.isArray(payload.patch)
        ) {
          throw new Error(`${command}: patch must be an object`);
        }
        const patch = payload.patch as Record<string, unknown>;
        const columnMap: Record<string, string> = {
          parentId: "parent_id",
          title: "title",
          synopsis: "synopsis",
          intent: "intent",
          sortOrder: "sort_order",
          storyTimeOrder: "story_time_order",
          storyTimeLabel: "story_time_label",
          povCharacterId: "pov_character_id",
          locationId: "location_id",
          chronicleStartTime: "chronicle_start_time",
          chronicleStartMinute: "chronicle_start_minute",
          chronicleStartGranularity: "chronicle_start_granularity",
          chronicleEndTime: "chronicle_end_time",
          chronicleEndMinute: "chronicle_end_minute",
          chronicleEndGranularity: "chronicle_end_granularity",
          chroniclePrecision: "chronicle_precision",
          status: "status",
          content: "content",
          unplacedBeatsDoc: "unplaced_beats_doc",
          charCount: "char_count",
          unplacedBeatPreview: "unplaced_beat_preview",
          placedBeatPreview: "placed_beat_preview",
          sourceUri: "source_uri",
          sourceMtime: "source_mtime",
          archivedAt: "archived_at",
          contextMode: "context_mode",
          aliases: "aliases",
          excludedAliases: "excluded_aliases",
        };
        db.run("BEGIN IMMEDIATE");
        try {
          const parentId = Object.hasOwn(patch, "parentId")
            ? nullableBrowserString(command, patch, "parentId")
            : null;
          if (parentId !== null && parentId === nodeId) {
            throw new Error("tree node cannot be its own parent");
          }
          if (
            Object.hasOwn(patch, "parentId") &&
            parentId !== null &&
            !queryOne(
              `SELECT 1 AS owned FROM tree_nodes
                WHERE id = ? AND project_id = ? AND node_type = 'folder'`,
              [parentId, projectId],
            )
          ) {
            throw new Error(
              `tree node parent '${parentId}' is not a folder in project '${projectId}'`,
            );
          }
          if (
            Object.hasOwn(patch, "parentId") &&
            parentId !== null &&
            queryOne(
              `WITH RECURSIVE ancestors(id, parent_id) AS (
                 SELECT id, parent_id FROM tree_nodes
                  WHERE id = ? AND project_id = ?
                 UNION
                 SELECT parent.id, parent.parent_id
                   FROM tree_nodes parent
                   JOIN ancestors child ON parent.id = child.parent_id
                  WHERE parent.project_id = ?
               )
               SELECT 1 AS cycle FROM ancestors WHERE id = ? LIMIT 1`,
              [parentId, projectId, projectId, nodeId],
            )
          ) {
            throw new Error("tree node parent would create a descendant cycle");
          }
          for (const [patchKey, label] of [
            ["povCharacterId", "POV character"],
            ["locationId", "location"],
          ] as const) {
            if (!Object.hasOwn(patch, patchKey) || patch[patchKey] == null) {
              continue;
            }
            const codexId = patch[patchKey];
            if (
              typeof codexId !== "string" ||
              !queryOne(
                "SELECT 1 AS owned FROM codex_entries WHERE id = ? AND project_id = ?",
                [codexId, projectId],
              )
            ) {
              throw new Error(
                `tree node ${label} '${String(codexId)}' is not in project '${projectId}'`,
              );
            }
          }
          const assignments: string[] = [];
          const params: SqlValue[] = [];
          const integerFields = new Set([
            "chronicleStartTime",
            "chronicleStartMinute",
            "chronicleEndTime",
            "chronicleEndMinute",
            "charCount",
          ]);
          for (const [key, value] of Object.entries(patch)) {
            const column = columnMap[key];
            if (!column)
              throw new Error(`unsupported tree node patch field: ${key}`);
            if (
              integerFields.has(key) &&
              value !== null &&
              (typeof value !== "number" || !Number.isSafeInteger(value))
            ) {
              throw new Error(`${command}: ${key} must be an integer or null`);
            }
            if (
              !integerFields.has(key) &&
              value !== null &&
              typeof value !== "string"
            ) {
              throw new Error(`${command}: ${key} must be a string or null`);
            }
            assignments.push(`${column} = ?`);
            params.push((value ?? null) as SqlValue);
          }
          assignments.push("updated_at = ?");
          params.push(updatedAt);
          if (payload.bumpVersion) assignments.push("version = version + 1");
          params.push(nodeId, projectId);
          let sql = `UPDATE tree_nodes SET ${assignments.join(", ")}
            WHERE id = ? AND project_id = ?`;
          if (Object.hasOwn(payload, "baseVersion")) {
            sql += " AND version = ?";
            params.push(payload.baseVersion as number);
          }
          db.run(sql, params);
          if (db.getRowsModified() !== 1) {
            if (Object.hasOwn(payload, "baseVersion")) {
              throw new Error(
                `TREE_NODE_VERSION_MISMATCH: node '${nodeId}' version conflict; expected base version ${String(payload.baseVersion)}`,
              );
            }
            throw new Error(
              `tree node '${nodeId}' not found in project '${projectId}'`,
            );
          }
          const row = browserTreeNodeRow(nodeId, projectId);
          if (!row) throw new Error("tree node not found");
          if (
            Object.hasOwn(payload, "baseVersion") &&
            row.version !==
              (payload.baseVersion as number) + (payload.bumpVersion ? 1 : 0)
          ) {
            throw new Error("TREE_NODE_VERSION_MISMATCH");
          }
          db.run("COMMIT");
          options.onDatabaseDirty?.();
          return row as T;
        } catch (error) {
          try {
            db.run("ROLLBACK");
          } catch {
            // Preserve the tree patch failure.
          }
          throw error;
        }
      }
      case "temporal_scene_patch": {
        const payload = args.payload as Record<string, unknown>;
        db.run(
          `UPDATE tree_nodes SET story_time_order = ?, story_time_label = ?,
            chronicle_start_time = ?, chronicle_start_minute = ?,
            chronicle_start_granularity = ?, chronicle_end_time = ?,
            chronicle_end_minute = ?, chronicle_end_granularity = ?,
            chronicle_precision = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND project_id = ? AND node_type = 'scene'
             AND version = ?`,
          [
            payload.storyTimeOrder as SqlValue,
            payload.storyTimeLabel as SqlValue,
            payload.startTime as SqlValue,
            payload.startMinute as SqlValue,
            payload.startGranularity as SqlValue,
            payload.endTime as SqlValue,
            payload.endMinute as SqlValue,
            payload.endGranularity as SqlValue,
            payload.precision as SqlValue,
            new Date().toISOString(),
            payload.targetId as string,
            payload.projectId as string,
            payload.baseVersion as number,
          ],
        );
        options.onDatabaseDirty?.();
        const row = browserTreeNodeRow(
          payload.targetId as string,
          payload.projectId as string,
        );
        if (!row || row.version !== (payload.baseVersion as number) + 1) {
          throw new Error("NEX_TEMPORAL_SCENE_VERSION_MISMATCH");
        }
        return {
          sceneId: payload.targetId,
          version: row.version,
          updatedAt: row.updatedAt,
        } as T;
      }
      case "map_write_bundle":
        handleMapWriteBundle(args);
        return undefined as T;
      case "project_snapshot_create":
        handleProjectSnapshotCreate(args);
        return undefined as T;
      case "project_snapshot_restore_context":
        return handleProjectSnapshotRestoreContext(args) as T;
      case "project_snapshot_apply_restore":
        handleProjectSnapshotApplyRestore(args);
        return undefined as T;
      case "plot_thread_create":
        return (await handlePlotThreadCreate(args)) as T;
      case "plot_thread_update":
        return handlePlotThreadUpdate(args) as T;
      case "plot_thread_delete":
        handlePlotThreadDelete(args);
        return undefined as T;
      case "plot_thread_link_create":
        return (await handlePlotThreadLinkCreate(args)) as T;
      case "plot_thread_link_update":
        return handlePlotThreadLinkUpdate(args) as T;
      case "plot_thread_link_delete":
        handlePlotThreadLinkDelete(args);
        return undefined as T;
      case "plot_thread_branch_create":
        return (await handlePlotThreadBranchCreate(args)) as T;
      case "plot_thread_branch_update":
        return handlePlotThreadBranchUpdate(args) as T;
      case "plot_thread_branch_delete":
        handlePlotThreadBranchDelete(args);
        return undefined as T;
      case "plot_thread_move_marker_bundle":
        return (await handlePlotThreadMoveMarkerBundle(args)) as T;
      case "plot_thread_restore_snapshot":
        return (await handlePlotThreadRestoreSnapshot(args)) as T;
      case "plot_thread_delete_snapshot":
        return (await handlePlotThreadDeleteSnapshot(args)) as T;
      case "foreshadow_create":
        return (await handleForeshadowCreate(args)) as T;
      case "foreshadow_update":
        return handleForeshadowUpdate(args) as T;
      case "foreshadow_delete":
        return (await handleForeshadowDelete(args)) as T;
      case "foreshadow_get_setup":
        return handleForeshadowGetSetup(args) as T;
      case "foreshadow_update_setup":
        return handleForeshadowUpdateSetup(args) as T;
      case "foreshadow_setup_create_ai":
        return handleForeshadowSetupCreateAi(args) as T;
      case "foreshadow_resolve_orphan":
        return handleForeshadowResolveOrphan(args) as T;
      case "foreshadow_link_codex":
        return handleForeshadowLinkCodex(args, true) as T;
      case "foreshadow_unlink_codex":
        return handleForeshadowLinkCodex(args, false) as T;
      case "foreshadow_mark_linked_codex_dirty":
        return handleForeshadowMarkLinkedCodexDirty(args) as T;
      case "foreshadow_set_setup_strength":
        return handleForeshadowSetSetupStrength(args) as T;
      case "foreshadow_save_anchors_for_scene":
        return handleForeshadowSaveAnchorsForScene(args) as T;
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
        assertBrowserSemanticIndexAuthority(args);
        return 0 as T;
      case "codex_index_entry":
        assertBrowserSemanticIndexAuthority(args);
        return 0 as T;
      case "events_index_entry":
        assertBrowserSemanticIndexAuthority(args);
        return 0 as T;
      case "chat_index_message":
        assertBrowserSemanticIndexAuthority(args);
        return 0 as T;
      case "semantic_reindex_all":
      case "semantic_cancel_background":
      case "codex_reindex_all":
      case "events_reindex_all":
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
        return (await handleAbortAiStream(args)) as T;
      case "send_inline_ai_stream":
        await handleAiStream(args, "inline");
        return undefined as T;
      case "abort_inline_ai_stream":
        return (await handleAbortAiStream(args)) as T;
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
    for (const [streamId, lifecycle] of browserStreamLifecycles) {
      lifecycle.abortRequested = true;
      const abort = aiTransport.abort?.(streamId);
      if (abort) void abort.catch(() => undefined);
    }
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
    `INSERT OR IGNORE INTO scene_events (scene_id, event_id, incarnation_token)
     VALUES
      ('scene-1', 'shot-event-return', ?),
      ('scene-2', 'shot-event-awakening', ?)`,
    [crypto.randomUUID(), crypto.randomUUID()],
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
       last_evaluated_at, is_orphan, semantic_key, created_at, updated_at)
     VALUES
      ('setup-akahimo-warmth', 'fs-akahimo-warmth', 'scene-1', ?, ?,
       'designated_existing', 'moderate', 'moderate',
       ?, 'human',
       NULL, ?, 0, ?, ?, ?),
      ('setup-haisha-lock', 'fs-haisha-visitor', 'scene-1', ?, ?,
       'designated_existing', 'subtle', 'subtle',
       ?, 'human',
       NULL, ?, 0, ?, ?, ?)`,
    [
      c.foreshadows.setupWarmth.fromPos,
      c.foreshadows.setupWarmth.toPos,
      c.foreshadows.setupWarmth.aiReasoning,
      Date.now(),
      `fs-akahimo-warmth|scene-1|${c.foreshadows.setupWarmth.fromPos}|${c.foreshadows.setupWarmth.toPos}`,
      Date.now(),
      Date.now(),
      c.foreshadows.setupLock.fromPos,
      c.foreshadows.setupLock.toPos,
      c.foreshadows.setupLock.aiReasoning,
      Date.now(),
      `fs-haisha-visitor|scene-1|${c.foreshadows.setupLock.fromPos}|${c.foreshadows.setupLock.toPos}`,
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
