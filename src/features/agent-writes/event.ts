import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { scheduleEventIndex } from "@/features/semantic-search/scheduler";
import { markCodexContentAsAi } from "./codex";
import { applyUndoJournal } from "./undoJournal";
import type { EventKind, EventPrecision, EventGranularity } from "@/db/schema";

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

/** tracked-write の経路差分。AI/MCP は既定（in-app-agent・policy gate あり）、
 * UI 手動編集は surface="manual" かつ knowledgeWrite policy 非対象。 */
export interface TrackedWriteOpts {
  /** undo_journal に記録する書き込み元の表面。省略時は in-app-agent（AI）。 */
  surface?: string;
  /** AI 書き込みポリシー(knowledgeWrite)の対象外にする（UI 手動編集など）。 */
  skipPolicyGate?: boolean;
}

function bump(): void {
  useChronicleStore.getState().bumpRevision();
}

/** Rust write を実行し、globalHistoryStore に undo/redo を積む共通処理。 */
async function trackedEventWrite(
  command: string,
  payload: Record<string, unknown>,
  historyLabelKey: string,
  opts?: TrackedWriteOpts,
): Promise<AgentWriteResult> {
  // 手動 UI 編集はユーザーの直接操作なので AI 書き込みポリシーで弾かない。
  if (!opts?.skipPolicyGate && blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }
  const result = await invoke<AgentWriteResult>(command, {
    payload: {
      projectId: getCurrentProjectId(),
      sessionId: getRecorderSessionId(),
      ...(opts?.surface ? { surface: opts.surface } : {}),
      ...payload,
    },
  });
  bump();
  // 作中年表 RAG (Phase 3): 出来事の本文/参加者を変える書き込みのみ意味検索
  // index に投入する。delete / scene 橋 / relation は埋め込み対象フィールドを
  // 変えないので index しない (relation/scene は別エンティティ)。
  if (
    command === "agent_event_create" ||
    command === "agent_event_update" ||
    command === "agent_event_set_participants"
  ) {
    scheduleEventIndex(result.entityId);
  }
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
  /** 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。 */
  detail?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  /** 未割当の整理用サブレーン id。 */
  laneGroup?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
  startGranularity?: EventGranularity;
  endGranularity?: EventGranularity;
  precision?: EventPrecision;
  kind?: EventKind;
  /** AI 秘匿（reveal アンカー方式）。既定 false=表示。 */
  secret?: boolean;
  /** 読む順の開示アンカー（明示上書き・""=自動導出へ戻す・null/undefined=未指定）。 */
  revealSceneId?: string | null;
  participantCodexIds?: string[];
  sceneIds?: string[];
}

export async function agentCreateEvent(
  input: AgentEventCreateInput,
  opts?: TrackedWriteOpts,
): Promise<{ id: string; title: string }> {
  // AI/agent 経路では detail（リッチテキスト = PM JSON）に AI 帰属マークを
  // 焼き込む。codex/snippet 経路と同じ markCodexContentAsAi を再利用し、
  // AI が書いた年表の詳細本文が CodexContentEditor 上で AI 色に着色される
  // ようにする。手動 UI 編集（surface="manual"）の detail は既にエディタが
  // 人間帰属マークを持つため対象外（markCodexContentAsAi は既存 authorship
  // マークを冪等にスキップするが、二重処理を避けるため明示ガードする）。
  const detail =
    input.detail && opts?.surface !== "manual"
      ? markCodexContentAsAi(input.detail)
      : (input.detail ?? null);
  const result = await trackedEventWrite(
    "agent_event_create",
    {
      title: input.title ?? "",
      note: input.note ?? null,
      detail,
      ordinal: input.ordinal ?? undefined,
      primaryCodexId: input.primaryCodexId ?? null,
      laneGroup: input.laneGroup ?? null,
      locationCodexId: input.locationCodexId ?? null,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      startMinute: input.startMinute ?? null,
      endMinute: input.endMinute ?? null,
      startGranularity: input.startGranularity ?? "none",
      endGranularity: input.endGranularity ?? "none",
      precision: input.precision ?? "exact",
      kind: input.kind ?? "generic",
      secret: input.secret ?? false,
      revealSceneId: input.revealSceneId ?? null,
      participantCodexIds: input.participantCodexIds ?? [],
      sceneIds: input.sceneIds ?? [],
    },
    "chronicle.agentHistoryCreate",
    opts,
  );
  return { id: result.entityId, title: input.title ?? "" };
}

