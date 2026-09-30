import { db } from "@/db/client";
import { codexTags, codexEntryTags, snippetEntryTags } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
} from "@/features/native-writes/writeContext";

export type CodexTag = typeof codexTags.$inferSelect;

interface TagWriteOptions {
  writeContext?: CanonicalWriteContext;
}

interface EntityTagWriteOptions extends TagWriteOptions {
  projectId?: string;
}

export async function listCodexTags(projectId: string): Promise<CodexTag[]> {
  return db.select().from(codexTags).where(eq(codexTags.projectId, projectId));
}

export async function createCodexTag(
  data: {
    id: string;
    projectId: string;
    name: string;
    color?: string;
    typeFilter?: string[];
  },
  options: TagWriteOptions = {},
): Promise<CodexTag> {
  await invoke("codex_mutate", {
    payload: {
      operation: "tag.create",
      projectId: data.projectId,
      ...(options.writeContext ?? createCanonicalWriteContext()),
      surface: "manual",
      tagId: data.id,
      name: data.name,
      color: data.color ?? null,
      typeFilter: data.typeFilter ? JSON.stringify(data.typeFilter) : null,
      createdAt: new Date().toISOString(),
    },
  });
  const rows = await db
    .select()
    .from(codexTags)
    .where(eq(codexTags.id, data.id));
  if (!rows[0]) throw new Error(`Failed to create Codex tag '${data.id}'`);
  return rows[0];
}

export async function updateCodexTag(
  id: string,
  data: {
    name?: string;
    color?: string;
    typeFilter?: string[] | null;
  },
  options: TagWriteOptions = {},
): Promise<CodexTag | undefined> {
  const current = await db.select().from(codexTags).where(eq(codexTags.id, id));
  if (!current[0]) return undefined;
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.color !== undefined) updateData.color = data.color;
  if ("typeFilter" in data) {
    updateData.typeFilter =
      data.typeFilter != null ? JSON.stringify(data.typeFilter) : null;
  }
  await invoke("codex_mutate", {
    payload: {
      operation: "tag.update",
      projectId: current[0].projectId,
      ...(options.writeContext ?? createCanonicalWriteContext()),
      surface: "manual",
      tagId: id,
      ...updateData,
    },
  });
  const rows = await db.select().from(codexTags).where(eq(codexTags.id, id));
  return rows[0];
}

export async function deleteCodexTag(
  id: string,
  options: TagWriteOptions = {},
): Promise<void> {
  const rows = await db
    .select({ projectId: codexTags.projectId })
    .from(codexTags)
    .where(eq(codexTags.id, id));
  if (!rows[0]) return;
  await invoke("codex_mutate", {
    payload: {
      operation: "tag.delete",
      projectId: rows[0].projectId,
      ...(options.writeContext ?? createCanonicalWriteContext()),
      surface: "manual",
      tagId: id,
    },
  });
}

export async function listEntryTags(entryId: string): Promise<CodexTag[]> {
  const rows = await db
    .select({ tag: codexTags })
    .from(codexEntryTags)
    .innerJoin(codexTags, eq(codexEntryTags.tagId, codexTags.id))
    .where(eq(codexEntryTags.entryId, entryId))
    .orderBy(asc(codexTags.name));
  return rows.map((r) => r.tag);
}

export async function listSnippetEntryTags(
  snippetId: string,
): Promise<CodexTag[]> {
  const rows = await db
    .select({ tag: codexTags })
    .from(snippetEntryTags)
    .innerJoin(codexTags, eq(snippetEntryTags.tagId, codexTags.id))
    .where(eq(snippetEntryTags.snippetId, snippetId))
    .orderBy(asc(codexTags.name));
  return rows.map((r) => r.tag);
}

export async function setSnippetEntryTags(
  snippetId: string,
  tagIds: string[],
  options: EntityTagWriteOptions = {},
): Promise<void> {
  const writeContext = options.writeContext ?? createCanonicalWriteContext();
  await invoke("entity_tags_set", {
    payload: {
      projectId: options.projectId ?? getCurrentProjectId(),
      ...writeContext,
      entityKind: "snippet",
      entityId: snippetId,
      tagIds,
      updatedAt: null,
    },
  });
}

export async function setEntryTags(
  entryId: string,
  tagIds: string[],
  options: EntityTagWriteOptions = {},
): Promise<void> {
  const writeContext = options.writeContext ?? createCanonicalWriteContext();
  await invoke("entity_tags_set", {
    payload: {
      projectId: options.projectId ?? getCurrentProjectId(),
      ...writeContext,
      entityKind: "codex",
      entityId: entryId,
      tagIds,
      updatedAt: new Date().toISOString(),
    },
  });
}
