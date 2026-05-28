import { db } from "@/db/client";
import { projects, treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadProjectAttributionStats } from "./projectStats";
import type { AttributionStats } from "./attributionStats";

/**
 * Tally for a single report node (scene/chapter/project).
 *
 * Buckets:
 * - `human` — text explicitly marked as human-authored (AuthorshipMark source='human')
 * - `ai` — text marked source='ai'
 * - `unknown` — text marked source='unknown' (rare; explicit "source can't be determined")
 * - `unmarked` — text with no AuthorshipMark at all (legacy content / pre-attribution edits)
 *
 * `humanRatio` follows the existing UI convention: unmarked text counts toward the
 * "human" side of the human/ai ratio. The four raw buckets are kept in the JSON for
 * transparency so consumers can recompute differently if they want.
 */
export interface AuthorshipTotals {
  human: number;
  ai: number;
  unknown: number;
  unmarked: number;
  total: number;
  /** (human + unmarked) / total, or 0 when total === 0. */
  humanRatio: number;
}

export interface SceneAuthorshipReport {
  id: string;
  title: string;
  totals: AuthorshipTotals;
}

export interface ChapterAuthorshipReport {
  id: string;
  title: string;
  totals: AuthorshipTotals;
  scenes: SceneAuthorshipReport[];
}

/** Top-level report shape — matches plan §1.2 JSON schema. */
export interface ProjectAuthorshipReport {
  projectId: string;
  projectTitle: string;
  generatedAt: string;
  scope: "body-text-only";
  totals: AuthorshipTotals;
  chapters: ChapterAuthorshipReport[];
  /** Scenes that live at the project root (no folder parent). */
  unparentedScenes: SceneAuthorshipReport[];
}

const EMPTY_TOTALS = (): AuthorshipTotals => ({
  human: 0,
  ai: 0,
  unknown: 0,
  unmarked: 0,
  total: 0,
  humanRatio: 0,
});

function finalizeRatio(t: AuthorshipTotals): AuthorshipTotals {
  const denom = t.total;
  return {
    ...t,
    humanRatio: denom > 0 ? (t.human + t.unmarked) / denom : 0,
  };
}

function addStatsInto(target: AuthorshipTotals, stats: AttributionStats): void {
  target.human += stats.human;
  target.ai += stats.ai;
  target.unknown += stats.unknown;
  target.unmarked += stats.unmarked;
  target.total += stats.total;
}

function addTotalsInto(target: AuthorshipTotals, src: AuthorshipTotals): void {
  target.human += src.human;
  target.ai += src.ai;
  target.unknown += src.unknown;
  target.unmarked += src.unmarked;
  target.total += src.total;
}

function statsToTotals(stats: AttributionStats | undefined): AuthorshipTotals {
  const t = EMPTY_TOTALS();
  if (stats) addStatsInto(t, stats);
  return finalizeRatio(t);
}

/**
 * Build the project-wide Authorship Report from the DB.
 *
 * Aggregates `authorshipSpans` per scene, then rolls up to chapters (folders)
 * and the project. Codex / Snippet content is excluded by construction — only
 * `treeNodes` of type `scene` participate.
 *
 * Notes are excluded too: the report is positioned as a body-text claim
 * ("地の文は人力で書いた"), and notes are auxiliary material.
 */
export async function buildProjectAuthorshipReport(
  projectId: string,
): Promise<ProjectAuthorshipReport> {
  const projectRow = (
    await db
      .select({ id: projects.id, title: projects.title })
      .from(projects)
      .where(eq(projects.id, projectId))
  )[0];

  const nodes = await db
    .select({
      id: treeNodes.id,
      parentId: treeNodes.parentId,
      nodeType: treeNodes.nodeType,
      title: treeNodes.title,
      sortOrder: treeNodes.sortOrder,
      archivedAt: treeNodes.archivedAt,
    })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, projectId));

  const liveNodes = nodes.filter((n) => !n.archivedAt);
  const scenes = liveNodes.filter((n) => n.nodeType === "scene");
  const folders = liveNodes.filter((n) => n.nodeType === "folder");

  const sceneIds = scenes.map((s) => s.id);
  const sceneStats = await loadProjectAttributionStats(sceneIds);

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const folderById = new Map(folders.map((f) => [f.id, f]));

  const sortKey = (a: { sortOrder: string }, b: { sortOrder: string }) =>
    a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0;

  // group scenes under their TOP-MOST folder ancestor so deep structures
  // (Act > Chapter > Scene) still surface the top-level "chapter" in the report.
  function topmostChapterId(sceneId: string): string | null {
    let cur = sceneById.get(sceneId)?.parentId ?? null;
    let topmost: string | null = null;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const f = folderById.get(cur);
      if (!f) break;
      topmost = f.id;
      cur = f.parentId;
    }
    return topmost;
  }

  const scenesByChapter = new Map<string, SceneAuthorshipReport[]>();
  const unparentedScenes: SceneAuthorshipReport[] = [];

  const scenesSorted = [...scenes].sort(sortKey);
  for (const scene of scenesSorted) {
    const totals = statsToTotals(sceneStats[scene.id]);
    const entry: SceneAuthorshipReport = {
      id: scene.id,
      title: scene.title,
      totals,
    };
    const chapterId = topmostChapterId(scene.id);
    if (chapterId) {
      const arr = scenesByChapter.get(chapterId) ?? [];
      arr.push(entry);
      scenesByChapter.set(chapterId, arr);
    } else {
      unparentedScenes.push(entry);
    }
  }

  const chapters: ChapterAuthorshipReport[] = [...folders]
    .sort(sortKey)
    .map((folder) => {
      const sceneList = scenesByChapter.get(folder.id) ?? [];
      const totals = EMPTY_TOTALS();
      for (const s of sceneList) addTotalsInto(totals, s.totals);
      return {
        id: folder.id,
        title: folder.title,
        totals: finalizeRatio(totals),
        scenes: sceneList,
      };
    })
    // drop folders that contain zero scenes (e.g. structural-only folders)
    .filter((c) => c.scenes.length > 0);

  const projectTotals = EMPTY_TOTALS();
  for (const c of chapters) addTotalsInto(projectTotals, c.totals);
  for (const s of unparentedScenes) addTotalsInto(projectTotals, s.totals);

  return {
    projectId,
    projectTitle: projectRow?.title ?? "Untitled Project",
    generatedAt: new Date().toISOString(),
    scope: "body-text-only",
    totals: finalizeRatio(projectTotals),
    chapters,
    unparentedScenes,
  };
}
