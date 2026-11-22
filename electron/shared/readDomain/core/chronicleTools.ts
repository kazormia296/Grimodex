import type {
  CoreChronicleReadContext,
  CoreTreeNode,
} from "../../mastraRead/ports.js";
import type { EventPrecision } from "../db/schema.js";
import type { EventRow } from "../features/chronicle/eventRows.js";
import {
  isEventHiddenFromAi,
  projectVisibleChronicle,
} from "../features/chronicle/chronicleSecrecy.js";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
} from "../features/chronicle/chronicleSnapshot.js";
import {
  calendarFromRow,
  formatChronicleDate,
  type ChronicleCalendar,
  type DateLang,
} from "../features/chronicle/chronicleTime.js";
import {
  resolveSceneAnchor,
  type SceneChronicle,
} from "../features/chronicle/resolveSceneAnchor.js";
import { cmpKeys } from "../features/tree/fractionalIndex.js";
import { requireCoreProjectId } from "./readContext.js";
import type { CoreToolResult } from "./toolResult.js";

/**
 * The chronicle tools of the shared core (Mastra migration MP-4b, PR-7a, group
 * B6): `list_events`, `get_event_detail`, `get_character_timeline` and
 * `get_chronicle_state`. The order of the awaits, the point at which each tool
 * reads the tree state, the strings and the key order of every result are those
 * of the renderer's executors they were moved from (the PR-0 golden and
 * `toolExecutors.chronicleCharacterization.test.ts` fix them).
 *
 * Every tool checks the project first (`requireCoreProjectId`, before it
 * reads anything) and its arguments after it: the renderer answered `No active
 * project` before `eventId is required`, and the order is kept. That is the
 * reverse of the foreshadow and search tools (DR-MP4-32c) and is recorded in
 * DR-MP4-37. The renderer's thin layer turns the empty-project throw back into
 * its `No active project` result.
 *
 * What the tools may show is the chronicle's own secrecy rule
 * (`isEventHiddenFromAi`: a `secret` event is hidden until the reading
 * position reaches its reveal scene, and a position that is not in the reading
 * order hides it). Codex names are not filtered: a hidden Codex entry's name is
 * returned as it is, in `primaryCharacter`, `location`, `participants`,
 * `character` and the snapshot (DR-MP4-37, an existing asymmetry that is moved
 * and not decided here). The model's `sceneId` of `get_chronicle_state` is also the
 * position of the secrecy check (moved as it is).
 */

/**
 * 出来事の day 番号を暦整形した文字列（pull ツールの絶対日付）。暦なし・粒度 none・
 * 日付欠落は null。push（相対時間）と違い pull はトークン圧が低いので粒度フルで出す。
 */
function fmtEventDate(
  cal: ChronicleCalendar | null,
  day: number | null,
  minute: number | null,
  granularity: string,
  lang: DateLang,
): string | null {
  if (!cal) return null;
  return formatChronicleDate(day, minute, granularity, cal, lang) || null;
}

function result(
  ctx: CoreChronicleReadContext,
  name: string,
  content: unknown,
  summary: string,
): CoreToolResult {
  return {
    name,
    content,
    summary,
    tokensUsed: ctx.countTokens(JSON.stringify(content)),
  };
}

/**
 * AI 秘匿: 現在シーン文脈で「可視」イベント id 集合を算出（spec §2.5）。
 * read ツールには chat の scene 文脈が無いため activeSceneId を現在シーンとする
 * （get_chronicle_state と同じ fallback）。activeSceneId 空 → 現在位置不明として
 * isEventHiddenFromAi 側で fail-closed（secret=true を一律隠す）。
 *
 * The tree state (the nodes, hence the reading order, and the active scene) is
 * read before the scene-event bridges are awaited, in one synchronous step, as
 * the renderer did. The nodes array goes to the reading-order port as it is (the
 * renderer memoizes by its reference) and the answer is copied.
 */
async function visibleEventIds(
  ctx: CoreChronicleReadContext,
  projectId: string,
  events: EventRow[],
): Promise<Set<string>> {
  const state = ctx.getTreeState();
  const readingOrder = new Map(ctx.chronicle.getReadingOrder(state.nodes));
  const currentSceneId = state.activeSceneId ?? "";
  const sceneEvents = await ctx.chronicle.getSceneEvents(projectId);
  return new Set(
    events
      .filter(
        (e) =>
          !isEventHiddenFromAi(e, currentSceneId, {
            readingOrder,
            sceneEvents,
          }),
      )
      .map((e) => e.id),
  );
}

