import { and, count, desc, eq, isNull, like, or } from "drizzle-orm";

import type { CoreReadContext } from "../../mastraRead/ports.js";
import { codexEntryTags, codexTags } from "../db/schema.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/** The codex tag read tool of the shared core (Mastra migration MP-4b, PR-4). */

export async function listCodexTags(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const typeFilter = params["type"] ? String(params["type"]) : undefined;

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const usageCount = count(codexEntryTags.entryId);
  const rows = await db
    .select({
      id: codexTags.id,
      name: codexTags.name,
      usageCount,
    })
    .from(codexTags)
    .leftJoin(codexEntryTags, eq(codexTags.id, codexEntryTags.tagId))
    .where(
      and(
        eq(codexTags.projectId, projectId),
        typeFilter
          ? or(
              isNull(codexTags.typeFilter),
              like(codexTags.typeFilter, `%${typeFilter}%`),
            )
          : undefined,
      ),
    )
    .groupBy(codexTags.id)
    .orderBy(desc(usageCount));

  const content = rows.map((row) => ({
    id: row.id,
    name: row.name,
    usageCount: row.usageCount,
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_codex_tags",
    content,
    summary: `${content.length} tags`,
    tokensUsed: ctx.countTokens(json),
  };
}
