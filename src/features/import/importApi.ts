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
import {
  ensureBuiltinTypes,
  listCodexTypes,
  createCodexType,
} from "@/features/codex/typeApi";
import { createNode, listNodes, saveSceneContent } from "@/features/tree/api";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import { db } from "@/db/client";
import { chatSessions, chatMessages } from "@/db/schema";
import type {
  ParsedCodexEntry,
  ParsedSnippet,
  ParsedChapter,
  ParsedChatSession,
} from "./novelcrafterParser";

export const PROJECT_ID = "default-project";

/**
 * How a tag maps to a CodexType during import.
 * - "none": tag is not used for type assignment
 * - "new": a new CodexType is created using the tag name as label
 * - "existing": the entry is assigned an existing CodexType by slug
 */
export type TagMappingAction =
  | { mode: "none" }
  | { mode: "new" }
  | { mode: "existing"; typeSlug: string };

export interface TagImportOptions {
  /** Per-tag type assignment configuration */
  tagTypeMap: Map<string, TagMappingAction>;
  /** entryId → tag name to use when multiple mapped tags conflict */
  conflictResolutions: Map<string, string>;
}

export interface ImportProgress {
  total: number;
  done: number;
  currentName: string;
}

/** Convert a tag name to a safe CodexType slug. */
function tagNameToSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
  return slug || "custom_type";
}

