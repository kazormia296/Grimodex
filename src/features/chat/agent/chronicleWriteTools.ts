import { countTokens } from "../contextBuilder";
import {
  agentCreateEvent,
  agentUpdateEvent,
  agentDeleteEvent,
  agentSetEventParticipants,
  agentLinkSceneEvent,
  agentUnlinkSceneEvent,
  agentAddEventRelation,
  agentRemoveEventRelation,
  type AgentEventCreateInput,
} from "@/features/agent-writes/event";
import { EVENT_KINDS, EVENT_GRANULARITIES } from "@/db/schema";
import type { EventKind, EventGranularity } from "@/db/schema";
import { useTreeStore } from "@/features/tree/treeStore";
import { isEventHiddenFromAi } from "@/features/chronicle/chronicleSecrecy";
import type { EventRow } from "@/features/chronicle/api";
import {
  getSharedEvents,
  getSharedSceneEvents,
  getSharedReadingOrder,
  invalidateChronicleToolCache,
} from "./chronicleToolCache";
import type { ToolResult } from "./agentTypes";

type ToolReturn = Omit<ToolResult, "toolCallId">;

const ok = (name: string, content: unknown, summary: string): ToolReturn => ({
  name,
  content,
  summary,
  tokensUsed: countTokens(JSON.stringify(content)),
});
const fail = (name: string, msg: string): ToolReturn => ({
  name,
  content: null,
  summary: msg,
  tokensUsed: 0,
  error: msg,
});

const str = (v: unknown): string => String(v ?? "").trim();
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}
function optNum(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
/**
 * AI 秘匿: 既存 event への write-by-id ゲート（spec §2.4.4）。現在シーン(activeSceneId)
 * で hidden な secret event、または存在しない event を区別せず false にし、呼び出し側は
 * generic not found を返す（存在 oracle 化／秘匿内容の漏洩を防ぐ）。create は対象外。
 */
async function visibleEventForWrite(eventId: string): Promise<EventRow | null> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return null;
  const events = await getSharedEvents(projectId);
  const ev = events.find((e) => e.id === eventId);
  if (!ev) return null;
  if (!ev.secret) return ev;
  const readingOrder = getSharedReadingOrder(useTreeStore.getState().nodes);
  const currentSceneId = useTreeStore.getState().activeSceneId ?? "";
  // 全件共有キャッシュを使う（判定側が eventId で絞るため結果は filter 版と同一）。
  const sceneEvents = await getSharedSceneEvents(projectId);
  return isEventHiddenFromAi(ev, currentSceneId, {
    readingOrder,
    sceneEvents,
  })
    ? null
    : ev;
}

async function isEventVisibleForWrite(eventId: string): Promise<boolean> {
  return (await visibleEventForWrite(eventId)) !== null;
}

const NOT_FOUND = "Event not found";

/** kind 文字列を正準 enum に正規化（不正は undefined）。EVENT_KINDS が正本。 */
function coerceKind(v: unknown): EventKind | undefined {
  const s = str(v);
  return (EVENT_KINDS as readonly string[]).includes(s)
    ? (s as EventKind)
    : undefined;
}
/** granularity 文字列を正準 enum に正規化（不正は undefined）。 */
function coerceGranularity(v: unknown): EventGranularity | undefined {
  const s = str(v);
  return (EVENT_GRANULARITIES as readonly string[]).includes(s)
    ? (s as EventGranularity)
    : undefined;
}

/** 作中年表に出来事を作成（tracked-write・undo 可）。 */
export async function createEventTool(
  params: Record<string, unknown>,
  requestId?: string,
): Promise<ToolReturn> {
  const title = str(params["title"]);
  if (!title) return fail("create_event", "title is required");
  try {
    const input: AgentEventCreateInput = {
      requestId,
      title,
      note: params["note"] ? str(params["note"]) : null,
      kind: coerceKind(params["kind"]) ?? "generic",
      primaryCodexId: params["primaryCodexId"]
        ? str(params["primaryCodexId"])
        : null,
      locationCodexId: params["locationCodexId"]
        ? str(params["locationCodexId"])
        : null,
      startTime: optNum(params["startTime"]),
      endTime: optNum(params["endTime"]),
      startMinute: optNum(params["startMinute"]),
      endMinute: optNum(params["endMinute"]),
      startGranularity: coerceGranularity(params["startGranularity"]),
      endGranularity: coerceGranularity(params["endGranularity"]),
      secret: params["secret"] === true,
      // 空白のみ入力も null（自動導出）へ正規化（TS 層で契約を明示）。
      revealSceneId: str(params["revealSceneId"]) || null,
      participantCodexIds: strArray(params["participantCodexIds"]),
      sceneIds: strArray(params["sceneIds"]),
    };
    const ev = await agentCreateEvent(input);
    return ok(
      "create_event",
      { id: ev.id, title: ev.title },
      `Created event '${ev.title}'`,
    );
  } catch (e) {
    return fail("create_event", e instanceof Error ? e.message : String(e));
  } finally {
    // write 後はターン内共有キャッシュを必ず破棄（stale 読み防止）。
    invalidateChronicleToolCache();
  }
}

