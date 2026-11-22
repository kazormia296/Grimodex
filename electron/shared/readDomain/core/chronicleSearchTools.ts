import type { CoreChronicleSearchContext } from "../../mastraRead/ports.js";
import { hiddenEventIds } from "./chronicleTools.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * `search_events` of the shared core (Mastra migration MP-4b, PR-7b, DR-MP4-38):
 * the dense search of the events index, then the chronicle's secrecy rule
 * applied to what it found. The order of the awaits, the point at which the tree
 * state is read, the strings and the key order of the result are those of the
 * renderer's executor it was moved from (the PR-0 golden and
 * `toolExecutors.searchEventsCharacterization.test.ts` fix them).
 *
 * The flow, in the renderer's order (query first: the reverse of the four
 * chronicle tools, which check the project first):
 *
 *   1. an empty query answers `0 events found` and reads nothing;
 *   2. the project is taken once (`requireCoreProjectId`), before any read;
 *   3. the dense read, with `limit` raised to `fetchLimit` (the hidden hits are
 *      dropped afterwards, so more than `limit` are asked for);
 *   4. the events, then the scene-event bridges;
 *   5. the tree state, read once and synchronously after the awaits (the nodes
 *      and the active scene are the ones of that moment, not of the start);
 *   6. the hits whose event is hidden are dropped, then the first `limit` stay.
 *
 * What the tool may show is the chronicle's own rule (`hiddenEventIds`). The
 * index holds every event, a secret one's title included, so this drop is the
 * only exit-side defence (DR-MP4-38). A hit whose id is not among the project's
 * events is NOT dropped (moved as it is, DR-MP4-38): the safety of that rests on
 * the index being read by project (Native's `WHERE project_id = ?`) and on the
 * events the caller hands in being current when the call is made.
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

/** What the dense read is asked for: three times `limit` (hidden hits are dropped afterwards), at most 30 (the backend's maximum). */
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

  // 現在シーン文脈で hidden な event id 集合を算出（spec §2.5）。
  const allEvents = await ctx.chronicle.getEvents(projectId);
  const sceneEvents = await ctx.chronicle.getSceneEvents(projectId);
  // The state is read once, synchronously, after the awaits (the renderer read
  // the nodes and the active scene at this point too). The nodes array goes to
  // the reading-order port as it is and the answer is copied.
  const state = ctx.getTreeState();
  const readingOrder = new Map(ctx.chronicle.getReadingOrder(state.nodes));
  const currentSceneId = state.activeSceneId ?? "";
  const hidden = hiddenEventIds(allEvents, currentSceneId, {
    readingOrder,
    sceneEvents,
  });

  const content = hits
    .filter((h) => !hidden.has(h.eventId))
    .slice(0, limit)
    .map((h) => ({
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
