import { db } from "@/db/client";
import { invoke, IpcInvokeError, isTauri } from "@/lib/tauri";
import {
  plotThreads,
  plotThreadSceneLinks,
  plotThreadBranches,
} from "@/db/schema";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { attachCreateResultMetadata } from "@/lib/createResultMetadata";

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
  return electronBackend();
}

function electronBackend(): boolean {
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
  return attachCreateResultMetadata(
    {
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
    },
    raw,
  );
}

export function normalizeLink(raw: unknown): PlotThreadLinkRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return attachCreateResultMetadata(
    {
      id: s(r.id),
      threadId: s(r.threadId ?? r.thread_id),
      nodeId: s(r.nodeId ?? r.node_id),
      phaseType: s(r.phaseType ?? r.phase_type, "develop") as PlotPhaseType,
      note: nullable(r.note),
      sortOrder: nullable(r.sortOrder ?? r.sort_order),
      createdAt: s(r.createdAt ?? r.created_at),
      updatedAt: s(r.updatedAt ?? r.updated_at),
    },
    raw,
  );
}

// ───────── threads ─────────

export async function createPlotThread(data: {
  /** Reuse this domain ID when retrying the same logical create. */
  id?: string;
  projectId: string;
  name: string;
  color?: string | null;
  description?: string | null;
  sortOrder: string;
}): Promise<PlotThreadRow> {
  const id = data.id ?? crypto.randomUUID();
  try {
    const created = await invoke("plot_thread_create", {
      payload: {
        id,
        projectId: data.projectId,
        name: data.name,
        color: data.color ?? null,
        description: data.description ?? null,
        sortOrder: data.sortOrder,
      },
    });
    return normalizeThread(created);
  } catch (error) {
    if (error instanceof IpcInvokeError && error.outcome === "unknown") {
      // The same domain ID can be supplied to a deliberate retry. Surface it
      // without claiming that the first native create failed.
      throw new IpcInvokeError(
        error.command,
        {
          code: error.code,
          message: error.message,
          // Unlike generic mutations, this create is retry-safe when the
          // caller reuses the domain ID included below.
          retryable: true,
          outcome: error.outcome,
          details: {
            ...error.details,
            requestId: id,
            idempotencyDomain: "plot-thread-create",
          },
        },
        error,
      );
    }
    throw error;
  }
}

export async function updatePlotThread(
  id: string,
  patch: Partial<
    Pick<PlotThreadRow, "name" | "color" | "description" | "sortOrder">
  >,
): Promise<PlotThreadRow> {
  if (nativeBackend()) {
    const p: Record<string, unknown> = {};
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    return normalizeThread(
      await invoke("plot_thread_update", { id, patch: p }),
    );
  }
  await db
    .update(plotThreads)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreads.id, id));
  const [updated] = await db
    .select()
    .from(plotThreads)
    .where(eq(plotThreads.id, id));
  if (!updated) throw new Error(`plot thread not found after update: ${id}`);
  return normalizeThread(updated);
}

export async function deletePlotThread(id: string): Promise<void> {
  if (nativeBackend()) {
    await invoke("plot_thread_delete", { id });
    return;
  }
  await db.delete(plotThreads).where(eq(plotThreads.id, id));
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
  /** Reuse this domain ID when retrying the same logical create. */
  id?: string;
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  note?: string | null;
  sortOrder?: string | null;
}): Promise<PlotThreadLinkRow> {
  const id = data.id ?? crypto.randomUUID();
  try {
    const created = await invoke("plot_thread_link_create", {
      payload: {
        id,
        threadId: data.threadId,
        nodeId: data.nodeId,
        phaseType: data.phaseType,
        note: data.note ?? null,
        sortOrder: data.sortOrder ?? null,
      },
    });
    return normalizeLink(created);
  } catch (error) {
    if (error instanceof IpcInvokeError && error.outcome === "unknown") {
      throw new IpcInvokeError(
        error.command,
        {
          code: error.code,
          message: error.message,
          retryable: true,
          outcome: error.outcome,
          details: {
            ...error.details,
            requestId: id,
            idempotencyDomain: "plot-thread-link-create",
          },
        },
        error,
      );
    }
    throw error;
  }
}

