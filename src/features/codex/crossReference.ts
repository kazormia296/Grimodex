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
import { enqueueRescan } from "@/features/codex/mentionRescanQueue";
import { isBodyMentionIndexReady } from "@/features/codex/bodyMentionIndexState";
import { and, eq, inArray } from "drizzle-orm";
import {
  extractCodexSemanticLinks,
  type CodexSemanticLink,
} from "./semanticLinks";

interface QueryResult {
  rows: Array<{ id: string; title: string; parent_id: string | null }>;
}

export interface SceneMention {
  sceneId: string;
  sceneTitle: string;
  count: number;
  /** Exact surface name/alias matches in the body. */
  automaticCount?: number;
  /** Exact author-declared span links in the body. */
  semanticCount?: number;
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
  source?: string;
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
        inArray(sceneCodexMentions.source, ["body", "semantic"]),
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
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  for (const scene of scenes) {
    let content: string;
    let semanticLinks: CodexSemanticLink[];
    try {
      const rawContent = await loadSceneContent(scene.id);
      content = prosemirrorToText(rawContent);
      semanticLinks = extractCodexSemanticLinks(rawContent);
    } catch {
      continue;
    }

    const matches = content ? await matchText(content, targets) : [];
    const automaticCounts = new Map<string, number>();
    for (const m of matches) {
      automaticCounts.set(m.entryId, (automaticCounts.get(m.entryId) ?? 0) + 1);
    }
    const semanticCounts = new Map<string, number>();
    for (const link of semanticLinks) {
      if (!entriesById.has(link.entryId)) continue;
      semanticCounts.set(
        link.entryId,
        (semanticCounts.get(link.entryId) ?? 0) + 1,
      );
    }
    const mentionedEntryIds = new Set([
      ...automaticCounts.keys(),
      ...semanticCounts.keys(),
    ]);

    for (const entryId of mentionedEntryIds) {
      if (!mentionMap.has(entryId)) {
        const entry = entriesById.get(entryId);
        if (!entry) continue;
        mentionMap.set(entryId, { entry, scenes: new Map() });
      }
      const automaticCount = automaticCounts.get(entryId) ?? 0;
      const semanticCount = semanticCounts.get(entryId) ?? 0;
      mentionMap.get(entryId)!.scenes.set(scene.id, {
        sceneId: scene.id,
        sceneTitle: scene.title,
        count: automaticCount + semanticCount,
        automaticCount,
        semanticCount,
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
  if (!(await isBodyMentionIndexReady(projectId, entries))) {
    await enqueueRescan(null, projectId);
    if (await isBodyMentionIndexReady(projectId, entries)) {
      return buildCrossReferenceFromMentionIndex(projectId, entries);
    }
    return buildCrossReferenceReportForProject(projectId);
  }
  return buildCrossReferenceFromMentionIndex(projectId, entries);
}

/** Simpler version: accepts pre-loaded scene texts, for testing */
export function buildCrossReferenceFromTexts(
  entries: Array<{ id: string; name: string; type: string }>,
  sceneTexts: Array<{
    id: string;
    title: string;
    content: string;
    semanticLinks?: CodexSemanticLink[];
  }>,
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
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  for (const scene of sceneTexts) {
    const matches = scene.content ? matcher(scene.content) : [];
    const automaticCounts = new Map<string, number>();
    for (const m of matches) {
      automaticCounts.set(m.entryId, (automaticCounts.get(m.entryId) ?? 0) + 1);
    }
    const semanticCounts = new Map<string, number>();
    for (const link of scene.semanticLinks ?? []) {
      if (!entriesById.has(link.entryId)) continue;
      semanticCounts.set(
        link.entryId,
        (semanticCounts.get(link.entryId) ?? 0) + 1,
      );
    }
    const mentionedEntryIds = new Set([
      ...automaticCounts.keys(),
      ...semanticCounts.keys(),
    ]);
    for (const entryId of mentionedEntryIds) {
      if (!mentionMap.has(entryId)) {
        const entry = entriesById.get(entryId);
        if (!entry) continue;
        mentionMap.set(entryId, { entry, scenes: new Map() });
      }
      const automaticCount = automaticCounts.get(entryId) ?? 0;
      const semanticCount = semanticCounts.get(entryId) ?? 0;
      mentionMap.get(entryId)!.scenes.set(scene.id, {
        sceneId: scene.id,
        sceneTitle: scene.title,
        count: automaticCount + semanticCount,
        automaticCount,
        semanticCount,
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
