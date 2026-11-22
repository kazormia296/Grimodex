/**
 * Chronicle の行の型（EventRow・ParticipantRow・SceneEventRow・EventRelationRow）。
 * 型だけの module で、DB・Tauri・store を引かない（MP-4b PR-3b-2。`api.ts` から切り出した。
 * `api.ts` は型を再エクスポートし続ける）。
 */
import type {
  EventGranularity,
  EventKind,
  EventPrecision,
} from "../../db/schema.js";

export interface EventRow {
  id: string;
  projectId: string;
  title: string;
  note: string | null;
  /** 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。null/空 = 未入力。 */
  detail: string | null;
  ordinal: string;
  primaryCodexId: string | null;
  /** 未割当の整理用サブレーン id（null=既定の未割当レーン）。 */
  laneGroup: string | null;
  locationCodexId: string | null;
  startTime: number | null;
  endTime: number | null;
  startMinute: number | null;
  endMinute: number | null;
  startGranularity: EventGranularity;
  endGranularity: EventGranularity;
  precision: EventPrecision;
  kind: EventKind;
  /** AI 秘匿フラグ（reveal アンカー方式）。true=条件付きで AI 文脈から除外。 */
  secret: boolean;
  /** 読む順の開示アンカー（明示上書き専用）。null=自動導出 or 恒久秘匿。 */
  revealSceneId: string | null;
  /** Aggregate OCC version (event row + participant set). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ───────── participants ─────────
export interface ParticipantRow {
  eventId: string;
  codexEntryId: string;
  role: string | null;
}

// ───────── scene_events 橋 ─────────
export interface SceneEventRow {
  sceneId: string;
  eventId: string;
}

// ───────── event_relations（因果エッジ） ─────────
export interface EventRelationRow {
  causeId: string;
  effectId: string;
}
