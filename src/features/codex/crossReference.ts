import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { sceneCodexMentions, treeNodes } from "@/db/schema";
import { loadSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { listCodexMatchTargets } from "./api";
import type { CodexMatchRow } from "./api";
import { createCodexMatcher } from "./codexMatcher";
import { rebuildMatcher, matchText } from "./rustMatcher";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { needsBodyBackfill } from "@/features/codex/mentionRescanQueue";
import { and, eq } from "drizzle-orm";

interface QueryResult {
  rows: Array<{ id: string; title: string; parent_id: string | null }>;
}

export interface SceneMention {
  sceneId: string;
  sceneTitle: string;
  count: number;
}

export interface CrossReferenceEntry {
  entryId: string;
  entryName: string;
  entryType: string;
  scenes: SceneMention[];
}

export interface SceneCodexMentionRow {
  entryId: string;
  sceneId: string;
  sceneTitle: string;
}

/** Build the Galaxy cross-reference shape from the incremental mention index. */
export function buildCrossReferenceFromMentionRows(
  entries: CodexMatchRow[],
  rows: SceneCodexMentionRow[],
): CrossReferenceEntry[] {
  const scenesByEntry = new Map<string, Map<string, SceneMention>>();
  for (const row of rows) {
    const entryScenes = scenesByEntry.get(row.entryId) ?? new Map();
    if (!entryScenes.has(row.sceneId)) {
      entryScenes.set(row.sceneId, {
        sceneId: row.sceneId,
        sceneTitle: row.sceneTitle,
        count: 1,
      });
    }
    scenesByEntry.set(row.entryId, entryScenes);
  }

  return entries
    .map((entry) => ({
      entryId: entry.id,
      entryName: entry.name,
      entryType: entry.type,
      scenes: Array.from(scenesByEntry.get(entry.id)?.values() ?? []),
    }))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
}

async function buildCrossReferenceFromMentionIndex(
  projectId: string,
  entries: CodexMatchRow[],
): Promise<CrossReferenceEntry[]> {
  const rows = await db
    .select({
      entryId: sceneCodexMentions.codexEntryId,
      sceneId: sceneCodexMentions.sceneId,
      sceneTitle: treeNodes.title,
    })
    .from(sceneCodexMentions)
    .innerJoin(treeNodes, eq(sceneCodexMentions.sceneId, treeNodes.id))
    .where(
      and(
        eq(sceneCodexMentions.source, "body"),
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
      ),
    );
  return buildCrossReferenceFromMentionRows(entries, rows);
}

/** 互換 wrapper: hidden global の projectId を解決して projectId 明示版へ委譲する。 */
export async function buildCrossReferenceReport(): Promise<
  CrossReferenceEntry[]
> {
  return buildCrossReferenceReportForProject(getCurrentProjectId());
}

export async function buildCrossReferenceReportForProject(
  projectId: string,
): Promise<CrossReferenceEntry[]> {
  const entries = await listCodexMatchTargets(projectId);
  if (entries.length === 0) return [];

  const scenesResult = await invoke<QueryResult>("db_execute", {
    sql: "SELECT id, title, parent_id FROM tree_nodes WHERE node_type = 'scene' AND project_id = ? ORDER BY sort_order",
    params: [projectId],
    method: "all",
  });
  const scenes = scenesResult.rows;
  if (scenes.length === 0) return [];

  const targets = entries.map((e: CodexMatchRow) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    aliases: e.aliases,
    excludedAliases: e.excludedAliases,
  }));
  await rebuildMatcher(targets);

  const mentionMap = new Map<
    string,
    { entry: CodexMatchRow; scenes: Map<string, SceneMention> }
  >();

  for (const scene of scenes) {
    let content: string;
    try {
      const rawContent = await loadSceneContent(scene.id);
      content = prosemirrorToText(rawContent);
    } catch {
      continue;
    }
    if (!content) continue;

    const matches = await matchText(content, targets);
    const countsByEntry = new Map<string, number>();
    for (const m of matches) {
      countsByEntry.set(m.entryId, (countsByEntry.get(m.entryId) ?? 0) + 1);
    }

    for (const [entryId, count] of countsByEntry) {
      if (!mentionMap.has(entryId)) {
        const entry = entries.find((e: CodexMatchRow) => e.id === entryId);
        if (!entry) continue;
        mentionMap.set(entryId, { entry, scenes: new Map() });
      }
      mentionMap.get(entryId)!.scenes.set(scene.id, {
        sceneId: scene.id,
        sceneTitle: scene.title,
        count,
      });
    }
  }

  const result: CrossReferenceEntry[] = [];
  for (const { entry, scenes: sceneMap } of mentionMap.values()) {
    result.push({
      entryId: entry.id,
      entryName: entry.name,
      entryType: entry.type,
      scenes: Array.from(sceneMap.values()),
    });
  }
  result.sort((a, b) => a.entryName.localeCompare(b.entryName));

  for (const entry of entries) {
    if (!mentionMap.has(entry.id)) {
      result.push({
        entryId: entry.id,
        entryName: entry.name,
        entryType: entry.type,
        scenes: [],
      });
    }
  }

  return result;
}

/**
 * Galaxy only needs scene-entry connectivity, not occurrence counts. Use the
 * incremental body index there while preserving the full report's exact counts
 * for Codex references and co-occurrence consumers.
 */
export async function buildGalaxyCrossReferenceForProject(
  projectId: string,
): Promise<CrossReferenceEntry[]> {
  const entries = await listCodexMatchTargets(projectId);
  if (entries.length === 0) return [];
  if (await needsBodyBackfill(projectId)) {
    return buildCrossReferenceReportForProject(projectId);
  }
  return buildCrossReferenceFromMentionIndex(projectId, entries);
}

/** Simpler version: accepts pre-loaded scene texts, for testing */
export function buildCrossReferenceFromTexts(
  entries: Array<{ id: string; name: string; type: string }>,
  sceneTexts: Array<{ id: string; title: string; content: string }>,
): CrossReferenceEntry[] {
  if (entries.length === 0) return [];

  const matcher = createCodexMatcher(entries);
  const mentionMap = new Map<
    string,
    {
      entry: (typeof entries)[0];
      scenes: Map<string, SceneMention>;
    }
  >();

  for (const scene of sceneTexts) {
    if (!scene.content) continue;
    const matches = matcher(scene.content);
    const countsByEntry = new Map<string, number>();
    for (const m of matches) {
      countsByEntry.set(m.entryId, (countsByEntry.get(m.entryId) ?? 0) + 1);
    }
    for (const [entryId, count] of countsByEntry) {
      if (!mentionMap.has(entryId)) {
        const entry = entries.find((e) => e.id === entryId);
        if (!entry) continue;
        mentionMap.set(entryId, { entry, scenes: new Map() });
      }
      mentionMap.get(entryId)!.scenes.set(scene.id, {
        sceneId: scene.id,
        sceneTitle: scene.title,
        count,
      });
    }
  }

  const result: CrossReferenceEntry[] = [];
  for (const { entry, scenes } of mentionMap.values()) {
    result.push({
      entryId: entry.id,
      entryName: entry.name,
      entryType: entry.type,
      scenes: Array.from(scenes.values()),
    });
  }
  result.sort((a, b) => a.entryName.localeCompare(b.entryName));
  return result;
}
