import type {
  CoreChronicleReadContext,
  CoreTreeNode,
} from "../../mastraRead/ports.js";
import type { EventPrecision } from "../db/schema.js";
import {
  collectChronicleCandidateCodexIds,
  dropHiddenCodexFromChronicleInput,
} from "../features/chronicle/chronicleHiddenCodex.js";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
} from "../features/chronicle/chronicleSnapshot.js";
import {
  markChronicleRevealScene,
  type ChronicleRevealMark,
} from "../features/chronicle/chronicleRevealMark.js";
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
 * `get_chronicle_state`. The renderer migration fixed their read order,
 * tree-state reads, strings, and result key order. CSR/1 removes the event-
 * secrecy reads and checks Codex visibility before producing each result.
 *
 * Every tool checks the project first (`requireCoreProjectId`, before it
 * reads anything) and its arguments after it: the renderer answered `No active
 * project` before `eventId is required`, and the order is kept. That is the
 * reverse of the foreshadow and search tools (DR-MP4-32c) and is recorded in
 * DR-MP4-37. The renderer's thin layer turns the empty-project throw back into
 * its `No active project` result.
 *
 * Every event is readable. The Codex port removes entries hidden at the
 * context's current scene. The model's `sceneId` argument selects the
 * `get_chronicle_state` anchor; it does not affect the hidden-Codex check.
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
  const filtered =
    kind === "birth" || kind === "death" || kind === "generic"
      ? events.filter((e) => e.kind === kind)
      : events;
  const revealSceneByEventId = new Map<string, ChronicleRevealMark>();
  const revealEvents = filtered.filter(
    (event) => event.revealSceneId != null && event.revealSceneId !== "",
  );
  if (revealEvents.length > 0) {
    const { nodes, activeSceneId } = ctx.getTreeState();
    const readingOrder = ctx.chronicle.getReadingOrder(nodes);
    const titleByScene = new Map(
      nodes.map((node) => [node.id, node.title] as const),
    );
    for (const event of revealEvents) {
      const revealScene = markChronicleRevealScene(
        event.revealSceneId,
        activeSceneId,
        readingOrder,
        titleByScene,
      );
      if (revealScene) revealSceneByEventId.set(event.id, revealScene);
    }
  }
  const ids = [
    ...new Set(
      filtered.flatMap((e) =>
        e.primaryCodexId != null ? [e.primaryCodexId] : [],
      ),
    ),
  ];
  const hidden = ids.length
    ? await ctx.chronicle.listHiddenCodexIds(projectId, ids)
    : new Set<string>();
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
      primaryCharacter:
        e.primaryCodexId != null && !hidden.has(e.primaryCodexId)
          ? (names.get(e.primaryCodexId) ?? null)
          : null,
      ...(revealSceneByEventId.has(e.id)
        ? { revealScene: revealSceneByEventId.get(e.id)! }
        : {}),
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
  const ev = events.find((e) => e.id === eventId);
  if (!ev)
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
  const ids = [
    ...new Set(
      [
        ev.primaryCodexId,
        ev.locationCodexId,
        ...participants.map((p) => p.codexEntryId),
      ].filter((id): id is string => id != null),
    ),
  ];
  const hidden = ids.length
    ? await ctx.chronicle.listHiddenCodexIds(projectId, ids)
    : new Set<string>();
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  const lang: DateLang = ctx.getUiLanguage();
  const sceneLinks = allSceneEvents.filter((s) => s.eventId === eventId);
  const titleByEvent = new Map(events.map((e) => [e.id, e.title] as const));
  const treeState = ctx.getTreeState();
  const nodes = treeState.nodes;
  const titleByScene = new Map(nodes.map((n) => [n.id, n.title] as const));
  const revealScene =
    ev.revealSceneId != null && ev.revealSceneId !== ""
      ? markChronicleRevealScene(
          ev.revealSceneId,
          treeState.activeSceneId,
          ctx.chronicle.getReadingOrder(nodes),
          titleByScene,
        )
      : null;

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
    primaryCharacter:
      ev.primaryCodexId != null && !hidden.has(ev.primaryCodexId)
        ? (names.get(ev.primaryCodexId) ?? null)
        : null,
    location:
      ev.locationCodexId != null && !hidden.has(ev.locationCodexId)
        ? (names.get(ev.locationCodexId) ?? null)
        : null,
    participants: participants
      .filter((p) => !hidden.has(p.codexEntryId))
      .map((p) => ({
        codexId: p.codexEntryId,
        name: names.get(p.codexEntryId) ?? null,
        role: p.role,
      })),
    scenes: sceneLinks.map((s) => ({
      sceneId: s.sceneId,
      title: titleByScene.get(s.sceneId) ?? null,
    })),
    relations: allRelations
      .filter((r) => r.causeId === eventId || r.effectId === eventId)
      .map((r) => ({
        cause: titleByEvent.get(r.causeId) ?? null,
        effect: titleByEvent.get(r.effectId) ?? null,
      })),
    ...(revealScene ? { revealScene } : {}),
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
  const hidden = await ctx.chronicle.listHiddenCodexIds(projectId, [codexId]);
  if (hidden.has(codexId))
    return {
      name: "get_character_timeline",
      content: null,
      summary: "Character not found",
      tokensUsed: 0,
    };
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  const participantEventIds = new Set(
    participants
      .filter((p) => p.codexEntryId === codexId)
      .map((p) => p.eventId),
  );
  const involved = events
    .filter(
      (e) => e.primaryCodexId === codexId || participantEventIds.has(e.id),
    )
    .sort((a, b) => cmpKeys(a.ordinal, b.ordinal));
  const revealSceneByEventId = new Map<string, ChronicleRevealMark>();
  const revealEvents = involved.filter(
    (event) => event.revealSceneId != null && event.revealSceneId !== "",
  );
  if (revealEvents.length > 0) {
    const { nodes, activeSceneId } = ctx.getTreeState();
    const readingOrder = ctx.chronicle.getReadingOrder(nodes);
    const titleByScene = new Map(
      nodes.map((node) => [node.id, node.title] as const),
    );
    for (const event of revealEvents) {
      const revealScene = markChronicleRevealScene(
        event.revealSceneId,
        activeSceneId,
        readingOrder,
        titleByScene,
      );
      if (revealScene) revealSceneByEventId.set(event.id, revealScene);
    }
  }

  // 誕生時刻（年齢算出基準）。出来事はすべて対象。
  let birthTime: number | null = null;
  for (const e of events)
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
      ...(revealSceneByEventId.has(e.id)
        ? { revealScene: revealSceneByEventId.get(e.id)! }
        : {}),
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
  // The model's sceneId wins over the active scene for the snapshot anchor.
  // The tree state is read only when no sceneId was given.
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
  const ids = collectChronicleCandidateCodexIds({
    events,
    participants,
    codexNames: names,
  });
  const hidden = ids.length
    ? await ctx.chronicle.listHiddenCodexIds(projectId, ids)
    : new Set<string>();
  const input = dropHiddenCodexFromChronicleInput(
    { events, participants, codexNames: names },
    hidden,
  );
  const anchor = resolveSceneAnchor(sceneId, {
    sceneEvents,
    events: input.events,
    readingOrder,
    sceneChronicle,
  });
  const characterIds = pickSnapshotCharacters({
    anchor,
    events: input.events,
    participants: input.participants,
  });
  const snapshot = deriveChronicleSnapshot(
    {
      anchor,
      events: input.events,
      participants: input.participants,
      relations,
      sceneEvents,
      calendar: calendarRow ? calendarFromRow(calendarRow) : null,
      characterIds,
      codexNames: input.codexNames,
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