/** 出来事を更新（渡したフィールドのみ・tracked）。 */
export async function updateEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("update_event", "eventId is required");
  const visibleEvent = await visibleEventForWrite(eventId);
  if (!visibleEvent) return fail("update_event", NOT_FOUND);
  try {
    await agentUpdateEvent({
      eventId,
      baseVersion: visibleEvent.version,
      title: params["title"] ? str(params["title"]) : undefined,
      note: params["note"] !== undefined ? str(params["note"]) : undefined,
      kind:
        params["kind"] !== undefined ? coerceKind(params["kind"]) : undefined,
      primaryCodexId: params["primaryCodexId"]
        ? str(params["primaryCodexId"])
        : undefined,
      locationCodexId: params["locationCodexId"]
        ? str(params["locationCodexId"])
        : undefined,
      startTime:
        params["startTime"] !== undefined
          ? optNum(params["startTime"])
          : undefined,
      endTime:
        params["endTime"] !== undefined ? optNum(params["endTime"]) : undefined,
      startMinute:
        params["startMinute"] !== undefined
          ? optNum(params["startMinute"])
          : undefined,
      endMinute:
        params["endMinute"] !== undefined
          ? optNum(params["endMinute"])
          : undefined,
      startGranularity:
        params["startGranularity"] !== undefined
          ? coerceGranularity(params["startGranularity"])
          : undefined,
      endGranularity:
        params["endGranularity"] !== undefined
          ? coerceGranularity(params["endGranularity"])
          : undefined,
      secret:
        params["secret"] !== undefined ? params["secret"] === true : undefined,
      revealSceneId:
        params["revealSceneId"] !== undefined
          ? str(params["revealSceneId"])
          : undefined,
    });
    return ok("update_event", { id: eventId }, `Updated event ${eventId}`);
  } catch (e) {
    return fail("update_event", e instanceof Error ? e.message : String(e));
  } finally {
    invalidateChronicleToolCache();
  }
}

/** 出来事を削除（participants/scene/relation も cascade・undo で全復元）。 */
export async function deleteEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("delete_event", "eventId is required");
  const visibleEvent = await visibleEventForWrite(eventId);
  if (!visibleEvent) return fail("delete_event", NOT_FOUND);
  try {
    await agentDeleteEvent(eventId, { baseVersion: visibleEvent.version });
    return ok("delete_event", { id: eventId }, `Deleted event ${eventId}`);
  } catch (e) {
    return fail("delete_event", e instanceof Error ? e.message : String(e));
  } finally {
    invalidateChronicleToolCache();
  }
}

/** シーンに出来事を stamp（紐づけ）。 */
export async function stampSceneEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const sceneId = str(params["sceneId"]);
  const eventId = str(params["eventId"]);
  if (!sceneId || !eventId)
    return fail("stamp_scene_event", "sceneId and eventId are required");
  if (!(await isEventVisibleForWrite(eventId)))
    return fail("stamp_scene_event", NOT_FOUND);
  try {
    await agentLinkSceneEvent(sceneId, eventId);
    return ok(
      "stamp_scene_event",
      { sceneId, eventId },
      `Stamped event ${eventId} on scene ${sceneId}`,
    );
  } catch (e) {
    return fail(
      "stamp_scene_event",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    invalidateChronicleToolCache();
  }
}

/** シーンと出来事の紐づけを解除。 */
export async function unstampSceneEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const sceneId = str(params["sceneId"]);
  const eventId = str(params["eventId"]);
  if (!sceneId || !eventId)
    return fail("unstamp_scene_event", "sceneId and eventId are required");
  if (!(await isEventVisibleForWrite(eventId)))
    return fail("unstamp_scene_event", NOT_FOUND);
  try {
    await agentUnlinkSceneEvent(sceneId, eventId);
    return ok(
      "unstamp_scene_event",
      { sceneId, eventId },
      `Unstamped event ${eventId} from scene ${sceneId}`,
    );
  } catch (e) {
    return fail(
      "unstamp_scene_event",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    invalidateChronicleToolCache();
  }
}

/** 出来事の参加者集合を置換（codex id 配列）。 */
export async function setEventParticipantsTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("set_event_participants", "eventId is required");
  const visibleEvent = await visibleEventForWrite(eventId);
  if (!visibleEvent) return fail("set_event_participants", NOT_FOUND);
  try {
    const codexIds = strArray(params["codexEntryIds"]);
    await agentSetEventParticipants(eventId, codexIds, {
      baseVersion: visibleEvent.version,
    });
    return ok(
      "set_event_participants",
      { eventId, count: codexIds.length },
      `Set ${codexIds.length} participant(s)`,
    );
  } catch (e) {
    return fail(
      "set_event_participants",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    invalidateChronicleToolCache();
  }
}

/** 因果エッジを追加（cause→effect）。 */
export async function addEventRelationTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const causeId = str(params["causeEventId"]);
  const effectId = str(params["effectEventId"]);
  if (!causeId || !effectId)
    return fail(
      "add_event_relation",
      "causeEventId and effectEventId are required",
    );
  if (
    !(await isEventVisibleForWrite(causeId)) ||
    !(await isEventVisibleForWrite(effectId))
  )
    return fail("add_event_relation", NOT_FOUND);
  try {
    await agentAddEventRelation(causeId, effectId);
    return ok(
      "add_event_relation",
      { causeId, effectId },
      `Linked ${causeId} → ${effectId}`,
    );
  } catch (e) {
    return fail(
      "add_event_relation",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    invalidateChronicleToolCache();
  }
}

/** 因果エッジを削除。 */
export async function removeEventRelationTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const causeId = str(params["causeEventId"]);
  const effectId = str(params["effectEventId"]);
  if (!causeId || !effectId)
    return fail(
      "remove_event_relation",
      "causeEventId and effectEventId are required",
    );
  if (
    !(await isEventVisibleForWrite(causeId)) ||
    !(await isEventVisibleForWrite(effectId))
  )
    return fail("remove_event_relation", NOT_FOUND);
  try {
    await agentRemoveEventRelation(causeId, effectId);
    return ok(
      "remove_event_relation",
      { causeId, effectId },
      `Unlinked ${causeId} → ${effectId}`,
    );
  } catch (e) {
    return fail(
      "remove_event_relation",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    invalidateChronicleToolCache();
  }
}
