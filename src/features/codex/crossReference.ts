import { invoke } from "@/lib/tauri";
import { loadSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import { listCodexEntries } from "./api";
import type { CodexEntry } from "./api";
import { createCodexMatcher } from "./codexMatcher";
import { rebuildMatcher, matchText } from "./rustMatcher";
import { getCurrentProjectId } from "@/features/project/projectStore";

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

export async function buildCrossReferenceReport(): Promise<
  CrossReferenceEntry[]
> {
  const projectId = getCurrentProjectId();
  const entries = await listCodexEntries(projectId);
  if (entries.length === 0) return [];

  const scenesResult = await invoke<QueryResult>("db_execute", {
    sql: "SELECT id, title, parent_id FROM tree_nodes WHERE node_type = 'scene' AND project_id = ? ORDER BY sort_order",
    params: [projectId],
    method: "all",
  });
  const scenes = scenesResult.rows;
  if (scenes.length === 0) return [];

  const targets = entries.map((e: CodexEntry) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    aliases: e.aliases,
    excludedAliases: e.excludedAliases,
  }));
  await rebuildMatcher(targets);

  const mentionMap = new Map<
    string,
    { entry: CodexEntry; scenes: Map<string, SceneMention> }
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
        const entry = entries.find((e: CodexEntry) => e.id === entryId);
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