export async function updatePlotThreadLink(
  id: string,
  patch: Partial<
    Pick<
      PlotThreadLinkRow,
      "threadId" | "nodeId" | "phaseType" | "note" | "sortOrder"
    >
  >,
): Promise<PlotThreadLinkRow> {
  if (nativeBackend()) {
    const p: Record<string, unknown> = {};
    if (patch.threadId !== undefined) p.threadId = patch.threadId;
    if (patch.nodeId !== undefined) p.nodeId = patch.nodeId;
    if (patch.phaseType !== undefined) p.phaseType = patch.phaseType;
    if (patch.note !== undefined) p.note = patch.note;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    return normalizeLink(
      await invoke("plot_thread_link_update", { id, patch: p }),
    );
  }
  await db
    .update(plotThreadSceneLinks)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreadSceneLinks.id, id));
  const [updated] = await db
    .select()
    .from(plotThreadSceneLinks)
    .where(eq(plotThreadSceneLinks.id, id));
  if (!updated)
    throw new Error(`plot thread link not found after update: ${id}`);
  return normalizeLink(updated);
}

export async function deletePlotThreadLink(id: string): Promise<void> {
  if (nativeBackend()) {
    await invoke("plot_thread_link_delete", { id });
    return;
  }
  await db.delete(plotThreadSceneLinks).where(eq(plotThreadSceneLinks.id, id));
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
  return attachCreateResultMetadata(
    {
      id: s(r.id),
      projectId: s(r.projectId ?? r.project_id),
      fromThreadId: s(r.fromThreadId ?? r.from_thread_id),
      toThreadId: s(r.toThreadId ?? r.to_thread_id),
      atNodeId: s(r.atNodeId ?? r.at_node_id),
      kind: s(r.kind, "branch") as PlotBranchKind,
      createdAt: s(r.createdAt ?? r.created_at),
      updatedAt: s(r.updatedAt ?? r.updated_at),
    },
    raw,
  );
}

export interface PlotThreadRestoreSnapshot {
  requestId?: string;
  projectId: string;
  thread?: PlotThreadRow | null;
  links?: PlotThreadLinkRow[];
  branches?: PlotThreadBranchRow[];
}

export interface PlotThreadRestoreSnapshotResult {
  id: string;
  thread: PlotThreadRow | null;
  links: PlotThreadLinkRow[];
  branches: PlotThreadBranchRow[];
}

export interface PlotThreadDeleteSnapshot {
  requestId?: string;
  projectId: string;
  link: PlotThreadLinkRow;
  branches: PlotThreadBranchRow[];
}

export interface PlotThreadDeleteSnapshotResult {
  id: string;
  deleted: boolean;
}

export interface PlotThreadBranchTransition {
  before: PlotThreadBranchRow | null;
  after: PlotThreadBranchRow | null;
}

export interface PlotThreadMoveMarkerBundle {
  requestId?: string;
  projectId: string;
  markerBefore: PlotThreadLinkRow;
  markerAfter: PlotThreadLinkRow;
  branchTransitions: PlotThreadBranchTransition[];
}

export interface PlotThreadMoveMarkerBundleResult {
  id: string;
  marker: PlotThreadLinkRow;
  branches: PlotThreadBranchRow[];
  deletedBranchIds: string[];
}

function retryableSnapshotError(
  error: unknown,
  requestId: string,
  idempotencyDomain: string,
): never {
  if (error instanceof IpcInvokeError && error.outcome === "unknown") {
    throw new IpcInvokeError(
      error.command,
      {
        code: error.code,
        message: error.message,
        retryable: true,
        outcome: error.outcome,
        details: {
          ...error.details,
          requestId,
          idempotencyDomain,
        },
      },
      error,
    );
  }
  throw error;
}

/**
 * Undo/Redo 専用の atomic restore。thread と CASCADE で消えた child rows、
 * または marker と依存 branches を request ledger と同じ transaction で戻す。
 */
export async function restorePlotThreadSnapshot(
  data: PlotThreadRestoreSnapshot,
): Promise<PlotThreadRestoreSnapshotResult> {
  const requestId = data.requestId ?? crypto.randomUUID();
  try {
    const raw = await invoke("plot_thread_restore_snapshot", {
      payload: {
        requestId,
        projectId: data.projectId,
        thread: data.thread ?? null,
        links: data.links ?? [],
        branches: data.branches ?? [],
      },
    });
    const row = (raw ?? {}) as Record<string, unknown>;
    return attachCreateResultMetadata(
      {
        id: s(row.id, requestId),
        thread: row.thread == null ? null : normalizeThread(row.thread),
        links: Array.isArray(row.links) ? row.links.map(normalizeLink) : [],
        branches: Array.isArray(row.branches)
          ? row.branches.map(normalizeBranch)
          : [],
      },
      raw,
    );
  } catch (error) {
    retryableSnapshotError(error, requestId, "plot-thread-restore-snapshot");
  }
}

