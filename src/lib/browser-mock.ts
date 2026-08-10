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

  function handleCodexRenameUndo(args: Record<string, unknown>): void {
    const payload = args.payload as {
      projectId: string;
      updatedAt: string;
      updates: Array<{
        kind: string;
        refId: string;
        detailDefinitionId: string | null;
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
    for (const update of payload.updates) {
      if (update.kind.startsWith("node-") || update.kind === "scene-body") {
        if (
          !queryOne(
            "SELECT 1 FROM tree_nodes WHERE id = ? AND project_id = ?",
            [update.refId, payload.projectId],
          )
        ) {
          throw new Error("codex rename undo tree target is outside project");
        }
      } else if (update.kind.startsWith("codex-")) {
        const exists =
          update.kind === "codex-detail"
            ? queryOne(
                `SELECT 1
                   FROM codex_detail_values value
                   JOIN codex_entries entry ON entry.id = value.entry_id
                  WHERE value.entry_id = ? AND value.definition_id = ?
                    AND entry.project_id = ?`,
                [update.refId, update.detailDefinitionId, payload.projectId],
              )
            : update.kind === "codex-relation-label"
              ? queryOne(
                  "SELECT 1 FROM codex_relations WHERE id = ? AND project_id = ?",
                  [update.refId, payload.projectId],
                )
              : queryOne(
                  "SELECT 1 FROM codex_entries WHERE id = ? AND project_id = ?",
                  [update.refId, payload.projectId],
                );
        if (!exists) {
          throw new Error("codex rename undo target is outside project");
        }
      }

      switch (update.kind) {
        case "scene-body":
          statements.push({
            sql: `UPDATE tree_nodes
                    SET content = ?, char_count = ?, placed_beat_preview = ?,
                        version = version + 1, updated_at = ?
                  WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
            params: [
              update.value,
              update.charCount,
              update.placedBeatPreview,
              payload.updatedAt,
              update.refId,
              payload.projectId,
            ],
            method: "run",
          });
          break;
        case "node-title":
        case "node-synopsis": {
          const column = update.kind === "node-title" ? "title" : "synopsis";
          statements.push({
            sql: `UPDATE tree_nodes SET ${column} = ?, updated_at = ?
                  WHERE id = ? AND project_id = ?`,
            params: [
              update.value,
              payload.updatedAt,
              update.refId,
              payload.projectId,
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
            sql: `UPDATE codex_entries SET ${column} = ?, updated_at = ?
                  WHERE id = ? AND project_id = ?`,
            params: [
              update.value,
              payload.updatedAt,
              update.refId,
              payload.projectId,
            ],
            method: "run",
          });
          break;
        }
        case "codex-detail":
          statements.push({
            sql: `UPDATE codex_detail_values SET value = ?
                  WHERE entry_id = ? AND definition_id = ?
                    AND EXISTS (
                      SELECT 1 FROM codex_entries
                       WHERE id = ? AND project_id = ?
                    )`,
            params: [
              update.value,
              update.refId,
              update.detailDefinitionId,
              update.refId,
              payload.projectId,
            ],
            method: "run",
          });
          break;
        case "codex-relation-label":
          statements.push({
            sql: `UPDATE codex_relations SET label = ?
                  WHERE id = ? AND project_id = ?`,
            params: [update.value, update.refId, payload.projectId],
            method: "run",
          });
          break;
        default:
          throw new Error("unsupported codex rename undo kind");
      }
    }
    handleDbExecuteBatch({ statements });
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
      case "authorship_replace_lane":
        handleAuthorshipReplaceLane(args);
        return undefined as T;
      case "entity_tags_set":
        handleEntityTagsSet(args);
        return undefined as T;
      case "codex_rename_undo":
        handleCodexRenameUndo(args);
        return undefined as T;
      case "scan_staging_project_create":
        handleScanStagingProjectCreate(args);
        return undefined as T;
      case "tree_plan_undo":
        handleTreePlanUndo(args);
        return undefined as T;
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
