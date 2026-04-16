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
import {
  listCodexTags,
  createCodexTag,
  setEntryTags,
} from "@/features/codex/tagApi";
import {
  listDefinitionsByType,
  createDefinition,
  upsertValue,
} from "@/features/codex/detailApi";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";
import type { ParsedCodexEntry, ParsedSnippet } from "./novelcrafterParser";

const PROJECT_ID = "default-project";

export interface ImportProgress {
  total: number;
  done: number;
  currentName: string;
}

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

/**
 * Convert plain text to a minimal ProseMirror paragraph document.
 * Blank lines create paragraph breaks.
 */
function fieldValueToProseMirror(text: string): string {
  if (!text.trim()) return "{}";
  const paragraphs: unknown[] = [];
  let paraLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (paraLines.length > 0) {
        paragraphs.push({
          type: "paragraph",
          content: [{ type: "text", text: paraLines.join("\n") }],
        });
        paraLines = [];
      }
    } else {
      paraLines.push(line);
    }
  }
  if (paraLines.length > 0) {
    paragraphs.push({
      type: "paragraph",
      content: [{ type: "text", text: paraLines.join("\n") }],
    });
  }
  return JSON.stringify({ type: "doc", content: paragraphs });
}

/**
 * Insert all parsed codex entries into the DB.
 * Thumbnails are resized/converted to WebP data URLs if present.
 * Tags and custom detail values are created/linked as needed.
 */
export async function importCodexEntries(
  entries: ParsedCodexEntry[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  const sorted = topoSortEntries(entries);

  // ── Phase 0: ensure builtin types exist ───────────────────────────────────
  await ensureBuiltinTypes(PROJECT_ID);

  // ── Phase 1: resolve tags ─────────────────────────────────────────────────
  // Collect all unique tag names from the batch
  const allTagNames = new Set<string>();
  for (const entry of sorted) {
    const tags = JSON.parse(entry.tagsCache) as {
      name: string;
      color: string | null;
    }[];
    for (const tag of tags) {
      if (tag.name) allTagNames.add(tag.name);
    }
  }
  // Load existing tags and create any that are missing
  const existingTags = await listCodexTags(PROJECT_ID);
  const tagNameToId = new Map(existingTags.map((t) => [t.name, t.id]));
  for (const name of allTagNames) {
    if (!tagNameToId.has(name)) {
      const tag = await createCodexTag({
        id: crypto.randomUUID(),
        projectId: PROJECT_ID,
        name,
      });
      tagNameToId.set(name, tag.id);
    }
  }

  // ── Phase 2: resolve custom detail definitions ────────────────────────────
  // Map: typeSlug → Map<fieldName, definitionId>
  const typeDefMap = new Map<string, Map<string, string>>();
  const typeSlugSet = new Set(sorted.map((e) => e.type));
  for (const typeSlug of typeSlugSet) {
    const defs = await listDefinitionsByType(PROJECT_ID, typeSlug);
    typeDefMap.set(typeSlug, new Map(defs.map((d) => [d.name, d.id])));
  }
  // Track next sort order per type (starting after any existing definitions)
  const typeNextSortOrder = new Map<string, number>();
  for (const [typeSlug, defMap] of typeDefMap) {
    typeNextSortOrder.set(typeSlug, defMap.size);
  }
  // Create missing definitions for fields that appear in this batch
  for (const entry of sorted) {
    if (!entry.fields) continue;
    const defMap = typeDefMap.get(entry.type)!;
    for (const fieldName of Object.keys(entry.fields)) {
      if (!defMap.has(fieldName)) {
        const sortOrder = typeNextSortOrder.get(entry.type) ?? 0;
        const def = await createDefinition({
          id: crypto.randomUUID(),
          projectId: PROJECT_ID,
          typeSlug: entry.type,
          name: fieldName,
          fieldType: "text",
          sortOrder,
          includeInContext: 1,
        });
        defMap.set(fieldName, def.id);
        typeNextSortOrder.set(entry.type, sortOrder + 1);
      }
    }
  }

  // ── Phase 3: insert entries ───────────────────────────────────────────────
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
          // tagsCache is set authoritatively by setEntryTags below
        });

        // Set real tag associations (also updates tagsCache on the entry)
        const tagNames = (
          JSON.parse(e.tagsCache) as { name: string; color: string | null }[]
        )
          .map((t) => t.name)
          .filter((n): n is string => Boolean(n));
        const tagIds = tagNames
          .map((name) => tagNameToId.get(name))
          .filter((id): id is string => id !== undefined);
        await setEntryTags(e.id, tagIds);

        // Upsert custom detail values
        if (e.fields) {
          const defMap = typeDefMap.get(e.type)!;
          for (const [fieldName, value] of Object.entries(e.fields)) {
            const defId = defMap.get(fieldName);
            if (defId) {
              await upsertValue(e.id, defId, fieldValueToProseMirror(value));
            }
          }
        }
      } catch (updateErr) {
        // Roll back the created entry to avoid leaving partial data in the DB.
        // ON DELETE CASCADE removes codex_entry_tags and codex_detail_values.
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