/**
 * marker と、その marker だけを anchor にする branches を atomic に削除する。
 * full persisted rows は native 側で現在値と照合され、unknown retry が同一 ID の
 * 更新済み／再作成済み row を消すことを防ぐ。
 */
export async function deletePlotThreadSnapshot(
  data: PlotThreadDeleteSnapshot,
): Promise<PlotThreadDeleteSnapshotResult> {
  const requestId = data.requestId ?? crypto.randomUUID();
  try {
    const raw = await invoke("plot_thread_delete_snapshot", {
      payload: {
        requestId,
        projectId: data.projectId,
        link: data.link,
        branches: data.branches,
      },
    });
    const row = (raw ?? {}) as Record<string, unknown>;
    return attachCreateResultMetadata(
      {
        id: s(row.id, requestId),
        deleted: row.deleted === true || row.deleted === 1,
      },
      raw,
    );
  } catch (error) {
    retryableSnapshotError(error, requestId, "plot-thread-delete-snapshot");
  }
}

/**
 * One marker drag, including every dependent branch transition. Every runtime
 * uses the typed command so the marker, branches, and durable request ledger
 * share one atomic transaction.
 */
export async function movePlotMarkerBundle(
  data: PlotThreadMoveMarkerBundle,
): Promise<PlotThreadMoveMarkerBundleResult> {
  const requestId = data.requestId ?? crypto.randomUUID();
  try {
    const raw = await invoke("plot_thread_move_marker_bundle", {
      payload: {
        requestId,
        projectId: data.projectId,
        markerBefore: data.markerBefore,
        markerAfter: data.markerAfter,
        branchTransitions: data.branchTransitions,
      },
    });
    const row = (raw ?? {}) as Record<string, unknown>;
    return attachCreateResultMetadata(
      {
        id: s(row.id, requestId),
        marker: normalizeLink(row.marker),
        branches: Array.isArray(row.branches)
          ? row.branches.map(normalizeBranch)
          : [],
        deletedBranchIds: Array.isArray(row.deletedBranchIds)
          ? row.deletedBranchIds.map(String)
          : [],
      },
      raw,
    );
  } catch (error) {
    retryableSnapshotError(error, requestId, "plot-thread-move-marker-bundle");
  }
}

export async function createPlotThreadBranch(data: {
  /** Reuse this domain ID when retrying the same logical create. */
  id?: string;
  projectId: string;
  fromThreadId: string;
  toThreadId: string;
  atNodeId: string;
  kind: PlotBranchKind;
}): Promise<PlotThreadBranchRow> {
  const id = data.id ?? crypto.randomUUID();
  try {
    const created = await invoke("plot_thread_branch_create", {
      payload: {
        id,
        projectId: data.projectId,
        fromThreadId: data.fromThreadId,
        toThreadId: data.toThreadId,
        atNodeId: data.atNodeId,
        kind: data.kind,
      },
    });
    return normalizeBranch(created);
  } catch (error) {
    if (error instanceof IpcInvokeError && error.outcome === "unknown") {
      throw new IpcInvokeError(
        error.command,
        {
          code: error.code,
          message: error.message,
          retryable: true,
          outcome: error.outcome,
          details: {
            ...error.details,
            requestId: id,
            idempotencyDomain: "plot-thread-branch-create",
          },
        },
        error,
      );
    }
    throw error;
  }
}

export async function updatePlotThreadBranch(
  id: string,
  patch: Partial<
    Pick<PlotThreadBranchRow, "fromThreadId" | "toThreadId" | "atNodeId">
  >,
): Promise<PlotThreadBranchRow> {
  await db
    .update(plotThreadBranches)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plotThreadBranches.id, id));
  const [updated] = await db
    .select()
    .from(plotThreadBranches)
    .where(eq(plotThreadBranches.id, id));
  if (!updated) {
    throw new Error(`plot thread branch not found after update: ${id}`);
  }
  return normalizeBranch(updated);
}

export async function deletePlotThreadBranch(id: string): Promise<void> {
  await db.delete(plotThreadBranches).where(eq(plotThreadBranches.id, id));
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
