import { db } from "@/db/client";
import { invoke, isTauri } from "@/lib/tauri";
import {
  plotThreads,
  plotThreadSceneLinks,
  plotThreadBranches,
} from "@/db/schema";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * ネイティブホスト（Tauri or Electron/napi）では Rust コマンドへ invoke する。
 * ブラウザ / テスト（どちらでもない）だけ renderer 直 Drizzle にフォールバックする。
 *
 * Electron 移行 Phase 3 バッチ1: 従来 `isTauri()` 単独ゲートだったため Electron は
 * Drizzle 分岐に落ち、link_create / link_update の XPROJ ガードを**素通ししていた**。
 * Electron 判定を足して napi 経由に載せることで、Electron でもサーバサイドの
 * XPROJ 検証・phase_type 検証が効くようになる（意図した挙動の厳格化）。
 *
 * isElectron 相当（`"grimodex" in window`、src/lib/shell.ts と同判定）は inline で
 * 書く。`@/lib/tauri` からの `isElectron` 再エクスポート import は browser build の
 * ESM（実 Chromium/WebKit + 一部テストの部分 vi.mock("@/lib/tauri")）で解決に失敗
 * するため使わない（foreshadow/api.ts と同作法）。
 */
function nativeBackend(): boolean {
  if (isTauri()) return true;
  return typeof window !== "undefined" && "grimodex" in window;
}