/** Resolve the effective type slug for an entry, applying tag-based overrides. */
function resolveEntryType(
  entry: ParsedCodexEntry,
  tagNameToTypeSlug: Map<string, string>,
  conflictResolutions: Map<string, string>,
): string {
  const tags = JSON.parse(entry.tagsCache) as {
    name: string;
    color: string | null;
  }[];
  const mappedTags = tags
    .map((t) => t.name)
    .filter(Boolean)
    .filter((name) => tagNameToTypeSlug.has(name));

  if (mappedTags.length === 0) return entry.type;
  if (mappedTags.length === 1) return tagNameToTypeSlug.get(mappedTags[0])!;

  const selectedTag = conflictResolutions.get(entry.id);
  if (selectedTag && tagNameToTypeSlug.has(selectedTag)) {
    return tagNameToTypeSlug.get(selectedTag)!;
  }
  return tagNameToTypeSlug.get(mappedTags[0])!;
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
 * Pass tagOptions to override entry types based on tag mappings.
 */
export async function importCodexEntries(
  entries: ParsedCodexEntry[],
  onProgress?: (p: ImportProgress) => void,
  tagOptions?: TagImportOptions,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  const sorted = topoSortEntries(entries);

  // ── Phase 0: ensure builtin types exist ───────────────────────────────────
  await ensureBuiltinTypes(PROJECT_ID);

  // ── Phase 0.5: resolve tag→type mappings ─────────────────────────────────
  const tagNameToTypeSlug = new Map<string, string>();
  if (tagOptions && tagOptions.tagTypeMap.size > 0) {
    const allTypes = await listCodexTypes(PROJECT_ID);
    const existingSlugSet = new Set(allTypes.map((t) => t.slug));
    const createdSlugs = new Set(existingSlugSet);

    for (const [tagName, action] of tagOptions.tagTypeMap) {
      if (action.mode === "none") continue;
      if (action.mode === "existing") {
        tagNameToTypeSlug.set(tagName, action.typeSlug);
      } else {
        // mode === "new"
        const slug = tagNameToSlug(tagName);
        if (createdSlugs.has(slug)) {
          tagNameToTypeSlug.set(tagName, slug);
        } else {
          const newType = await createCodexType({
            projectId: PROJECT_ID,
            slug,
            label: tagName,
          });
          tagNameToTypeSlug.set(tagName, newType.slug);
          createdSlugs.add(slug);
        }
      }
    }
  }

  // Pre-compute effective type for each entry
  const resolvedTypeMap = new Map<string, string>();
  const conflicts =
    tagOptions?.conflictResolutions ?? new Map<string, string>();
  for (const entry of sorted) {
    resolvedTypeMap.set(
      entry.id,
      resolveEntryType(entry, tagNameToTypeSlug, conflicts),
    );
  }

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
  const typeSlugSet = new Set(
    sorted.map((e) => resolvedTypeMap.get(e.id) ?? e.type),
  );
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
    const effectiveType = resolvedTypeMap.get(entry.id) ?? entry.type;
    const defMap = typeDefMap.get(effectiveType)!;
    for (const fieldName of Object.keys(entry.fields)) {
      if (!defMap.has(fieldName)) {
        const sortOrder = typeNextSortOrder.get(effectiveType) ?? 0;
        const def = await createDefinition({
          id: crypto.randomUUID(),
          projectId: PROJECT_ID,
          typeSlug: effectiveType,
          name: fieldName,
          fieldType: "text",
          sortOrder,
          includeInContext: 1,
        });
        defMap.set(fieldName, def.id);
        typeNextSortOrder.set(effectiveType, sortOrder + 1);
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

      const effectiveType = resolvedTypeMap.get(e.id) ?? e.type;

      await createCodexEntry({
        id: e.id,
        projectId: PROJECT_ID,
        type: effectiveType,
        name: e.name,
        aliases: JSON.stringify(e.aliases),
        parentId: e.parentId,
      });

      try {
        await updateCodexEntry(e.id, {
          content: fieldValueToProseMirror(e.summary),
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
          const defMap = typeDefMap.get(effectiveType)!;
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

// ─────────────────────────────────────────────────────────────────
// Novel body (chapters / scenes from novel.md)
// ─────────────────────────────────────────────────────────────────

/**
 * Insert chapters (folders) and their scenes into the tree, appended after any
 * existing top-level nodes. Each scene's bullets become its synopsis and the
 * post-`---` body becomes its ProseMirror content.
 */
export async function importChapters(
  chapters: ParsedChapter[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  const totalScenes = chapters.reduce((sum, c) => sum + c.scenes.length, 0);
  const total = chapters.length + totalScenes;
  if (total === 0) {
    onProgress?.({ total: 0, done: 0, currentName: "" });
    return { imported: 0, errors };
  }

  // Append chapters after any existing top-level nodes
  const allRoots = (await listNodes(PROJECT_ID, null)).slice();
  allRoots.sort((a, b) =>
    a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0,
  );
  const lastRootKey = allRoots.at(-1)?.sortOrder ?? null;
  const chapterKeys = generateNKeysBetween(lastRootKey, null, chapters.length);

  let done = 0;
  for (let ci = 0; ci < chapters.length; ci++) {
    const chapter = chapters[ci];
    onProgress?.({ total, done, currentName: chapter.title });
    try {
      await createNode({
        id: chapter.id,
        projectId: PROJECT_ID,
        nodeType: "folder",
        title: chapter.title || "Untitled",
        sortOrder: chapterKeys[ci],
      });
      imported++;
      done++;

      if (chapter.scenes.length > 0) {
        const sceneKeys = generateNKeysBetween(
          null,
          null,
          chapter.scenes.length,
        );
        for (let si = 0; si < chapter.scenes.length; si++) {
          const scene = chapter.scenes[si];
          onProgress?.({ total, done, currentName: scene.title });
          try {
            await createNode({
              id: scene.id,
              projectId: PROJECT_ID,
              parentId: chapter.id,
              nodeType: "scene",
              title: scene.title || "Untitled",
              sortOrder: sceneKeys[si],
            });
            // Set body content if present
            if (scene.body) {
              await saveSceneContent(scene.id, {
                content: fieldValueToProseMirror(scene.body),
                charCount: scene.body.length,
              });
            }
            imported++;
          } catch (sceneErr) {
            errors.push(`${scene.title}: ${String(sceneErr)}`);
          }
          done++;
        }
      }
    } catch (chapterErr) {
      errors.push(`${chapter.title}: ${String(chapterErr)}`);
      // Skip ahead past this chapter's scenes in progress
      done += chapter.scenes.length;
    }
  }

  onProgress?.({ total, done: total, currentName: "" });
  return { imported, errors };
}

// ─────────────────────────────────────────────────────────────────
// Chat sessions (chats/*.md)
// ─────────────────────────────────────────────────────────────────

/**
 * Insert parsed chat sessions and their messages directly via Drizzle so we
 * can preserve the original session createdAt and produce a deterministic
 * createdAt sequence for messages within a session.
 */
export async function importChatSessionsBatch(
  sessionsToImport: ParsedChatSession[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: number; errors: string[] }> {
  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < sessionsToImport.length; i++) {
    const s = sessionsToImport[i];
    onProgress?.({
      total: sessionsToImport.length,
      done: i,
      currentName: s.title,
    });

    try {
      const sessionCreated = s.createdAt;
      await db.insert(chatSessions).values({
        id: s.id,
        projectId: PROJECT_ID,
        nodeId: null,
        title: s.title || "Imported chat",
        titleManual: s.titleFromFrontmatter ? 1 : 0,
        createdAt: sessionCreated,
        updatedAt: sessionCreated,
      });

      // Generate strictly-increasing createdAt timestamps for messages so they
      // sort in the order they appeared in the chat file. Add one millisecond
      // per message to the session timestamp.
      const baseMs = Date.parse(sessionCreated);
      for (let mi = 0; mi < s.messages.length; mi++) {
        const msg = s.messages[mi];
        const ts = new Date(baseMs + mi).toISOString();
        await db.insert(chatMessages).values({
          id: crypto.randomUUID(),
          sessionId: s.id,
          role: msg.role,
          content: msg.content,
          createdAt: ts,
        });
      }
      imported++;
    } catch (err) {
      errors.push(`${s.title}: ${String(err)}`);
    }
  }

  onProgress?.({
    total: sessionsToImport.length,
    done: sessionsToImport.length,
    currentName: "",
  });
  return { imported, errors };
}