/** 作中順イベント一覧（kind フィルタ可）。XPROJ=events の reader が project gate。 */
export async function listEvents(
  ctx: CoreChronicleReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const kind = String(params["kind"] ?? "").trim();
  const events = await ctx.chronicle.getEvents(projectId);
  const names = await ctx.chronicle.getCodexNames(projectId);
  const calendarRow = await ctx.chronicle.getCalendar(projectId);
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  const lang: DateLang = ctx.getUiLanguage();
  // AI 秘匿: 現在シーンで hidden な secret イベントを除外。
  const visible = await visibleEventIds(ctx, projectId, events);
  const shown = events.filter((e) => visible.has(e.id));
  const filtered =
    kind === "birth" || kind === "death" || kind === "generic"
      ? shown.filter((e) => e.kind === kind)
      : shown;
  const content = {
    events: filtered.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      ordinal: e.ordinal,
      startTime: e.startTime,
      startDate: fmtEventDate(
        calendar,
        e.startTime,
        e.startMinute,
        e.startGranularity,
        lang,
      ),
      primaryCharacter: e.primaryCodexId
        ? (names.get(e.primaryCodexId) ?? null)
        : null,
    })),
  };
  return result(ctx, "list_events", content, `${content.events.length} events`);
}

/** 単一イベント詳細（参加者/紐づきシーン/因果）。XPROJ=project の events に在ること。 */
export async function getEventDetail(
  ctx: CoreChronicleReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const eventId = String(params["eventId"] ?? "").trim();
  if (!eventId)
    return {
      name: "get_event_detail",
      content: null,
      summary: "eventId is required",
      tokensUsed: 0,
    };

  const events = await ctx.chronicle.getEvents(projectId);
  // AI 秘匿: hidden な event は「存在しない」扱い（generic not found・存在 oracle 化を防ぐ）。
  const visible = await visibleEventIds(ctx, projectId, events);
  const ev = events.find((e) => e.id === eventId);
  if (!ev || !visible.has(eventId))
    return {
      name: "get_event_detail",
      content: null,
      summary: "Event not found",
      tokensUsed: 0,
    };

  const [names, participants, allSceneEvents, allRelations, calendarRow] =
    await Promise.all([
      ctx.chronicle.getCodexNames(projectId),
      ctx.chronicle.listParticipants(projectId, [eventId]),
      ctx.chronicle.getSceneEvents(projectId),
      ctx.chronicle.listRelations(projectId),
      ctx.chronicle.getCalendar(projectId),
    ]);
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  const lang: DateLang = ctx.getUiLanguage();
  const sceneLinks = allSceneEvents.filter((s) => s.eventId === eventId);
  const titleByEvent = new Map(events.map((e) => [e.id, e.title] as const));
  const nodes = ctx.getTreeState().nodes;
  const titleByScene = new Map(nodes.map((n) => [n.id, n.title] as const));

  const content = {
    id: ev.id,
    title: ev.title,
    note: ev.note,
    kind: ev.kind,
    ordinal: ev.ordinal,
    startTime: ev.startTime,
    endTime: ev.endTime,
    startMinute: ev.startMinute,
    endMinute: ev.endMinute,
    startGranularity: ev.startGranularity,
    endGranularity: ev.endGranularity,
    // 暦整形済みの絶対日付（暦なし/粒度 none は null）。start/end 両端。
    startDate: fmtEventDate(
      calendar,
      ev.startTime,
      ev.startMinute,
      ev.startGranularity,
      lang,
    ),
    endDate: fmtEventDate(
      calendar,
      ev.endTime,
      ev.endMinute,
      ev.endGranularity,
      lang,
    ),
    precision: ev.precision,
    primaryCharacter: ev.primaryCodexId
      ? (names.get(ev.primaryCodexId) ?? null)
      : null,
    location: ev.locationCodexId
      ? (names.get(ev.locationCodexId) ?? null)
      : null,
    participants: participants.map((p) => ({
      codexId: p.codexEntryId,
      name: names.get(p.codexEntryId) ?? null,
      role: p.role,
    })),
    scenes: sceneLinks.map((s) => ({
      sceneId: s.sceneId,
      title: titleByScene.get(s.sceneId) ?? null,
    })),
    relations: allRelations
      .filter(
        (r) =>
          (r.causeId === eventId || r.effectId === eventId) &&
          visible.has(r.causeId) &&
          visible.has(r.effectId),
      )
      .map((r) => ({
        cause: titleByEvent.get(r.causeId) ?? null,
        effect: titleByEvent.get(r.effectId) ?? null,
      })),
  };
  return result(ctx, "get_event_detail", content, `Event '${ev.title}'`);
}

