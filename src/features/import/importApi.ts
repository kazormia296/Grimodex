/**
 * Bulk-import parsed Novelcrafter data into the Grimodex database.
 */

import { createCodexEntry, updateCodexEntry } from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { resizeAndConvertToWebP } from "@/features/codex/iconUtils";
import type { ParsedCodexEntry, ParsedSnippet } from "./novelcrafterParser";

const PROJECT_ID = "default-project";

export interface ImportProgress {
  total: number;
  done: number;
  currentName: string;
}

export interface ImportResult {
  codexImported: number;
  snippetsImported: number;
  errors: string[];
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

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    onProgress?.({ total: entries.length, done: i, currentName: e.name });

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

      await updateCodexEntry(e.id, {
        content: e.content,
        icon: icon ?? null,
        contextMode: e.contextMode,
        tagsCache: e.tagsCache,
      });

      imported++;
    } catch (err) {
      errors.push(`${e.name}: ${String(err)}`);
    }
  }

  onProgress?.({
    total: entries.length,
    done: entries.length,
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
