import { like, or, type AnyColumn, type SQL } from "drizzle-orm";

import { prosemirrorToText } from "../lib/prosemirror.js";

/**
 * The helpers the search tools of the shared core use (Mastra migration MP-4b,
 * PR-5a). They were the renderer's private helpers in `toolExecutors.ts`; the
 * bodies and the strings they make are unchanged (the PR-0 golden fixes them).
 *
 * `buildLikeOrCondition`, `orderByIds` and `parseTagsCacheNames` are shared
 * with the Codex tools (PR-8b moved four of them to the core; the renderer's
 * `get_codex_entry` stays), so the renderer imports what it still uses from
 * here instead of keeping a copy (DR-MP4-32a). `plainTextExcerpt` and `EXCERPT_MAX_CHARS` are used by the two
 * search tools only and are not exported to the renderer.
 */

/**
 * The `tags_cache` JSON of a row as the list of tag names. The stored form is
 * `[{"name":"tag1","color":null}, ...]`, but a record in the older
 * `["tag1", "tag2"]` form can exist, so both are accepted. A value that does
 * not parse, or is not an array, gives no tags.
 */
export function parseTagsCacheNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((v): string | undefined => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "name" in v) {
          const name = (v as { name: unknown }).name;
          return typeof name === "string" ? name : undefined;
        }
        return undefined;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

export const EXCERPT_MAX_CHARS = 200;

/**
 * A plain-text excerpt of a ProseMirror JSON body. `tree_nodes.content` and
 * `snippets.content` are raw JSON, so cutting them in SQL would hand the
 * structure itself to the model (`get_scene` converts to text the same way).
 * The cut is centred on the first search token that is found, a side that was
 * cut gets "...", and a body with none of the tokens gives its head.
 */
export function plainTextExcerpt(content: unknown, tokens: string[]): string {
  const raw = typeof content === "string" ? content : "";
  if (!raw) return "";
  const plain = prosemirrorToText(raw).replace(/\s+/g, " ").trim();
  if (plain.length <= EXCERPT_MAX_CHARS) return plain;
  let hit = -1;
  for (const t of tokens) {
    const idx = plain.indexOf(t);
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }
  const start =
    hit < 0 ? 0 : Math.max(0, hit - Math.floor(EXCERPT_MAX_CHARS / 2));
  const end = Math.min(plain.length, start + EXCERPT_MAX_CHARS);
  return (
    (start > 0 ? "..." : "") +
    plain.slice(start, end) +
    (end < plain.length ? "..." : "")
  );
}

/**
 * `(col1 LIKE ? OR col2 LIKE ? OR ...) OR (col1 LIKE ? OR ...) OR ...` over the
 * tokens and the columns. It is the fallback when a token is too short for the
 * trigram index.
 */
export function buildLikeOrCondition(
  tokens: string[],
  columns: AnyColumn[],
): SQL {
  const condition = or(
    ...tokens.flatMap((token) =>
      columns.map((column) => like(column, `%${token}%`)),
    ),
  );
  if (!condition) {
    throw new Error("search requires at least one token and column");
  }
  return condition;
}

/** The rows in the order of `ids`; an id with no row is left out. */
export function orderByIds<T extends { id: string }>(
  rows: T[],
  ids: string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * The ids of `fts_search`'s hits of one source type, in Native's order.
 *
 * What Native returns is parsed and not narrowed (`CoreNativeReads`), and it is
 * the core that decides what a malformed answer is. It fails closed: a result
 * that is not an array, or a row that is not an object with a string `id` and a
 * string `sourceType`, throws. Dropping such a row would turn a wire that
 * changed shape into "0 found", a success the model would believe. A row of
 * another source type is dropped (the in-browser mock answers every scope in one
 * list); a hidden entry is not Native's to drop (its `codex` scope returns it),
 * and nor is an archived scene in the `scenes` and `all` scopes: the tool does
 * that with its own condition. Only the `scenes_live` scope leaves archived
 * scenes out, and `search_scenes` still keeps its own condition (DR-ARC-1).
 */
export function ftsHitIds(
  raw: unknown,
  sourceType: "scene" | "snippet" | "codex",
): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("fts_search: the result is not an array");
  }
  const ids: string[] = [];
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new Error("fts_search: a row is not an object");
    }
    const { id, sourceType: type } = row as {
      id?: unknown;
      sourceType?: unknown;
    };
    if (typeof id !== "string" || typeof type !== "string") {
      throw new Error("fts_search: a row has no string id and sourceType");
    }
    if (type === sourceType) ids.push(id);
  }
  return ids;
}
