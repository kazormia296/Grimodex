import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { applyUndoJournal } from "./undoJournal";
import type { EventKind, EventPrecision } from "@/db/schema";

/**
 * 作中年表 (Chronicle) の tracked-write（undo_journal + change_events）。
 * codex/foreshadow と同じく Rust 側で原子的に記録し、globalHistoryStore に
 * undo/redo を登録する。AI agent / MCP の年表書き込みは必ずこの層を通す
 * （素の Drizzle CRUD は UI/抽出ウィザード用に残るが、tracked ではない）。
 */

interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}

function bump(): void {
  useChronicleStore.getState().bumpRevision();
}

/** Rust write を実行し、globalHistoryStore に undo/redo を積む共通処理。 */
async function trackedEventWrite(
  command: string,
  payload: Record<string, unknown>,
  historyLabelKey: string,
): Promise<AgentWriteResult> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }
  const result = await invoke<AgentWriteResult>(command, {
    payload: {
      projectId: getCurrentProjectId(),
      sessionId: getRecorderSessionId(),
      ...payload,
    },
  });
  bump();
  if (!useGlobalHistoryStore.getState().isReplaying) {
    const journalId = result.undoJournalId;
    useGlobalHistoryStore.getState().push({
      kind: "chronicle",
      label: i18next.t(historyLabelKey),
      entityId: result.entityId,
      async undo() {
        await applyUndoJournal(journalId, "undo");
        bump();
      },
      async redo() {
        await applyUndoJournal(journalId, "redo");
        bump();
      },
    });
  }
  return result;
}

export interface AgentEventCreateInput {
  title?: string;
  note?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  precision?: EventPrecision;
  kind?: EventKind;
  participantCodexIds?: string[];
  sceneIds?: string[];
}

export async function agentCreateEvent(
  input: AgentEventCreateInput,
): Promise<{ id: string; title: string }> {
  const result = await trackedEventWrite(
    "agent_event_create",
    {
      title: input.title ?? "",
      note: input.note ?? null,
      ordinal: input.ordinal ?? undefined,
      primaryCodexId: input.primaryCodexId ?? null,
      locationCodexId: input.locationCodexId ?? null,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      precision: input.precision ?? "exact",
      kind: input.kind ?? "generic",
      participantCodexIds: input.participantCodexIds ?? [],
      sceneIds: input.sceneIds ?? [],
    },
    "chronicle.agentHistoryCreate",
  );
  return { id: result.entityId, title: input.title ?? "" };
}

export interface AgentEventUpdateInput {
  eventId: string;
  title?: string;
  note?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  precision?: EventPrecision;
  kind?: EventKind;
}

export async function agentUpdateEvent(
  input: AgentEventUpdateInput,
): Promise<void> {
  const { eventId, ...patch } = input;
  await trackedEventWrite(
    "agent_event_update",
    { eventId, ...patch },
    "chronicle.agentHistoryUpdate",
  );
}

export async function agentDeleteEvent(eventId: string): Promise<void> {
  await trackedEventWrite(
    "agent_event_delete",
    { eventId },
    "chronicle.agentHistoryDelete",
  );
}

export async function agentSetEventParticipants(
  eventId: string,
  codexEntryIds: string[],
): Promise<void> {
  await trackedEventWrite(
    "agent_event_set_participants",
    { eventId, codexEntryIds },
    "chronicle.agentHistoryUpdate",
  );
}

export async function agentLinkSceneEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  await trackedEventWrite(
    "agent_scene_event_link",
    { sceneId, eventId },
    "chronicle.agentHistoryUpdate",
  );
}

export async function agentUnlinkSceneEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  await trackedEventWrite(
    "agent_scene_event_unlink",
    { sceneId, eventId },
    "chronicle.agentHistoryUpdate",
  );
}

export async function agentAddEventRelation(
  causeEventId: string,
  effectEventId: string,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_relation_add",
    { causeEventId, effectEventId },
    "chronicle.agentHistoryUpdate",
  );
}

export async function agentRemoveEventRelation(
  causeEventId: string,
  effectEventId: string,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_relation_remove",
    { causeEventId, effectEventId },
    "chronicle.agentHistoryUpdate",
  );
}