export interface AgentEventUpdateInput {
  eventId: string;
  title?: string;
  laneGroup?: string | null;
  note?: string | null;
  /** 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。set-if-present。 */
  detail?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
  startGranularity?: EventGranularity;
  endGranularity?: EventGranularity;
  precision?: EventPrecision;
  kind?: EventKind;
  /** AI 秘匿（reveal アンカー方式）。 */
  secret?: boolean;
  /** 読む順の開示アンカー（""=自動導出へ戻す・undefined=未指定で不変）。 */
  revealSceneId?: string | null;
}

export async function agentUpdateEvent(
  input: AgentEventUpdateInput,
  opts?: TrackedWriteOpts,
): Promise<void> {
  const { eventId, ...patch } = input;
  // create と同じ理由で AI 経路の detail 更新に AI 帰属マークを焼き込む
  // （set-if-present なので detail 未指定の更新は触らない）。
  if (patch.detail && opts?.surface !== "manual") {
    patch.detail = markCodexContentAsAi(patch.detail);
  }
  await trackedEventWrite(
    "agent_event_update",
    { eventId, ...patch },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

export async function agentDeleteEvent(
  eventId: string,
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_delete",
    { eventId },
    "chronicle.agentHistoryDelete",
    opts,
  );
}

export async function agentSetEventParticipants(
  eventId: string,
  codexEntryIds: string[],
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_set_participants",
    { eventId, codexEntryIds },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

export async function agentLinkSceneEvent(
  sceneId: string,
  eventId: string,
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_scene_event_link",
    { sceneId, eventId },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

export async function agentUnlinkSceneEvent(
  sceneId: string,
  eventId: string,
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_scene_event_unlink",
    { sceneId, eventId },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

export async function agentAddEventRelation(
  causeEventId: string,
  effectEventId: string,
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_relation_add",
    { causeEventId, effectEventId },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

export async function agentRemoveEventRelation(
  causeEventId: string,
  effectEventId: string,
  opts?: TrackedWriteOpts,
): Promise<void> {
  await trackedEventWrite(
    "agent_event_relation_remove",
    { causeEventId, effectEventId },
    "chronicle.agentHistoryUpdate",
    opts,
  );
}

// ───────── UI 手動編集用 tracked-write ─────────
// ChroniclePanel の手動 CRUD はこの ui* ラッパ経由で書き込む。AI 経路と同じ
// undo_journal / change_events を発火させつつ surface="manual" で provenance を
// 分け、knowledgeWrite policy（AI 書き込み制御）の対象外にする。
const UI_WRITE_OPTS: TrackedWriteOpts = {
  surface: "manual",
  skipPolicyGate: true,
};

export function uiCreateEvent(
  input: AgentEventCreateInput,
): Promise<{ id: string; title: string }> {
  return agentCreateEvent(input, UI_WRITE_OPTS);
}

export function uiUpdateEvent(input: AgentEventUpdateInput): Promise<void> {
  return agentUpdateEvent(input, UI_WRITE_OPTS);
}

export function uiDeleteEvent(eventId: string): Promise<void> {
  return agentDeleteEvent(eventId, UI_WRITE_OPTS);
}

/** 出来事の参加者（追加レーン=複数 Codex 所属）を置換する。tracked-write。 */
export function uiSetEventParticipants(
  eventId: string,
  codexEntryIds: string[],
): Promise<void> {
  return agentSetEventParticipants(eventId, codexEntryIds, UI_WRITE_OPTS);
}

export function uiAddEventRelation(
  causeEventId: string,
  effectEventId: string,
): Promise<void> {
  return agentAddEventRelation(causeEventId, effectEventId, UI_WRITE_OPTS);
}

export function uiRemoveEventRelation(
  causeEventId: string,
  effectEventId: string,
): Promise<void> {
  return agentRemoveEventRelation(causeEventId, effectEventId, UI_WRITE_OPTS);
}

/** シーン⇔出来事の手動リンク（undo 連動・surface="manual"）。 */
export function uiLinkSceneEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  return agentLinkSceneEvent(sceneId, eventId, UI_WRITE_OPTS);
}

export function uiUnlinkSceneEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  return agentUnlinkSceneEvent(sceneId, eventId, UI_WRITE_OPTS);
}
