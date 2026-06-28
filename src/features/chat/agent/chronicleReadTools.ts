import { useTreeStore } from "@/features/tree/treeStore";
import { listCodexEntries } from "@/features/codex/api";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { countTokens } from "../contextBuilder";
import {
  listEvents,
  listEventParticipantsForProject,
  listSceneEventsForProject,
  listEventRelations,
  getProjectCalendar,
  type CalendarRow,
} from "@/features/chronicle/api";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
} from "@/features/chronicle/chronicleSnapshot";
import { resolveSceneAnchor } from "@/features/chronicle/resolveSceneAnchor";
import type { ChronicleCalendar } from "@/features/chronicle/chronicleTime";
import type { ToolResult } from "./agentTypes";

type ToolReturn = Omit<ToolResult, "toolCallId">;

const noProject = (name: string, content: unknown): ToolReturn => ({
  name,
  content,
  summary: "No active project",
  tokensUsed: 0,
});

async function loadCodexNames(projectId: string): Promise<Map<string, string>> {
  const entries = await listCodexEntries(projectId);
  return new Map(entries.map((e) => [e.id, e.name] as const));
}

function parseCalendar(row: CalendarRow | null): ChronicleCalendar | null {
  if (!row) return null;
  let boundaries: ChronicleCalendar["seasonBoundaries"] = [];
  try {
    const parsed = JSON.parse(row.seasonBoundaries);
    if (Array.isArray(parsed)) boundaries = parsed;
  } catch {
    boundaries = [];
  }
  return { daysPerYear: row.daysPerYear, seasonBoundaries: boundaries };
}

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

/** 作中順イベント一覧（kind フィルタ可）。XPROJ=listEvents が project gate。 */
export async function listEventsTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return noProject("list_events", { events: [] });
  const kind = String(params["kind"] ?? "").trim();
  const events = await listEvents(projectId);
  const names = await loadCodexNames(projectId);
  const filtered =
    kind === "birth" || kind === "death" || kind === "generic"
      ? events.filter((e) => e.kind === kind)
      : events;
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

  const events = await listEvents(projectId);
  const ev = events.find((e) => e.id === eventId);
  if (!ev)
    return {
      name: "get_event_detail",
      content: null,
      summary: "Event not found",
      tokensUsed: 0,
    };

  const [names, participants, sceneLinks, allRelations] = await Promise.all([
    loadCodexNames(projectId),
    listEventParticipantsForProject(projectId, [eventId]),
    listSceneEventsForProject(projectId, { eventIds: [eventId] }),
    listEventRelations(projectId),
  ]);
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
      .filter((r) => r.causeId === eventId || r.effectId === eventId)
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
    listEvents(projectId),
    listEventParticipantsForProject(projectId),
    getProjectCalendar(projectId),
    loadCodexNames(projectId),
  ]);
  const calendar = parseCalendar(calendarRow);
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

  // 誕生時刻（年齢算出基準）。
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

  const events = await listEvents(projectId);
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
      listSceneEventsForProject(projectId),
      getProjectCalendar(projectId),
      listEventRelations(projectId),
      loadCodexNames(projectId),
    ]);
  const readingOrder = computeGlobalSceneOrder(useTreeStore.getState().nodes);
  const anchor = resolveSceneAnchor(sceneId, {
    sceneEvents,
    events,
    readingOrder,
  });
  const characterIds = pickSnapshotCharacters({ anchor, events, participants });
  const snapshot = deriveChronicleSnapshot({
    anchor,
    events,
    participants,
    relations,
    sceneEvents,
    calendar: parseCalendar(calendarRow),
    characterIds,
    codexNames: names,
  });
  return result(
    "get_chronicle_state",
    snapshot,
    `Chronicle state at scene (${anchor.source})`,
  );
}
