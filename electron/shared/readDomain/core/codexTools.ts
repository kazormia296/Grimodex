import { and, eq, inArray, ne } from "drizzle-orm";

import type { CoreCodexReadContext } from "../../mastraRead/ports.js";
import { codexEntries, codexEntryTags, codexTags } from "../db/schema.js";
import {
  fuseCodexHybrid,
  type CodexDenseHit,
  type CodexHybridResult,
} from "../features/chat/agent/codexHybridSearch.js";
import { codepointLength, tokenizeFtsQuery } from "../lib/fts.js";
import {
  dropHiddenCodexRows,
  resolveCodexAiVisibility,
} from "./codexVisibility.js";
import { requireCoreProjectId } from "./readContext.js";
import {
  buildLikeOrCondition,
  ftsHitIds,
  orderByIds,
  parseTagsCacheNames,
} from "./searchHelpers.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The four Codex read tools that pass through the author's hidden marking, in the shared core
 * (Mastra migration MP-4b PR-8b, DR-MP4-40): `search_codex`, `list_codex_by_type`,
 * `search_codex_by_tags` and `find_related_entries`. The SQL, the order of the statements, the strings and
 * the key order of every result are those of the renderer's executors they were moved from (the PR-0
 * golden and `toolExecutors.codexCharacterization.test.ts` fix them).
 *
 * Each tool checks its arguments first (an empty query, tag list or id is answered before the project is
 * looked at; `list_codex_by_type` checks none), then takes the project once (`requireCoreProjectId`) before
 * its first `await`, then reads. What the AI may see is decided by `dropHiddenCodexRows` /
 * `resolveCodexAiVisibility` (the one pure decision the renderer shares), over the rows the tool made:
 * after the results are built (after the dense read, for `search_codex`), and the current scene is read in
 * that same synchronous stretch, as the renderer does (the scene can change during an `await`).
 *
 * Nothing is cached: every call reads the entries and the phases again (DR-MP4-40; the author may turn an
 * entry hidden in the middle of a turn). The renderer's thin layer turns the empty-project throw back into
 * its `No active project` result.
 */

/** The most entries `search_codex` returns, and what it asks `fts` for. */
const SEARCH_CODEX_LIMIT = 20;
/** What `search_codex` asks the dense read for. */
const SEARCH_CODEX_DENSE_LIMIT = 30;
/** The most related entries `find_related_entries` returns. */
const RELATED_LIMIT = 20;

/**
 * The dense read's answer as the fusion takes it. Narrowed fail closed, like `ftsHitIds`: a result that is
 * not an array, or a row that is not an object with a string `entryId` and a `score` that is a number or
 * `null`, throws. `null` is what a NaN `f32` becomes on the wire; it is read as 0, as the fusion read it
 * (`null` in its arithmetic and `?? 0`). `entryName`, `entryType` and `summary` are Rust `String`s that
 * serde always writes, and are passed on as they are (the renderer passed them unchecked).
 */
export function narrowCodexDenseHits(raw: unknown): CodexDenseHit[] {
  if (!Array.isArray(raw)) {
    throw new Error("codex_semantic_search: the result is not an array");
  }
  const hits: CodexDenseHit[] = [];
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new Error("codex_semantic_search: a row is not an object");
    }
    const hit = row as {
      entryId?: unknown;
      entryName?: unknown;
      entryType?: unknown;
      summary?: unknown;
      score?: unknown;
    };
    if (typeof hit.entryId !== "string") {
      throw new Error("codex_semantic_search: a row has no string entryId");
    }
    if (hit.score !== null && typeof hit.score !== "number") {
      throw new Error(
        "codex_semantic_search: a row's score is not a number or null",
      );
    }
    hits.push({
      entryId: hit.entryId,
      entryName: hit.entryName as string,
      entryType: hit.entryType as string,
      summary: hit.summary as string,
      score: hit.score ?? 0,
    });
  }
  return hits;
}

