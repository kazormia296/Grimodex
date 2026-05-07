/**
 * ゴミ箱パネルの型定義（設計書 v3 §3 / §16）。
 *
 * Phase 1 では `kind: "text-fragment"` のみ書き込まれる。
 * 構造アイテム (`scene` / `codex-entry` / ...) は Phase 4-5 で追加。
 */

export type TrashKind = "text-fragment" | "structure-item";

export type TrashSubKind =
  | "text-fragment"
  | "scene"
  | "codex-entry"
  | "snippet"
  | "map-sticky"
  | "foreshadow"
  | "pin"
  | "grid-chapter";

export type TrashSpanSource = "human" | "ai" | "unknown";

export interface TrashSpan {
  text: string;
  source: TrashSpanSource;
  model: string | null;
  chatMessageId: string | null;
  timestamp: string | null;
}

export interface TextFragmentPayload {
  text: string;
  spans: TrashSpan[];
}

// 構造アイテム payload は Phase 4-5 で具体型を入れる。
// Phase 1 では型枠だけ用意しておく。
export type StructureItemPayload = Record<string, unknown>;

export type TrashPayload = TextFragmentPayload | StructureItemPayload;

export interface TrashOrigin {
  kind: "scene" | "codex";
  id: string;
}

export interface TrashItemData {
  id: string;
  projectId: string;
  kind: TrashKind;
  subKind: TrashSubKind;
  originSceneId: string | null;
  originCodexId: string | null;
  previewText: string;
  previewMeta: Record<string, unknown> | null;
  payload: TrashPayload;
  charCount: number;
  isInteresting: boolean;
  deletedAt: string;
}

/**
 * `addItem` の入力。`id` / `charCount` / `isInteresting` は store/DB 側で計算。
 */
export interface TrashItemInput {
  projectId: string;
  kind: TrashKind;
  subKind: TrashSubKind;
  originSceneId: string | null;
  originCodexId: string | null;
  previewText: string;
  previewMeta: Record<string, unknown> | null;
  payload: TrashPayload;
}

/**
 * Undo 1500ms 吸収用の保留アイテム。
 * 設計書 §4-A の `PendingTrashItem`。
 */
export interface PendingTrashItem {
  tempId: string;
  data: TrashItemInput;
  expireAt: number; // Date.now() + UNDO_ABSORB_WINDOW_MS
  /** プラグインのソース判別用 (any source エディタ単位の cancel に使う) */
  originSceneId: string | null;
  originCodexId: string | null;
}

export const UNDO_ABSORB_WINDOW_MS = 1500;
