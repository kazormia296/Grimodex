import { invoke } from "@/lib/tauri";
import { listCodexEntries } from "./api";
import type { CodexEntry } from "./api";
import { createCodexMatcher } from "./codexMatcher";

interface QueryResult {
  rows: Array<{ id: string; title: string; chapter_id: number }>;
}

export interface SceneMention {
  sceneId: string;
  sceneTitle: string;
  count: number;
}

export interface CrossReferenceEntry {
  entryId: number;
  entryName: string;
  entryType: string;
  scenes: SceneMention[];
}

export async function buildCrossReferenceReport(): Promise<
  CrossReferenceEntry[]
> {
  // Load all codex entries and scenes
  const entries = await listCodexEntries();
  if (entries.length === 0) return [];

  const scenesResult = await invoke<QueryResult>("db_execute", {
    sql: "SELECT id, title, chapter_id FROM scenes ORDER BY chapter_id, sort_order",
    params: [],
    method: "all",
  });
  const scenes = scenesResult.rows;
  if (scenes.length === 0) return [];

  // Build matcher from entries
  const targets = entries.map((e: CodexEntry) => ({
    id: e.id,
    name: e.name,
    type: e.type,
  }));
  const matcher = createCodexMatcher(targets);

  // Scan each scene's content
  const mentionMap = new Map<
    number,
    { entry: CodexEntry; scenes: Map<string, SceneMention> }
  >();

  for (const scene of scenes) {
    let content: string;
    try {
      content = await invoke<string>("content_read", {
        sceneId: scene.id,
      });
    } catch {
      continue;
    }
    if (!content) continue;

    const matches = matcher(content);
    // Count mentions per entry in this scene
    const countsByEntry = new Map<number, number>();
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

  // Build result sorted by entry name
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

  // Also include entries with no mentions (for completeness)
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

/** Simpler version: just ignore content_read, for testing */
export function buildCrossReferenceFromTexts(
  entries: Array<{ id: number; name: string; type: string }>,
  sceneTexts: Array<{ id: string; title: string; content: string }>,
): CrossReferenceEntry[] {
  if (entries.length === 0) return [];

  const matcher = createCodexMatcher(entries);
  const mentionMap = new Map<
    number,
    {
      entry: (typeof entries)[0];
      scenes: Map<string, SceneMention>;
    }
  >();

  for (const scene of sceneTexts) {
    if (!scene.content) continue;
    const matches = matcher(scene.content);
    const countsByEntry = new Map<number, number>();
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