export async function searchCodex(
  ctx: CoreCodexReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_codex",
      content: [],
      summary: "0 entries found",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  // `codex_fts` is a trigram index, so a token shorter than three code points cannot match in it. One short
  // token anywhere sends the whole query to the LIKE-OR fallback. A Japanese word of two or three characters
  // makes that route the main one in practice.
  const tokens = tokenizeFtsQuery(query);
  const allTrigramFriendly =
    tokens.length > 0 && tokens.every((t) => codepointLength(t) >= 3);

  let rows: Array<{
    id: string;
    name: string;
    type: string;
    summary: string | null;
  }>;
  if (allTrigramFriendly) {
    // Native's fts answers hidden entries too, and the tool drops them after the cut (below). A hit that is
    // hidden takes one of the 20 places, so fewer than 20 can come back, as the renderer's did.
    const hitIds = ftsHitIds(
      await ctx.native.fts({
        projectId,
        query,
        scope: "codex",
        limit: SEARCH_CODEX_LIMIT,
      }),
      "codex",
    );
    if (hitIds.length === 0) {
      rows = [];
    } else {
      rows = orderByIds(
        await db
          .select({
            id: codexEntries.id,
            name: codexEntries.name,
            type: codexEntries.type,
            summary: codexEntries.summary,
          })
          .from(codexEntries)
          .where(
            and(
              eq(codexEntries.projectId, projectId),
              inArray(codexEntries.id, hitIds),
            ),
          ),
        hitIds,
      );
    }
  } else {
    // `content` (the ProseMirror body) is matched too, so a short (1-2 code point) token, the LIKE-fallback
    // case and common in Japanese, can hit body text and not only metadata. The FTS route covers content
    // through `codex_fts`.
    rows = await db
      .select({
        id: codexEntries.id,
        name: codexEntries.name,
        type: codexEntries.type,
        summary: codexEntries.summary,
      })
      .from(codexEntries)
      .where(
        and(
          eq(codexEntries.projectId, projectId),
          buildLikeOrCondition(tokens.length > 0 ? tokens : [query], [
            codexEntries.name,
            codexEntries.summary,
            codexEntries.tagsCache,
            codexEntries.aliases,
            codexEntries.content,
          ]),
        ),
      )
      .limit(SEARCH_CODEX_LIMIT);
  }

  const sparse: CodexHybridResult[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    summary: r.summary ?? "",
  }));

  // The dense arm: a semantic read fused with the sparse rows by rank (RRF). A caller that wants a missing
  // model to read as "sparse only" answers an empty list from its own port; the core does not catch it. The
  // wire is narrowed here, outside any such catch.
  const dense = narrowCodexDenseHits(
    await ctx.native.codexSemantic({
      projectId,
      query,
      limit: SEARCH_CODEX_DENSE_LIMIT,
    }),
  );

  // Hidden entries are dropped from both arms after the fusion and the cut (a dense hit does not go through
  // the database and carries a name and summary, so it is judged by id). The summary after phase
  // resolution can be null, so it is put back to the empty string.
  const content = (
    await dropHiddenCodexRows(
      ctx,
      dense.length > 0
        ? fuseCodexHybrid(dense, sparse, SEARCH_CODEX_LIMIT)
        : sparse,
      { projectId, sceneId: ctx.getTreeState().activeSceneId },
    )
  ).map((row) => ({ ...row, summary: row.summary ?? "" }));
  const json = JSON.stringify(content);
  return {
    name: "search_codex",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function listCodexByType(
  ctx: CoreCodexReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  // `type` is not checked: a missing one is the empty string.
  const type = String(params["type"] ?? "").trim();
  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();
  const rows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      summary: codexEntries.summary,
      tagsCache: codexEntries.tagsCache,
    })
    .from(codexEntries)
    .where(
      and(eq(codexEntries.projectId, projectId), eq(codexEntries.type, type)),
    );

  const content = (
    await dropHiddenCodexRows(ctx, rows, {
      projectId,
      sceneId: ctx.getTreeState().activeSceneId,
    })
  ).map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary ?? "",
    tags: parseTagsCacheNames(r.tagsCache),
  }));
  const json = JSON.stringify(content);
  return {
    name: "list_codex_by_type",
    content,
    summary: `${content.length} entries of type '${type}'`,
    tokensUsed: ctx.countTokens(json),
  };
}

