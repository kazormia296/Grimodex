import { and, eq } from "drizzle-orm";

import type { CoreCodexEntryContext } from "../../mastraRead/ports.js";
import {
  codexDetailDefinitions,
  codexDetailValues,
  codexEntries,
  type CodexDetailDefinition,
  type CodexDetailValue,
} from "../db/schema.js";
import type { CodexTextForAi } from "../features/codex/context/codexAiVisibility.js";
import {
  dropHiddenCodexRows,
  resolveCodexAiVisibilityWithDetails,
} from "./codexVisibility.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

type CodexEntryIdentity = Pick<
  typeof codexEntries.$inferSelect,
  "id" | "name" | "type" | "aliases"
>;
type CodexEntryDefinition = Pick<
  CodexDetailDefinition,
  "id" | "name" | "includeInContext"
>;
type CodexEntryValue = Pick<CodexDetailValue, "definitionId" | "value">;
type CodexEntryChild = Pick<
  typeof codexEntries.$inferSelect,
  "id" | "name" | "type" | "summary"
>;

function entryNotFound(): CoreToolResult {
  return {
    name: "get_codex_entry",
    content: null,
    summary: "Entry not found",
    tokensUsed: 0,
  };
}

/** legacy と同じ key 順・文字列で、可視性判定を通った値だけを組み立てる。 */
export function assembleCodexEntry(
  entry: CodexEntryIdentity,
  text: CodexTextForAi | undefined,
  definitions: readonly CodexEntryDefinition[],
  values: readonly CodexEntryValue[],
  children: readonly CodexEntryChild[],
  ctx: Pick<CoreCodexEntryContext, "countTokens" | "extractPlainText">,
): CoreToolResult {
  if (!text) return entryNotFound();
  if (text.released && !text.detailValues) {
    throw new Error("released Codex entry is missing resolved detail values");
  }

  const details = definitions
    .filter((definition) => definition.includeInContext)
    .map((definition) => {
      if (text.released) {
        return {
          field: definition.name,
          value: text.detailValues!.get(definition.id) ?? null,
        };
      }
      const value = values.find(
        (candidate) => candidate.definitionId === definition.id,
      );
      return { field: definition.name, value: value?.value ?? null };
    });
  const result = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases ? (JSON.parse(entry.aliases) as string[]) : [],
    summary: text.summary ?? "",
    body: text.content ? ctx.extractPlainText(text.content) : "",
    details,
    children: children.map((child) => ({
      id: child.id,
      name: child.name,
      type: child.type,
      summary: child.summary ?? "",
    })),
  };
  const json = JSON.stringify(result);
  return {
    name: "get_codex_entry",
    content: result,
    summary: `${entry.name} (${entry.type})`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function getCodexEntry(
  ctx: CoreCodexEntryContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const id = String(params["id"] ?? "").trim();
  if (!id) {
    return {
      name: "get_codex_entry",
      content: null,
      summary: "No id provided",
      tokensUsed: 0,
    };
  }

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();
  const [entry] = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  if (!entry) return entryNotFound();

  const { texts } = await resolveCodexAiVisibilityWithDetails(ctx, {
    entryIds: [id],
    projectId,
    sceneId: ctx.getTreeState().activeSceneId,
    withContent: true,
  });
  const text = texts.get(id);
  if (!text) return entryNotFound();

  const definitions = await db
    .select()
    .from(codexDetailDefinitions)
    .where(
      and(
        eq(codexDetailDefinitions.projectId, projectId),
        eq(codexDetailDefinitions.typeSlug, entry.type),
      ),
    );
  const values = await db
    .select()
    .from(codexDetailValues)
    .where(eq(codexDetailValues.entryId, id));
  const childRows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .where(eq(codexEntries.parentId, id));
  const children = await dropHiddenCodexRows(ctx, childRows, {
    projectId,
    sceneId: ctx.getTreeState().activeSceneId,
  });

  return assembleCodexEntry(
    {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      aliases: entry.aliases,
    },
    text,
    definitions,
    values,
    children,
    ctx,
  );
}