/** 人物の作中経歴（primary/participant で関与した出来事を作中順・各時点の年齢）。 */
export async function getCharacterTimeline(
  ctx: CoreChronicleReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  const codexId = String(params["codexId"] ?? "").trim();
  if (!codexId)
    return {
      name: "get_character_timeline",
      content: { events: [] },
      summary: "codexId is required",
      tokensUsed: 0,
    };

  const [events, participants, calendarRow, names] = await Promise.all([
    ctx.chronicle.getEvents(projectId),
    ctx.chronicle.listParticipants(projectId),
    ctx.chronicle.getCalendar(projectId),
    ctx.chronicle.getCodexNames(projectId),
  ]);
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  // AI 秘匿: hidden な secret イベントを除外（秘匿された生年・死亡・経歴の漏洩防止）。
  const visible = await visibleEventIds(ctx, projectId, events);
  const visibleEvents = events.filter((e) => visible.has(e.id));
  const participantEventIds = new Set(
    participants
      .filter((p) => p.codexEntryId === codexId)
      .map((p) => p.eventId),
  );
  const involved = visibleEvents
    .filter(
      (e) => e.primaryCodexId === codexId || participantEventIds.has(e.id),
    )
    .sort((a, b) => cmpKeys(a.ordinal, b.ordinal));

  // 誕生時刻（年齢算出基準）。秘匿された birth は基準に含めない。
  let birthTime: number | null = null;
  for (const e of visibleEvents)
    if (
      e.primaryCodexId === codexId &&
      e.kind === "birth" &&
      e.startTime != null
    )
      birthTime =
        birthTime == null ? e.startTime : Math.min(birthTime, e.startTime);

  const daysPerYear = calendar?.daysPerYear ?? 0;
  const content = {
    character: names.get(codexId) ?? codexId,
    events: involved.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      ordinal: e.ordinal,
      startTime: e.startTime,
      ageAtEvent:
        birthTime != null && e.startTime != null && daysPerYear > 0
          ? Math.floor((e.startTime - birthTime) / daysPerYear)
          : null,
    })),
  };
  return result(
    ctx,
    "get_character_timeline",
    content,
    `${content.events.length} events for ${content.character}`,
  );
}

/** 現在(または指定)シーンの作中時刻における世界状態スナップショット（構造化JSON）。 */
export async function getChronicleState(
  ctx: CoreChronicleReadContext,
  params: Record<string, unknown>,
): Promise<CoreToolResult> {
  const projectId = requireCoreProjectId(ctx);
  // The model's sceneId wins over the active scene, and it is also the position
  // of the secrecy check below (moved as it is; DR-MP4-37). The tree state is
  // read only when no sceneId was given.
  const sceneId =
    String(params["sceneId"] ?? "").trim() || ctx.getTreeState().activeSceneId;
  if (!sceneId)
    return {
      name: "get_chronicle_state",
      content: null,
      summary: "No sceneId and no active scene",
      tokensUsed: 0,
    };

  const events = await ctx.chronicle.getEvents(projectId);
  if (events.length === 0)
    return {
      name: "get_chronicle_state",
      content: null,
      summary: "No chronicle events",
      tokensUsed: 0,
    };

  const [participants, sceneEvents, calendarRow, relations, names] =
    await Promise.all([
      ctx.chronicle.listParticipants(projectId),
      ctx.chronicle.getSceneEvents(projectId),
      ctx.chronicle.getCalendar(projectId),
      ctx.chronicle.listRelations(projectId),
      ctx.chronicle.getCodexNames(projectId),
    ]);
  const nodes: readonly CoreTreeNode[] = ctx.getTreeState().nodes;
  const readingOrder = new Map(ctx.chronicle.getReadingOrder(nodes));
  // push (buildChronicleSnapshotTextForScene) と同じアンカー結果になるよう、
  // シーン自身の暦日付（scene-own アンカー源）を tree ノードから構築する。
  const sceneChronicle = new Map<string, SceneChronicle>();
  for (const n of nodes) {
    if (n.nodeType !== "scene") continue;
    sceneChronicle.set(n.id, {
      startTime: n.chronicleStartTime ?? null,
      startMinute: n.chronicleStartMinute ?? null,
      startGranularity: n.chronicleStartGranularity ?? "none",
      precision: (n.chroniclePrecision ?? "exact") as EventPrecision,
    });
  }
  // AI 秘匿: anchor/pick/derive の前段で hidden な secret イベントを除外（spec §2.4.1）。
  const vis = projectVisibleChronicle({
    events,
    sceneEvents,
    participants,
    relations,
    currentSceneId: sceneId,
    readingOrder,
  });
  const anchor = resolveSceneAnchor(sceneId, {
    sceneEvents: vis.sceneEvents,
    events: vis.events,
    readingOrder,
    sceneChronicle,
  });
  const characterIds = pickSnapshotCharacters({
    anchor,
    events: vis.events,
    participants: vis.participants,
  });
  const snapshot = deriveChronicleSnapshot(
    {
      anchor,
      events: vis.events,
      participants: vis.participants,
      relations: vis.relations,
      sceneEvents: vis.sceneEvents,
      calendar: calendarRow ? calendarFromRow(calendarRow) : null,
      characterIds,
      codexNames: names,
    },
    ctx.getUiLanguage(),
  );
  return result(
    ctx,
    "get_chronicle_state",
    snapshot,
    `Chronicle state at scene (${anchor.source})`,
  );
}
