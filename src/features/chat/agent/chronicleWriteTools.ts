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
): Promise<ToolReturn> {
  const title = str(params["title"]);
  if (!title) return fail("create_event", "title is required");
  try {
    const input: AgentEventCreateInput = {
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
  }
}

/** 出来事を更新（渡したフィールドのみ・tracked）。 */
export async function updateEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("update_event", "eventId is required");
  try {
    await agentUpdateEvent({
      eventId,
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
    });
    return ok("update_event", { id: eventId }, `Updated event ${eventId}`);
  } catch (e) {
    return fail("update_event", e instanceof Error ? e.message : String(e));
  }
}

/** 出来事を削除（participants/scene/relation も cascade・undo で全復元）。 */
export async function deleteEventTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("delete_event", "eventId is required");
  try {
    await agentDeleteEvent(eventId);
    return ok("delete_event", { id: eventId }, `Deleted event ${eventId}`);
  } catch (e) {
    return fail("delete_event", e instanceof Error ? e.message : String(e));
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
  }
}

/** 出来事の参加者集合を置換（codex id 配列）。 */
export async function setEventParticipantsTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const eventId = str(params["eventId"]);
  if (!eventId) return fail("set_event_participants", "eventId is required");
  try {
    const codexIds = strArray(params["codexEntryIds"]);
    await agentSetEventParticipants(eventId, codexIds);
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
  }
}
