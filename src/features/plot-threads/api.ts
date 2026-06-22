import { db } from "@/db/client";
import { invoke, isTauri } from "@/lib/tauri";
import { plotThreads, plotThreadSceneLinks } from "@/db/schema";
import type { PlotPhaseType } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export interface PlotThreadRow {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: string;
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
  if (isTauri()) {
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
  if (isTauri()) {
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
  if (isTauri()) {
    await invoke("plot_thread_delete", { id });
    return;
  }
  await db.delete(plotThreads).where(eq(plotThreads.id, id));
}

export async function listPlotThreads(
  projectId: string,
): Promise<PlotThreadRow[]> {
  if (isTauri()) {
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
  if (isTauri()) {
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
    Pick<PlotThreadLinkRow, "nodeId" | "phaseType" | "note" | "sortOrder">
  >,
): Promise<void> {
  if (isTauri()) {
    const p: Record<string, unknown> = {};
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
  if (isTauri()) {
    await invoke("plot_thread_link_delete", { id });
    return;
  }
  await db.delete(plotThreadSceneLinks).where(eq(plotThreadSceneLinks.id, id));
}

export async function listPlotThreadLinks(
  projectId: string,
): Promise<PlotThreadLinkRow[]> {
  if (isTauri()) {
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
