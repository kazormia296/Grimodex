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

// 設計書 §16.2: Scene 削除のスナップショット。
// 復元時は新 ID を発行し、folderHintId が現存しない場合はルートに戻す。
export interface ScenePayload {
  originalId: string;
  title: string;
  body: string; // ProseMirror JSON を JSON.stringify したもの
  /** unplacedBeatsDoc (JSON 配列) を生のまま保持 */
  beats: string;
  povCharacterId: string | null;
  folderHintId: string | null;
  folderHintName: string | null;
  /** synopsis / status / storyTimeOrder / locationId 等の補助情報 */
  metadata: {
    synopsis: string | null;
    status: string | null;
    nodeType: "scene" | "folder" | "note";
    locationId: string | null;
    sortOrder: string;
    storyTimeOrder: string | null;
    storyTimeLabel: string | null;
  };
  charCount: number;
}

// 設計書 §16.3: CodexEntry 削除のスナップショット。
// fields/links は schema に存在しないため Phase 4 では取り扱わない (空配列)。
export interface CodexEntryPayload {
  originalId: string;
  name: string;
  /** schema 上の type カラム (Codex 種別 slug) */
  category: string;
  body: string;
  summary: string | null;
  aliases: string | null; // schema は JSON 文字列で保持
  excludedAliases: string | null;
  icon: string | null;
  notes: string | null;
  contextMode: string;
  childrenBudget: string;
  parentId: string | null;
  /** 設計書互換のため空配列で常に存在させる */
  fields: never[];
  links: never[];
  imageRefs: never[];
}

// 設計書 §16.4: Snippet 削除のスナップショット。
export interface SnippetPayload {
  originalId: string;
  title: string;
  body: string;
  /** schema の tagsCache (JSON 文字列) を生で保持 */
  tags: string | null;
  contentSource: string | null;
  sceneId: string | null;
}

export type StructureItemPayload =
  | ScenePayload
  | CodexEntryPayload
  | SnippetPayload
  | Record<string, unknown>; // Phase 5: map-sticky / foreshadow / pin / grid-chapter

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
