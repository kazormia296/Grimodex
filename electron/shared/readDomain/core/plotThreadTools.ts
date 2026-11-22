import { and, eq, inArray, isNull } from "drizzle-orm";

import type { CoreReadContext } from "../../mastraRead/ports.js";
import {
  PLOT_PHASE_TYPES,
  plotThreadBranches,
  plotThreadSceneLinks,
  plotThreads,
  treeNodes,
  type PlotPhaseType,
} from "../db/schema.js";
import { cmpKeys } from "../features/tree/fractionalIndex.js";
import { prosemirrorToText } from "../lib/prosemirror.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The plot thread read tools of the shared core (Mastra migration MP-4b,
 * PR-4): `list_plot_threads` and `get_thread_scenes`. The scene bodies of
 * `get_thread_scenes` come through the body port, whose `barrier` says whether
 * a read waits for a write that has not reached the store (the renderer does,
 * main cannot: DR-MP4-9).
 */

const THREAD_SCENE_MAX = 8;
const THREAD_EXCERPT_MAX_CHARS = 800;

/** phaseType の表示順 index（未知値は末尾）。 */
function phaseRank(p: string): number {
  const i = (PLOT_PHASE_TYPES as readonly string[]).indexOf(p);
  return i < 0 ? PLOT_PHASE_TYPES.length : i;
}

/** 不正な phaseType 文字列を既定値に丸める（CHECK は SQL 側のみ＝混入し得る）。 */
function normalizePhase(p: string): PlotPhaseType {
  return (PLOT_PHASE_TYPES as readonly string[]).includes(p)
    ? (p as PlotPhaseType)
    : "develop";
}

