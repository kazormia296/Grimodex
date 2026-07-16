// @ts-ignore — sql.js exposes its ASM entry point through a CommonJS declaration.
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlValue } from "sql.js";
import type { JSONContent } from "@tiptap/core";
import type { ImportedNode } from "../../../../src/features/import/importTypes";
import type {
  ScanCodexImportPlan,
  ScanEventImportPlan,
  ScanImportPlan,
  ScanPhaseImportPlan,
  ScanRelationImportPlan,
} from "../../../../src/features/import/scan/scanImportPlan";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS workspace_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tree_nodes (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    node_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    summary TEXT,
    confidence REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_relations (
    id TEXT PRIMARY KEY,
    from_codex_id TEXT NOT NULL,
    to_codex_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    label TEXT,
    confidence REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_phases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    entity_ids_json TEXT NOT NULL,
    anchor_node_ids_json TEXT NOT NULL,
    summary TEXT,
    confidence REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    event_order REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scene_events (
    scene_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (scene_id, event_id)
  );
`;

export interface BrowserWorkspaceScene {
  id: string;
  parentId: string | null;
  title: string;
  content: JSONContent;
}

export interface BrowserWorkspaceRelation extends ScanRelationImportPlan {}

export interface BrowserScanWorkspace {
  db: Database;
  scenes: BrowserWorkspaceScene[];
  codexEntries: ScanCodexImportPlan[];
  relations: BrowserWorkspaceRelation[];
  phases: ScanPhaseImportPlan[];
  events: ScanEventImportPlan[];
  updateSceneContent(sceneId: string, content: JSONContent): void;
  exportDatabase(): Uint8Array;
}

type SqlJsModule = {
  Database: new (data?: ArrayLike<number> | null) => Database;
};
let sqlPromise: Promise<SqlJsModule> | null = null;

function loadSqlJs(): Promise<SqlJsModule> {
  sqlPromise ??= initSqlJs() as Promise<SqlJsModule>;
  return sqlPromise;
}

function plainTextDocument(text: string): JSONContent {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim());
  return {
    type: "doc",
    content: (paragraphs.length > 0 ? paragraphs : [""]).map((paragraph) => ({
      type: "paragraph",
      content: paragraph ? [{ type: "text", text: paragraph }] : undefined,
    })),
  };
}

function sceneContent(
  node: Extract<ImportedNode, { kind: "scene" }>,
): JSONContent {
  if (node.bodyProseMirror) {
    try {
      const parsed = JSON.parse(node.bodyProseMirror) as JSONContent;
      if (parsed.type === "doc" && Array.isArray(parsed.content)) return parsed;
    } catch {
      // Fall through to the plain-text representation.
    }
  }
  return plainTextDocument(node.bodyMarkdown ?? node.body ?? "");
}

function insertPlan(db: Database, plan: ScanImportPlan): void {
  db.run("INSERT INTO workspace_meta (key, value) VALUES (?, ?)", [
    "sourceFingerprint",
    plan.sourceFingerprint,
  ]);
  const nodes = flattenNodes(plan.nodes);
  nodes.forEach((node, index) => {
    db.run(
      `INSERT INTO tree_nodes (id, parent_id, node_type, title, content, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        node.parentId,
        node.kind,
        node.title,
        node.kind === "scene" ? JSON.stringify(sceneContent(node)) : "{}",
        index,
      ],
    );
  });
  for (const entry of plan.codexEntries) {
    db.run(
      `INSERT INTO codex_entries
       (id, type, name, aliases_json, summary, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.type,
        entry.name,
        JSON.stringify(entry.aliases),
        entry.summary ?? null,
        entry.confidence,
      ],
    );
  }
  for (const relation of plan.relations) {
    db.run(
      `INSERT INTO codex_relations
       (id, from_codex_id, to_codex_id, relation_type, label, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        relation.id,
        relation.fromCodexId,
        relation.toCodexId,
        relation.type,
        relation.label ?? null,
        relation.confidence,
      ],
    );
  }
  for (const phase of plan.phases) {
    db.run(
      `INSERT INTO codex_phases
       (id, title, entity_ids_json, anchor_node_ids_json, summary, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        phase.id,
        phase.title,
        JSON.stringify(phase.entityIds),
        JSON.stringify(
          phase.anchorNodeIds ??
            (phase.anchorNodeId ? [phase.anchorNodeId] : []),
        ),
        phase.summary ?? null,
        phase.confidence,
      ],
    );
  }
  for (const event of plan.events) {
    db.run(
      `INSERT INTO events (id, scene_id, title, summary, event_order)
       VALUES (?, ?, ?, ?, ?)`,
      [
        event.id,
        event.sceneId,
        event.title,
        event.summary ?? null,
        event.order,
      ],
    );
    db.run("INSERT INTO scene_events (scene_id, event_id) VALUES (?, ?)", [
      event.sceneId,
      event.id,
    ]);
  }
}

type FlatNode = ImportedNode & { parentId: string | null };

function flattenNodes(
  nodes: readonly ImportedNode[],
  parentId: string | null = null,
): FlatNode[] {
  return nodes.flatMap((node) =>
    node.kind === "folder"
      ? [{ ...node, parentId }, ...flattenNodes(node.children, node.id)]
      : [{ ...node, parentId }],
  );
}

function rows<T extends Record<string, unknown>>(
  db: Database,
  query: string,
): T[] {
  const result = db.exec(query)[0];
  if (!result) return [];
  return result.values.map(
    (values) =>
      Object.fromEntries(
        result.columns.map((column, index) => [column, values[index]]),
      ) as T,
  );
}

function text(value: SqlValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function number(value: SqlValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

function json<T>(value: SqlValue | undefined, fallback: T): T {
  try {
    return JSON.parse(text(value)) as T;
  } catch {
    return fallback;
  }
}

function readWorkspace(
  db: Database,
  plan: ScanImportPlan,
): Omit<BrowserScanWorkspace, "db" | "updateSceneContent" | "exportDatabase"> {
  const sceneRows = rows<{
    id: string;
    parent_id: string | null;
    title: string;
    content: string;
  }>(
    db,
    "SELECT id, parent_id, title, content FROM tree_nodes WHERE node_type = 'scene' ORDER BY sort_order",
  );
  const scenes = sceneRows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    content: json<JSONContent>(row.content, plainTextDocument("")),
  }));
  const entries = rows<Record<string, SqlValue>>(
    db,
    "SELECT id, type, name, aliases_json, summary, confidence FROM codex_entries",
  ).map((row) => ({
    ...plan.codexEntries.find((entry) => entry.id === text(row.id)),
    id: text(row.id),
    sourceEntityId: text(row.id),
    type: text(row.type) as ScanCodexImportPlan["type"],
    name: text(row.name),
    aliases: json<string[]>(row.aliases_json, []),
    summary: text(row.summary) || undefined,
    confidence: number(row.confidence),
    evidence:
      plan.codexEntries.find((entry) => entry.id === text(row.id))?.evidence ??
      [],
  }));
  const relations = rows<Record<string, SqlValue>>(
    db,
    "SELECT id, from_codex_id, to_codex_id, relation_type, label, confidence FROM codex_relations",
  ).map((row) => ({
    ...plan.relations.find((relation) => relation.id === text(row.id)),
    id: text(row.id),
    sourceRelationId: text(row.id),
    fromCodexId: text(row.from_codex_id),
    toCodexId: text(row.to_codex_id),
    type: text(row.relation_type),
    label: text(row.label) || undefined,
    confidence: number(row.confidence),
    evidence:
      plan.relations.find((relation) => relation.id === text(row.id))
        ?.evidence ?? [],
  }));
  const phases = rows<Record<string, SqlValue>>(
    db,
    "SELECT id, title, entity_ids_json, anchor_node_ids_json, summary, confidence FROM codex_phases",
  ).map((row) => {
    const anchorNodeIds = json<string[]>(row.anchor_node_ids_json, []);
    const source = plan.phases.find((phase) => phase.id === text(row.id));
    return {
      ...source,
      id: text(row.id),
      sourcePhaseId: text(row.id),
      title: text(row.title),
      entityIds: json<string[]>(row.entity_ids_json, []),
      anchorNodeId: anchorNodeIds[0],
      anchorNodeIds,
      anchors: source?.anchors ?? [],
      summary: text(row.summary) || undefined,
      confidence: number(row.confidence),
    };
  });
  const events = rows<Record<string, SqlValue>>(
    db,
    "SELECT id, scene_id, title, summary, event_order FROM events ORDER BY event_order, id",
  ).map((row) => ({
    ...plan.events.find((event) => event.id === text(row.id)),
    id: text(row.id),
    sourceEventId: text(row.id),
    sectionId: text(row.scene_id),
    sourceSectionId: text(row.scene_id),
    sceneId: text(row.scene_id),
    paragraphIds:
      plan.events.find((event) => event.id === text(row.id))?.paragraphIds ??
      [],
    entityIds:
      plan.events.find((event) => event.id === text(row.id))?.entityIds ?? [],
    title: text(row.title),
    summary: text(row.summary) || undefined,
    order: number(row.event_order),
    evidence:
      plan.events.find((event) => event.id === text(row.id))?.evidence ?? [],
  }));
  return { scenes, codexEntries: entries, relations, phases, events };
}

export async function createBrowserScanWorkspace(
  plan: ScanImportPlan,
  databaseBytes?: Uint8Array,
): Promise<BrowserScanWorkspace> {
  const SQL = await loadSqlJs();
  const db = databaseBytes
    ? new SQL.Database(databaseBytes)
    : new SQL.Database();
  if (!databaseBytes) {
    db.exec(SCHEMA);
    insertPlan(db, plan);
  } else {
    const stored = rows<{ value: string }>(
      db,
      "SELECT value FROM workspace_meta WHERE key = 'sourceFingerprint'",
    )[0]?.value;
    if (stored !== plan.sourceFingerprint)
      throw new Error("browser workspace fingerprint mismatch");
  }
  const data = readWorkspace(db, plan);
  return {
    db,
    ...data,
    updateSceneContent(sceneId, content) {
      db.run(
        "UPDATE tree_nodes SET content = ? WHERE id = ? AND node_type = 'scene'",
        [JSON.stringify(content), sceneId],
      );
    },
    exportDatabase: () => db.export(),
  };
}