export async function searchCodexByTags(
  ctx: CoreCodexReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const tags = Array.isArray(params["tags"])
    ? (params["tags"] as unknown[]).map(String)
    : [];
  if (tags.length === 0)
    return {
      name: "search_codex_by_tags",
      content: [],
      summary: "No tags provided",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const rows = await db
    .selectDistinct({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .innerJoin(codexEntryTags, eq(codexEntries.id, codexEntryTags.entryId))
    .innerJoin(codexTags, eq(codexEntryTags.tagId, codexTags.id))
    .where(
      and(eq(codexEntries.projectId, projectId), inArray(codexTags.name, tags)),
    );

  const content = (
    await dropHiddenCodexRows(ctx, rows, {
      projectId,
      sceneId: ctx.getTreeState().activeSceneId,
    })
  ).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "search_codex_by_tags",
    content,
    summary: `${content.length} entries found`,
    tokensUsed: ctx.countTokens(json),
  };
}

/**
 * LIKE-OR the other entries' name / summary / aliases / tags_cache with the source entry's name and aliases:
 * a relation finder for "what relates to X". Can be narrowed by type.
 */
export async function findRelatedEntries(
  ctx: CoreCodexReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const id = String(params["id"] ?? "").trim();
  if (!id)
    return {
      name: "find_related_entries",
      content: [],
      summary: "No id provided",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const db = ctx.getDb();

  const [source] = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  // A source that is hidden gets the same answer as an id that does not exist (its existence is not told).
  // `!source` short-circuits: with no source entry, neither the scene nor the decision's statements are read.
  if (
    !source ||
    (
      await resolveCodexAiVisibility(ctx, {
        projectId,
        entryIds: [id],
        sceneId: ctx.getTreeState().activeSceneId,
        withContent: true,
      })
    ).hidden.has(id)
  )
    return {
      name: "find_related_entries",
      content: [],
      summary: "Entry not found",
      tokensUsed: 0,
    };

  // The source entry's name and aliases are the search terms.
  const aliasArr = source.aliases
    ? (() => {
        try {
          const parsed = JSON.parse(source.aliases as string);
          return Array.isArray(parsed)
            ? parsed.filter((s): s is string => typeof s === "string")
            : [];
        } catch {
          return [];
        }
      })()
    : [];
  const terms = [source.name, ...aliasArr].filter(
    (t) => typeof t === "string" && t.trim().length > 0,
  );
  if (terms.length === 0)
    return {
      name: "find_related_entries",
      content: [],
      summary: "Source entry has no searchable name",
      tokensUsed: 0,
    };

  const typeFilter = params["type"] ? String(params["type"]).trim() : undefined;

  const rows = await db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      summary: codexEntries.summary,
    })
    .from(codexEntries)
    .where(
      and(
        eq(codexEntries.projectId, projectId),
        ne(codexEntries.id, id),
        buildLikeOrCondition(terms, [
          codexEntries.name,
          codexEntries.summary,
          codexEntries.aliases,
          codexEntries.tagsCache,
        ]),
        typeFilter ? eq(codexEntries.type, typeFilter) : undefined,
      ),
    )
    .limit(RELATED_LIMIT);

  const content = (
    await dropHiddenCodexRows(ctx, rows, {
      projectId,
      sceneId: ctx.getTreeState().activeSceneId,
    })
  ).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    summary: row.summary ?? "",
  }));
  const json = JSON.stringify(content);
  return {
    name: "find_related_entries",
    content,
    summary: `${content.length} related to ${source.name}${typeFilter ? ` (type=${typeFilter})` : ""}`,
    tokensUsed: ctx.countTokens(json),
  };
}