export async function listPlotThreads(
  ctx: CoreReadContext,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const threads = await db
    .select({
      id: plotThreads.id,
      name: plotThreads.name,
      description: plotThreads.description,
      sortOrder: plotThreads.sortOrder,
    })
    .from(plotThreads)
    .where(eq(plotThreads.projectId, projectId));

  const threadIds = threads.map((t) => t.id);
  const links =
    threadIds.length > 0
      ? await db
          .select({
            threadId: plotThreadSceneLinks.threadId,
            nodeId: plotThreadSceneLinks.nodeId,
            phaseType: plotThreadSceneLinks.phaseType,
          })
          .from(plotThreadSceneLinks)
          .where(inArray(plotThreadSceneLinks.threadId, threadIds))
      : [];

  // thread ごとの distinct scene 数 + 到達 phase 集合。
  const sceneSets = new Map<string, Set<string>>();
  const phaseSets = new Map<string, Set<string>>();
  for (const l of links) {
    let sc = sceneSets.get(l.threadId);
    if (!sc) {
      sc = new Set();
      sceneSets.set(l.threadId, sc);
    }
    sc.add(l.nodeId);
    let ph = phaseSets.get(l.threadId);
    if (!ph) {
      ph = new Set();
      phaseSets.set(l.threadId, ph);
    }
    ph.add(l.phaseType);
  }

  const ordered = [...threads].sort((a, b) =>
    cmpKeys(a.sortOrder, b.sortOrder),
  );
  const content = ordered.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? "",
    sceneCount: sceneSets.get(t.id)?.size ?? 0,
    phases: PLOT_PHASE_TYPES.filter((p) => phaseSets.get(t.id)?.has(p)),
  }));

  const json = JSON.stringify(content);
  return {
    name: "list_plot_threads",
    content,
    summary: `${content.length} plot thread(s)`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getThreadScenes(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const threadId = String(params["threadId"] ?? "").trim();
  if (!threadId)
    return {
      name: "get_thread_scenes",
      content: null,
      summary: "No threadId provided",
      tokensUsed: 0,
    };

  // XPROJ 1段目: thread_id → plot_threads.project_id を検証。別 project の
  // スレッド UUID を渡しても、シーン/リンク/本文に触れる前にここで弾く
  // （nodeId 単独 lookup 禁止＝plot_thread_scene_links は project_id を持たず
  // 親スレッド経由でしか scope できないため）。
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const [thread] = await db
    .select({
      id: plotThreads.id,
      name: plotThreads.name,
      description: plotThreads.description,
    })
    .from(plotThreads)
    .where(
      and(eq(plotThreads.id, threadId), eq(plotThreads.projectId, projectId)),
    );

  if (!thread)
    return {
      name: "get_thread_scenes",
      content: null,
      summary: "Thread not found",
      tokensUsed: 0,
    };

  // 2段目: 親スレッド検証済みなので links を threadId で取得。
  const links = await db
    .select({
      nodeId: plotThreadSceneLinks.nodeId,
      phaseType: plotThreadSceneLinks.phaseType,
      note: plotThreadSceneLinks.note,
      sortOrder: plotThreadSceneLinks.sortOrder,
    })
    .from(plotThreadSceneLinks)
    // 行が無い node（削除済みなど）の link は従来どおり残し、archived の場面の link だけ除く。
    // dedup と THREAD_SCENE_MAX の切り詰めより前に外す（archived が枠を使わない）。
    .leftJoin(treeNodes, eq(plotThreadSceneLinks.nodeId, treeNodes.id))
    .where(
      and(
        eq(plotThreadSceneLinks.threadId, threadId),
        isNull(treeNodes.archivedAt),
      ),
    );

  // PLOT_PHASE_TYPES 順 → 同 phase 内は sortOrder。
  const orderedLinks = [...links].sort((a, b) => {
    const pr = phaseRank(a.phaseType) - phaseRank(b.phaseType);
    if (pr !== 0) return pr;
    return cmpKeys(a.sortOrder ?? "", b.sortOrder ?? "");
  });

  // scene title をまとめて解決（active project の treeNodes に限定）。
  const nodeIds = [...new Set(orderedLinks.map((l) => l.nodeId))];
  const titleRows =
    nodeIds.length > 0
      ? await db
          .select({ id: treeNodes.id, title: treeNodes.title })
          .from(treeNodes)
          .where(
            and(
              inArray(treeNodes.id, nodeIds),
              eq(treeNodes.projectId, projectId),
              isNull(treeNodes.archivedAt),
            ),
          )
      : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  // 1 シーンが複数 phase マーカーを持ち得るので nodeId で dedup（最初＝最も早い
  // phase を採用）。list_plot_threads の distinct scene 数と一貫させ、同一シーンが
  // 重複出力されるのを防ぐ。
  const seenNodes = new Set<string>();
  const dedupedLinks = orderedLinks.filter((l) => {
    if (seenNodes.has(l.nodeId)) return false;
    seenNodes.add(l.nodeId);
    return true;
  });

  const capped = dedupedLinks.slice(0, THREAD_SCENE_MAX);
  const scenes: Array<{
    id: string;
    title: string;
    phaseType: PlotPhaseType;
    note: string;
    excerpt: string;
  }> = [];
  const contentMap = await ctx.body
    .readSceneBodies(capped.map((l) => l.nodeId))
    .catch(() => new Map<string, string>());
  for (const l of capped) {
    const text = prosemirrorToText(contentMap.get(l.nodeId) ?? "");
    scenes.push({
      id: l.nodeId,
      title: titleById.get(l.nodeId) ?? "",
      phaseType: normalizePhase(l.phaseType),
      note: l.note ?? "",
      excerpt: text.slice(0, THREAD_EXCERPT_MAX_CHARS),
    });
  }

  // このスレッドに関わる branch（project でも絞る＝XPROJ）。
  const branchRows = await db
    .select({
      fromThreadId: plotThreadBranches.fromThreadId,
      toThreadId: plotThreadBranches.toThreadId,
      atNodeId: plotThreadBranches.atNodeId,
      kind: plotThreadBranches.kind,
    })
    .from(plotThreadBranches)
    .where(eq(plotThreadBranches.projectId, projectId));
  const branches = branchRows.filter(
    (b) => b.fromThreadId === threadId || b.toThreadId === threadId,
  );

  const content = {
    id: thread.id,
    name: thread.name,
    description: thread.description ?? "",
    sceneCount: dedupedLinks.length,
    scenes,
    branches,
  };
  const json = JSON.stringify(content);
  return {
    name: "get_thread_scenes",
    content,
    summary: `Thread '${thread.name}': ${scenes.length}/${dedupedLinks.length} scene(s)`,
    tokensUsed: ctx.countTokens(json),
  };
}
