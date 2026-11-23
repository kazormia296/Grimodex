import { and, eq, inArray, isNull } from "drizzle-orm";

import type { CoreReadContext } from "../../mastraRead/ports.js";
import { snippets, treeNodes } from "../db/schema.js";
import { codepointLength, tokenizeFtsQuery } from "../lib/fts.js";
import { requireCoreProjectId } from "./readContext.js";
import {
  buildLikeOrCondition,
  ftsHitIds,
  orderByIds,
  parseTagsCacheNames,
  plainTextExcerpt,
} from "./searchHelpers.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The scene and snippet search tools of the shared core (Mastra migration
 * MP-4b, PR-5a): `search_scenes` and `search_snippets`. The SQL, the order of
 * the statements, the strings and the key order of every result are those of
 * the renderer's executors they were moved from (the PR-0 golden fixes them).
 *
 * Each tool checks its query first (an empty one is answered before the project
 * is looked at), then takes the project once (`requireCoreProjectId`), then
 * reads. A query whose tokens are all at least three code points long goes to
 * the full-text read (`native.fts`) and is then fetched by id; any shorter token
 * sends the whole query to a LIKE-OR over the columns (the trigram index cannot
 * match it). The renderer's thin layer turns the empty-project throw back into
 * its `No active project` result.
 */

/**
 * The most scenes `search_scenes` returns, and what it asks `fts` for: Native's
 * `scenes_live` scope leaves the archived scenes out in its own WHERE (before
 * its limit), so the top ten it answers are already live ones.
 */
const SEARCH_SCENES_LIMIT = 10;
/** What `search_snippets` asks `fts` for, and the most it returns. */
const SEARCH_SNIPPETS_LIMIT = 10;

export async function searchScenes(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_scenes",
      content: [],
      summary: "0 scenes found",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  // `tree_nodes_fts` is a trigram index: a short token falls back to LIKE-OR.
  const tokens = tokenizeFtsQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{ id: string; title: string; content: string }>;
  if (allTrigramFriendly) {
    // Native's `scenes_live` scope already leaves archived scenes out. The
    // condition stays in the statement below as well: the in-browser mock's
    // `fts` answers every scope in one list and drops nothing, the LIKE-OR arm
    // does not go through `fts`, and a scene archived between the two reads
    // must not come back. The rows are put back in the fts order, then cut.
    const hitIds = ftsHitIds(
      await ctx.native.fts({
        projectId,
        query,
        scope: "scenes_live",
        limit: SEARCH_SCENES_LIMIT,
      }),
      "scene",
    );
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: treeNodes.id,
            title: treeNodes.title,
            content: treeNodes.content,
          })
          .from(treeNodes)
          .where(
            and(
              eq(treeNodes.projectId, projectId),
              eq(treeNodes.nodeType, "scene"),
              isNull(treeNodes.archivedAt),
              inArray(treeNodes.id, hitIds),
            ),
          ),
        hitIds,
      ).slice(0, SEARCH_SCENES_LIMIT);
    }
  } else {
    rows = await db
      .select({
        id: treeNodes.id,
        title: treeNodes.title,
        content: treeNodes.content,
      })
      .from(treeNodes)
      .where(
        and(
          eq(treeNodes.projectId, projectId),
          eq(treeNodes.nodeType, "scene"),
          isNull(treeNodes.archivedAt),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            treeNodes.title,
            treeNodes.content,
          ]),
        ),
      )
      .limit(SEARCH_SCENES_LIMIT);
  }

  const content = rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: plainTextExcerpt(row.content, tokens),
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_scenes",
    content,
    summary: `${content.length} scenes found`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function searchSnippets(
  ctx: CoreReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_snippets",
      content: [],
      summary: "0 snippets found",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  // `snippets_fts` is a trigram index: a short token falls back to LIKE-OR.
  const tokens = tokenizeFtsQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{
    id: string;
    title: string;
    tagsCache: string | null;
    content: string;
  }>;
  if (allTrigramFriendly) {
    const hitIds = ftsHitIds(
      await ctx.native.fts({
        projectId,
        query,
        scope: "snippets",
        limit: SEARCH_SNIPPETS_LIMIT,
      }),
      "snippet",
    );
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: snippets.id,
            title: snippets.title,
            tagsCache: snippets.tagsCache,
            content: snippets.content,
          })
          .from(snippets)
          .where(
            and(
              eq(snippets.projectId, projectId),
              inArray(snippets.id, hitIds),
            ),
          ),
        hitIds,
      );
    }
  } else {
    rows = await db
      .select({
        id: snippets.id,
        title: snippets.title,
        tagsCache: snippets.tagsCache,
        content: snippets.content,
      })
      .from(snippets)
      .where(
        and(
          eq(snippets.projectId, projectId),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            snippets.title,
            snippets.content,
            snippets.tagsCache,
          ]),
        ),
      )
      .limit(SEARCH_SNIPPETS_LIMIT);
  }

  const content = rows.map((row) => ({
    id: row.id,
    title: row.title,
    tags: parseTagsCacheNames(row.tagsCache),
    preview: plainTextExcerpt(row.content, tokens),
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_snippets",
    content,
    summary: `${content.length} snippets found`,
    tokensUsed: ctx.countTokens(json),
  };
}
