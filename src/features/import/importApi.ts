/**
 * Bulk-import parsed Novelcrafter data into the Grimodex database.
 */

import {
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { resizeAndConvertToWebP } from "@/features/codex/iconUtils";
import type { ParsedCodexEntry, ParsedSnippet } from "./novelcrafterParser";

const PROJECT_ID = "default-project";

/**
 * Topologically sort entries so that every parent appears before its children.
 * Entries whose parentId refers to an entry outside the batch (already in DB)
 * are treated as root-level and inserted in their original relative order.
 */
function topoSortEntries(entries: ParsedCodexEntry[]): ParsedCodexEntry[] {
  const idSet = new Set(entries.map((e) => e.id));
  const idToEntry = new Map(entries.map((e) => [e.id, e]));
  const visited = new Set<string>();
  const result: ParsedCodexEntry[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const entry = idToEntry.get(id);
    if (!entry) return;
    if (entry.parentId && idSet.has(entry.parentId)) {
      visit(entry.parentId);
    }
    result.push(entry);
  }

  for (const entry of entries) {
    visit(entry.id);
  }

  return result;
}

export interface ImportProgress {
  total: number;
  done: number;
  currentName: string;
}

/**
 * Insert all parsed codex entries into the DB.
 * Thumbnails are resized/converted to WebP data URLs if present.
 */
export async function importCodexEntries(
  entries: ParsedCodexEntry[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  const sorted = topoSortEntries(entries);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    onProgress?.({ total: sorted.length, done: i, currentName: e.name });

    try {
      let icon: string | undefined;
      if (e.thumbnail) {
        try {
          const file = new File([e.thumbnail], "thumbnail.jpg", {
            type: "image/jpeg",
          });
          icon = await resizeAndConvertToWebP(file);
        } catch {
          // thumbnail conversion is best-effort
        }
      }

      await createCodexEntry({
        id: e.id,
        projectId: PROJECT_ID,
        type: e.type,
        name: e.name,
        aliases: JSON.stringify(e.aliases),
        summary: e.summary || undefined,
        parentId: e.parentId,
      });

      try {
        await updateCodexEntry(e.id, {
          content: e.content,
          icon: icon ?? null,
          contextMode: e.contextMode,
          tagsCache: e.tagsCache,
        });
      } catch (updateErr) {
        // Roll back the created entry to avoid leaving partial data in the DB
        try {
          await deleteCodexEntry(e.id);
        } catch {
          // best-effort rollback
        }
        throw updateErr;
      }

      imported++;
    } catch (err) {
      errors.push(`${e.name}: ${String(err)}`);
    }
  }

  onProgress?.({
    total: sorted.length,
    done: sorted.length,
    currentName: "",
  });
  return { imported, errors };
}

/**
 * Insert all parsed snippets into the DB.
 */
export async function importSnippets(
  snippets: ParsedSnippet[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    onProgress?.({ total: snippets.length, done: i, currentName: s.title });

    try {
      await createSnippet({
        id: s.id,
        projectId: PROJECT_ID,
        title: s.title,
        content: s.content,
        contentSource: "human",
      });
      imported++;
    } catch (err) {
      errors.push(`${s.title}: ${String(err)}`);
    }
  }

  onProgress?.({
    total: snippets.length,
    done: snippets.length,
    currentName: "",
  });
  return { imported, errors };
}
