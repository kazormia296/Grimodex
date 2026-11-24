import type { CoreChronicleSearchContext } from "../../mastraRead/ports.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * `search_events` of the shared core (Mastra migration MP-4b, PR-7b, DR-MP4-38):
 * a dense search of all chronicle events. Event secrecy does not exclude a hit.
 * The query, project, dense read and token-count order, strings and result key
 * order are fixed by the renderer's executor it was moved from (the PR-0 golden
 * and `toolExecutors.searchEventsCharacterization.test.ts` fix them).
 *
 * The flow (query first: the reverse of the four chronicle tools, which check
 * the project first):
 *
 *   1. an empty query answers `0 events found` and reads nothing;
 *   2. the project is taken once (`requireCoreProjectId`);
 *   3. the dense read, with `limit` raised to `fetchLimit`;
 *   4. the dense hits are narrowed and the first `limit` are returned.
 *   5. the JSON result is counted by `countTokens`.
 *
 * Every event is eligible for search, including events marked secret. Hits are
 * not checked against the events table; the native dense read is scoped to the
 * project.
 *
 * A failure of the dense read is not caught here: the renderer's port answers an
 * empty list (`chronicleSearchPort.ts`) and Main's lets it out.
 */

/** What `search_events` gives the model for one hit. */
export interface ChronicleSearchHit {
  readonly eventId: string;
  readonly title: string;
  readonly kind: string;
  /** Native's `f32` becomes `null` on the wire when it is not finite. */
  readonly score: number | null;
}

/** The model's `limit`: a finite number above 0, floored, at most 30; anything else is 10. */
export function eventSearchLimit(params: Record<string, unknown>): number {
  const rawLimit = Number(params["limit"]);
  return Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), 30)
    : 10;
}

/** What the dense read is asked for: three times `limit`, at most 30 (the backend's maximum). */
export function eventSearchFetchLimit(limit: number): number {
  return Math.min(limit * 3, 30);
}

/**
 * The wire of the dense read, narrowed (fail closed). Not an array, a row that
 * is not an object, or a row whose `eventId`, `title` or `kind` is not a string
 * throws; `score` is a number or `null`. An extra key is dropped (the result
 * carries four keys only).
 */
function narrowEventHits(raw: unknown): ChronicleSearchHit[] {
  if (!Array.isArray(raw)) {
    throw new Error("events_semantic_search: the result is not an array");
  }
  const hits: ChronicleSearchHit[] = [];
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) {
      throw new Error("events_semantic_search: a row is not an object");
    }
    const { eventId, title, kind, score } = row as {
      eventId?: unknown;
      title?: unknown;
      kind?: unknown;
      score?: unknown;
    };
    if (
      typeof eventId !== "string" ||
      typeof title !== "string" ||
      typeof kind !== "string"
    ) {
      throw new Error(
        "events_semantic_search: a row has no string eventId, title and kind",
      );
    }
    if (score !== null && typeof score !== "number") {
      throw new Error(
        "events_semantic_search: a row's score is neither a number nor null",
      );
    }
    hits.push({ eventId, title, kind, score });
  }
  return hits;
}

/**
 * 作中年表 (Chronicle) 出来事の dense セマンティック検索。`limit` は model の値（既定 10・最大 30）。
 */
export async function searchEvents(
  ctx: CoreChronicleSearchContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const query = String(params["query"] ?? "").trim();
  if (!query)
    return {
      name: "search_events",
      content: [],
      summary: "0 events found",
      tokensUsed: 0,
    };

  const projectId = requireCoreProjectId(ctx);
  const limit = eventSearchLimit(params);
  const hits = narrowEventHits(
    await ctx.native.eventsSemantic({
      projectId,
      query,
      limit: eventSearchFetchLimit(limit),
    }),
  );

  const content = hits.slice(0, limit).map((h) => ({
    eventId: h.eventId,
    title: h.title,
    kind: h.kind,
    score: h.score,
  }));
  return {
    name: "search_events",
    content,
    summary: `${content.length} events found`,
    tokensUsed: ctx.countTokens(JSON.stringify(content)),
  };
}
