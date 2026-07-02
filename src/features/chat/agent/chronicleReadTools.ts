import i18next from "@/lib/i18n";
import { useTreeStore } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { countTokens } from "../contextBuilder";
import {
  listEventParticipantsForProject,
  listEventRelations,
  getProjectCalendar,
} from "@/features/chronicle/api";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedCodexNames,
  getSharedReadingOrder,
} from "./chronicleToolCache";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
} from "@/features/chronicle/chronicleSnapshot";
import {
  isEventHiddenFromAi,
  projectVisibleChronicle,
} from "@/features/chronicle/chronicleSecrecy";
import type { EventRow } from "@/features/chronicle/api";
import {
  resolveSceneAnchor,
  type SceneChronicle,
} from "@/features/chronicle/resolveSceneAnchor";
import { calendarFromRow } from "@/features/chronicle/chronicleTime";
import type { EventPrecision } from "@/db/schema";
import type { ToolResult } from "./agentTypes";

type ToolReturn = Omit<ToolResult, "toolCallId">;

const noProject = (name: string, content: unknown): ToolReturn => ({
  name,
  content,
  summary: "No active project",
  tokensUsed: 0,
});

const result = (
  name: string,
  content: unknown,
  summary: string,
): ToolReturn => ({
  name,
  content,
  summary,
  tokensUsed: countTokens(JSON.stringify(content)),
});

/**
 * AI 秘匿: 現在シーン文脈で「可視」イベント id 集合を算出（spec §2.5）。
 * read ツールには chat の scene 文脈が無いため activeSceneId を現在シーンとする
 * （get_chronicle_state と同じ fallback）。activeSceneId 空 → 現在位置不明として
 * isEventHiddenFromAi 側で fail-closed（secret=true を一律隠す）。
 */
async function visibleEventIds(
  projectId: string,
  events: EventRow[],
): Promise<Set<string>> {
  const readingOrder = getSharedReadingOrder(useTreeStore.getState().nodes);
  const currentSceneId = useTreeStore.getState().activeSceneId ?? "";
  const sceneEvents = await getSharedSceneEvents(projectId);
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

/** 作中順イベント一覧（kind フィルタ可）。XPROJ=listEvents が project gate。 */
export async function listEventsTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return noProject("list_events", { events: [] });
  const kind = String(params["kind"] ?? "").trim();
  const events = await getSharedEvents(projectId);
  const names = await getSharedCodexNames(projectId);
  // AI 秘匿: 現在シーンで hidden な secret イベントを除外。
  const visible = await visibleEventIds(projectId, events);
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
      primaryCharacter: e.primaryCodexId
        ? (names.get(e.primaryCodexId) ?? null)
        : null,
    })),
  };
  return result("list_events", content, `${content.events.length} events`);
}

/** 単一イベント詳細（参加者/紐づきシーン/因果）。XPROJ=project の events に在ること。 */
export async function getEventDetailTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return noProject("get_event_detail", null);
  const eventId = String(params["eventId"] ?? "").trim();
  if (!eventId)
    return {
      name: "get_event_detail",
      content: null,
      summary: "eventId is required",
      tokensUsed: 0,
    };

  const events = await getSharedEvents(projectId);
  // AI 秘匿: hidden な event は「存在しない」扱い（generic not found・存在 oracle 化を防ぐ）。
  const visible = await visibleEventIds(projectId, events);
  const ev = events.find((e) => e.id === eventId);
  if (!ev || !visible.has(eventId))
    return {
      name: "get_event_detail",
      content: null,
      summary: "Event not found",
      tokensUsed: 0,
    };

  const [names, participants, allSceneEvents, allRelations] = await Promise.all(
    [
      getSharedCodexNames(projectId),
      listEventParticipantsForProject(projectId, [eventId]),
      getSharedSceneEvents(projectId),
      listEventRelations(projectId),
    ],
  );
  const sceneLinks = allSceneEvents.filter((s) => s.eventId === eventId);
  const titleByEvent = new Map(events.map((e) => [e.id, e.title] as const));
  const nodes = useTreeStore.getState().nodes;
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
  return result("get_event_detail", content, `Event '${ev.title}'`);
}

/** 人物の作中経歴（primary/participant で関与した出来事を作中順・各時点の年齢）。 */
export async function getCharacterTimelineTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return noProject("get_character_timeline", { events: [] });
  const codexId = String(params["codexId"] ?? "").trim();
  if (!codexId)
    return {
      name: "get_character_timeline",
      content: { events: [] },
      summary: "codexId is required",
      tokensUsed: 0,
    };

  const [events, participants, calendarRow, names] = await Promise.all([
    getSharedEvents(projectId),
    listEventParticipantsForProject(projectId),
    getProjectCalendar(projectId),
    getSharedCodexNames(projectId),
  ]);
  const calendar = calendarRow ? calendarFromRow(calendarRow) : null;
  // AI 秘匿: hidden な secret イベントを除外（秘匿された生年・死亡・経歴の漏洩防止）。
  const visible = await visibleEventIds(projectId, events);
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
    "get_character_timeline",
    content,
    `${content.events.length} events for ${content.character}`,
  );
}

/** 現在(または指定)シーンの作中時刻における世界状態スナップショット（構造化JSON）。 */
export async function getChronicleStateTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return noProject("get_chronicle_state", null);
  const sceneId =
    String(params["sceneId"] ?? "").trim() ||
    useTreeStore.getState().activeSceneId;
  if (!sceneId)
    return {
      name: "get_chronicle_state",
      content: null,
      summary: "No sceneId and no active scene",
      tokensUsed: 0,
    };

  const events = await getSharedEvents(projectId);
  if (events.length === 0)
    return {
      name: "get_chronicle_state",
      content: null,
      summary: "No chronicle events",
      tokensUsed: 0,
    };

  const [participants, sceneEvents, calendarRow, relations, names] =
    await Promise.all([
      listEventParticipantsForProject(projectId),
      getSharedSceneEvents(projectId),
      getProjectCalendar(projectId),
      listEventRelations(projectId),
      getSharedCodexNames(projectId),
    ]);
  const nodes = useTreeStore.getState().nodes;
  const readingOrder = getSharedReadingOrder(nodes);
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
    i18next.language === "en" ? "en" : "ja",
  );
  return result(
    "get_chronicle_state",
    snapshot,
    `Chronicle state at scene (${anchor.source})`,
  );
}