export interface PlotThreadRow {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: string;
  /** 束ねレイアウトの生存スパン明示指定（NULL=最初/最後のマーカーから導出）。 */
  startNodeId: string | null;
  endNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlotThreadLinkRow {
  id: string;
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  note: string | null;
  sortOrder: string | null;
  createdAt: string;
  updatedAt: string;
}

function s(v: unknown, fallback = ""): string {
  return v == null ? fallback : String(v);
}
function nullable(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** DB 行（snake_case）/ invoke 戻り値（camelCase）の双方を PlotThreadRow へ正規化。 */
export function normalizeThread(raw: unknown): PlotThreadRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    name: s(r.name),
    color: nullable(r.color),
    description: nullable(r.description),
    sortOrder: s(r.sortOrder ?? r.sort_order, "a0"),
    startNodeId: nullable(r.startNodeId ?? r.start_node_id),
    endNodeId: nullable(r.endNodeId ?? r.end_node_id),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

export function normalizeLink(raw: unknown): PlotThreadLinkRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    threadId: s(r.threadId ?? r.thread_id),
    nodeId: s(r.nodeId ?? r.node_id),
    phaseType: s(r.phaseType ?? r.phase_type, "develop") as PlotPhaseType,
    note: nullable(r.note),
    sortOrder: nullable(r.sortOrder ?? r.sort_order),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

// ───────── threads ─────────

export async function createPlotThread(data: {
  projectId: string;
  name: string;
  color?: string | null;
  description?: string | null;
  sortOrder: string;
}): Promise<PlotThreadRow> {
  if (nativeBackend()) {
    const created = await invoke("plot_thread_create", {
      payload: {
        projectId: data.projectId,
        name: data.name,
        color: data.color ?? null,
        description: data.description ?? null,
        sortOrder: data.sortOrder,
      },
    });
    return normalizeThread(created);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(plotThreads).values({
    id,
    projectId: data.projectId,
    name: data.name,
    color: data.color ?? null,
    description: data.description ?? null,
    sortOrder: data.sortOrder,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db
    .select()
    .from(plotThreads)
    .where(eq(plotThreads.id, id));
  return normalizeThread(row);
}

export async function updatePlotThread(
  id: string,
  patch: Partial<
    Pick<PlotThreadRow, "name" | "color" | "description" | "sortOrder">
  >,
): Promise<void> {
  if (nativeBackend()) {
    const p: Record<string, unknown> = {};
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    await invoke("plot_thread_update", { id, patch: p });
    return;
  }
  await db
    .update(plotThreads)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreads.id, id));
}

export async function deletePlotThread(id: string): Promise<void> {
  if (nativeBackend()) {
    await invoke("plot_thread_delete", { id });
    return;
  }
  await db.delete(plotThreads).where(eq(plotThreads.id, id));
}

/**
 * Undo/Redo 専用: 削除/作成した行を **同じ id で** 復元する。create 系は id を
 * 新規採番する（Rust / Drizzle とも）ため、履歴の逆操作で id を保つには専用の
 * id 保存 insert が要る。branch CRUD と同じく Drizzle 直書きで Tauri / テスト共通
 * （単一 DB を db_execute 経由で叩く）。復元データは過去に検証済みの行なので XPROJ
 * 再検証は行わない（履歴は project 切替で clear される）。
 */
export async function restorePlotThread(row: PlotThreadRow): Promise<void> {
  await db.insert(plotThreads).values({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    description: row.description,
    sortOrder: row.sortOrder,
    startNodeId: row.startNodeId,
    endNodeId: row.endNodeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function listPlotThreads(
  projectId: string,
): Promise<PlotThreadRow[]> {
  if (nativeBackend()) {
    const rows = (await invoke("plot_thread_list", { projectId })) as unknown[];
    return rows.map(normalizeThread);
  }
  const rows = await db
    .select()
    .from(plotThreads)
    .where(eq(plotThreads.projectId, projectId))
    .orderBy(plotThreads.sortOrder);
  return rows.map(normalizeThread);
}

// ───────── links ─────────

export async function createPlotThreadLink(data: {
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  note?: string | null;
  sortOrder?: string | null;
}): Promise<PlotThreadLinkRow> {
  if (nativeBackend()) {
    const created = await invoke("plot_thread_link_create", {
      payload: {
        threadId: data.threadId,
        nodeId: data.nodeId,
        phaseType: data.phaseType,
        note: data.note ?? null,
        sortOrder: data.sortOrder ?? null,
      },
    });
    return normalizeLink(created);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(plotThreadSceneLinks).values({
    id,
    threadId: data.threadId,
    nodeId: data.nodeId,
    phaseType: data.phaseType,
    note: data.note ?? null,
    sortOrder: data.sortOrder ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db
    .select()
    .from(plotThreadSceneLinks)
    .where(eq(plotThreadSceneLinks.id, id));
  return normalizeLink(row);
}

export async function updatePlotThreadLink(
  id: string,
  patch: Partial<
    Pick<
      PlotThreadLinkRow,
      "threadId" | "nodeId" | "phaseType" | "note" | "sortOrder"
    >
  >,
): Promise<void> {
  if (nativeBackend()) {
    const p: Record<string, unknown> = {};
    if (patch.threadId !== undefined) p.threadId = patch.threadId;
    if (patch.nodeId !== undefined) p.nodeId = patch.nodeId;
    if (patch.phaseType !== undefined) p.phaseType = patch.phaseType;
    if (patch.note !== undefined) p.note = patch.note;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    await invoke("plot_thread_link_update", { id, patch: p });
    return;
  }
  await db
    .update(plotThreadSceneLinks)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreadSceneLinks.id, id));
}

export async function deletePlotThreadLink(id: string): Promise<void> {
  if (nativeBackend()) {
    await invoke("plot_thread_link_delete", { id });
    return;
  }
  await db.delete(plotThreadSceneLinks).where(eq(plotThreadSceneLinks.id, id));
}

/** Undo/Redo 専用: link を同じ id で復元する（{@link restorePlotThread} 参照）。 */
export async function restorePlotThreadLink(
  row: PlotThreadLinkRow,
): Promise<void> {
  await db.insert(plotThreadSceneLinks).values({
    id: row.id,
    threadId: row.threadId,
    nodeId: row.nodeId,
    phaseType: row.phaseType,
    note: row.note,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function listPlotThreadLinks(
  projectId: string,
): Promise<PlotThreadLinkRow[]> {
  if (nativeBackend()) {
    const rows = (await invoke("plot_thread_list_links", {
      projectId,
    })) as unknown[];
    return rows.map(normalizeLink);
  }
  // 非 Tauri（テスト/ブラウザ）: thread の project で絞り、その thread の link のみ取得。
  const threads = await db
    .select()
    .from(plotThreads)
    .where(eq(plotThreads.projectId, projectId));
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length === 0) return [];
  const rows = await db
    .select()
    .from(plotThreadSceneLinks)
    .where(inArray(plotThreadSceneLinks.threadId, threadIds));
  return rows.map(normalizeLink);
}

// ───────── branches (分岐 / 合流) ─────────
// 専用 Rust コマンドは設けず、db_execute 経由の Drizzle で CRUD する
// （在 Tauri / テスト共通。codexRelationApi など多数の feature と同方針）。

export interface PlotThreadBranchRow {
  id: string;
  projectId: string;
  fromThreadId: string;
  toThreadId: string;
  atNodeId: string;
  kind: PlotBranchKind;
  createdAt: string;
  updatedAt: string;
}

export function normalizeBranch(raw: unknown): PlotThreadBranchRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    fromThreadId: s(r.fromThreadId ?? r.from_thread_id),
    toThreadId: s(r.toThreadId ?? r.to_thread_id),
    atNodeId: s(r.atNodeId ?? r.at_node_id),
    kind: s(r.kind, "branch") as PlotBranchKind,
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

export async function createPlotThreadBranch(data: {
  projectId: string;
  fromThreadId: string;
  toThreadId: string;
  atNodeId: string;
  kind: PlotBranchKind;
}): Promise<PlotThreadBranchRow> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(plotThreadBranches).values({
    id,
    projectId: data.projectId,
    fromThreadId: data.fromThreadId,
    toThreadId: data.toThreadId,
    atNodeId: data.atNodeId,
    kind: data.kind,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db
    .select()
    .from(plotThreadBranches)
    .where(eq(plotThreadBranches.id, id));
  return normalizeBranch(row);
}

export async function updatePlotThreadBranch(
  id: string,
  patch: Partial<
    Pick<PlotThreadBranchRow, "fromThreadId" | "toThreadId" | "atNodeId">
  >,
): Promise<void> {
  await db
    .update(plotThreadBranches)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreadBranches.id, id));
}

export async function deletePlotThreadBranch(id: string): Promise<void> {
  await db.delete(plotThreadBranches).where(eq(plotThreadBranches.id, id));
}

/** Undo/Redo 専用: branch を同じ id で復元する（{@link restorePlotThread} 参照）。 */
export async function restorePlotThreadBranch(
  row: PlotThreadBranchRow,
): Promise<void> {
  await db.insert(plotThreadBranches).values({
    id: row.id,
    projectId: row.projectId,
    fromThreadId: row.fromThreadId,
    toThreadId: row.toThreadId,
    atNodeId: row.atNodeId,
    kind: row.kind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function listPlotThreadBranches(
  projectId: string,
): Promise<PlotThreadBranchRow[]> {
  const rows = await db
    .select()
    .from(plotThreadBranches)
    .where(eq(plotThreadBranches.projectId, projectId));
  return rows.map(normalizeBranch);
}
