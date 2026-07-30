/**
 * 各 feature store の delete アクションから呼ばれるキャプチャ API。
 * 設計書 §4-B / §16.2-16.4。
 *
 * 内部で subKind に応じた payload を組み立て、`previewText` / `previewMeta` を
 * 用意して `trashBinStore.enqueuePending` を呼ぶ。tempId は呼び出し側が生成し、
 * Global Undo の undo callback 内で `cancelPending({tempId})` を呼ぶことで
 * 1500ms 以内 Ctrl+Z を吸収できる。
 */

import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import type { MapSticky, MapNodePosition } from "@/db/schema";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import { useTrashBinStore } from "./trashBinStore";
import type {
  CodexEntryPayload,
  ForeshadowPayload,
  GridChapterPayload,
  MapStickyPayload,
  ScenePayload,
  SnippetPayload,
} from "./types";

const PREVIEW_TEXT_MAX = 500;
const BODY_PREVIEW_MAX = 60;

/** Cancel a deferred trash capture when the owning feature undo wins. */
export function cancelPendingTrash(tempId: string): void {
  useTrashBinStore.getState().cancelPending({ tempId });
}

/**
 * Scene キャプチャ用の input shape。`TreeNode` (api.ts の row 型) と
 * `TreeNodeData` (treeStore の in-memory 表現) の両方から作れるように、
 * 必要フィールドだけを抜き出した型にする。
 * `unplacedBeatsDoc` は TreeNodeData には載っていないので別途渡す。
 */
export interface SceneCaptureNodeInput {
  id: string;
  projectId: string;
  title: string;
  parentId: string | null;
  nodeType: string;
  synopsis: string | null;
  status: string | null;
  sortOrder: string;
  storyTimeOrder: string | null;
  storyTimeLabel: string | null;
  povCharacterId: string | null;
  locationId: string | null;
  charCount: number;
}

function truncate(text: string, max: number): string {
  if ([...text].length <= max) return text;
  return [...text].slice(0, max).join("") + "…";
}

/**
 * 「実質空」判定: 渡された文字列群がすべて空白のみなら true。
 * 設計書通り「無題かつ本文 0 文字」の deletion をゴミ箱に積み上げない。
 */
function allBlank(...parts: Array<string | null | undefined>): boolean {
  return parts.every((p) => !p || p.trim().length === 0);
}

export interface CaptureSceneOpts {
  projectId: string;
  node: SceneCaptureNodeInput;
  /** ProseMirror JSON serialized (treeApi.loadSceneContent の戻り値) */
  content: string;
  /** unplacedBeatsDoc — TreeNodeData には載っていないので呼び出し側で渡す。未指定なら "[]" */
  beats?: string;
  /** 親フォルダの表示名 (削除時点の値、Tree から解決して渡す) */
  folderHintName: string | null;
  tempId: string;
}

export function captureSceneDeletion(opts: CaptureSceneOpts): void {
  const { projectId, node, content, beats, folderHintName, tempId } = opts;

  // フォルダ自体はゴミ箱に入れない (中の scene のみが trash に積まれる仕様)。
  // 万一フォルダで呼ばれても黙って無視する。
  if (node.nodeType === "folder") return;

  const bodyText = extractPlainText(content);
  // 本文が空のシーンは保存しない (デフォルト名の Scene が量産削除されるノイズ防止)。
  // タイトルはデフォルト名で常に埋まっているため判定に含めない。
  if (allBlank(bodyText)) return;
  const bodyPreview = truncate(bodyText, BODY_PREVIEW_MAX);
  const previewText = truncate(node.title || bodyPreview, PREVIEW_TEXT_MAX);

  const payload: ScenePayload = {
    originalId: node.id,
    title: node.title,
    body: content,
    beats: beats ?? "[]",
    povCharacterId: node.povCharacterId ?? null,
    folderHintId: node.parentId ?? null,
    folderHintName,
    metadata: {
      synopsis: node.synopsis ?? null,
      status: node.status ?? null,
      nodeType: node.nodeType as "scene" | "folder" | "note",
      locationId: node.locationId ?? null,
      sortOrder: node.sortOrder,
      storyTimeOrder: node.storyTimeOrder ?? null,
      storyTimeLabel: node.storyTimeLabel ?? null,
    },
    charCount: node.charCount,
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "scene",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        folderName: folderHintName,
        bodyPreview,
        nodeType: node.nodeType,
      },
      payload,
    },
    { tempId },
  );
}

export interface CaptureGridChapterOpts {
  projectId: string;
  node: SceneCaptureNodeInput;
  folderHintName: string | null;
  tempId: string;
}

export function captureGridChapterDeletion(opts: CaptureGridChapterOpts): void {
  const { projectId, node, folderHintName, tempId } = opts;
  // 無題の空 folder は保存しない
  if (allBlank(node.title)) return;
  const previewText = truncate(node.title, PREVIEW_TEXT_MAX);

  const payload: GridChapterPayload = {
    originalId: node.id,
    title: node.title,
    parentId: node.parentId ?? null,
    sortOrder: node.sortOrder,
    metadata: {
      synopsis: node.synopsis ?? null,
      status: node.status ?? null,
      storyTimeOrder: node.storyTimeOrder ?? null,
      storyTimeLabel: node.storyTimeLabel ?? null,
    },
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "grid-chapter",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        folderName: folderHintName,
      },
      payload,
    },
    { tempId },
  );
}

export interface CaptureCodexOpts {
  projectId: string;
  entry: CodexEntry;
  /** Codex 種別の表示用ラベル (e.g. "Character") — meta 表示に使う */
  categoryLabel: string | null;
  /** Codex 種別のアイコン名 (Lucide) — meta 表示に使う */
  iconName: string | null;
  tempId: string;
}

export function captureCodexDeletion(opts: CaptureCodexOpts): void {
  const { projectId, entry, categoryLabel, iconName, tempId } = opts;
  const bodyText = extractPlainText(entry.content ?? "");
  // 概要 + 本文の両方が空の Codex は保存しない。
  // 名前 (entry.name) はデフォルト名で常に埋まっているため判定に含めない。
  if (allBlank(entry.summary, bodyText)) return;
  const bodyPreview = truncate(bodyText, BODY_PREVIEW_MAX);
  const previewText = truncate(
    entry.name || entry.summary || bodyPreview,
    PREVIEW_TEXT_MAX,
  );

  const payload: CodexEntryPayload = {
    originalId: entry.id,
    name: entry.name,
    category: entry.type,
    body: entry.content ?? "{}",
    summary: entry.summary ?? null,
    aliases: entry.aliases ?? null,
    excludedAliases: entry.excludedAliases ?? null,
    icon: entry.icon ?? null,
    notes: entry.notes ?? null,
    contextMode: entry.contextMode,
    childrenBudget: entry.childrenBudget,
    parentId: entry.parentId ?? null,
    fields: [],
    links: [],
    imageRefs: [],
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "codex-entry",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        categoryLabel,
        iconName,
        bodyPreview,
        category: entry.type,
      },
      payload,
    },
    { tempId },
  );
}

export interface CaptureSnippetOpts {
  projectId: string;
  snippet: Snippet;
  tempId: string;
}

export function captureSnippetDeletion(opts: CaptureSnippetOpts): void {
  const { projectId, snippet, tempId } = opts;
  const bodyText = extractPlainText(snippet.content ?? "");
  // 本文が空の Snippet は保存しない。
  // タイトルはデフォルト名で常に埋まっているため判定に含めない。
  if (allBlank(bodyText)) return;
  const bodyPreview = truncate(bodyText, BODY_PREVIEW_MAX);
  const previewText = truncate(snippet.title || bodyPreview, PREVIEW_TEXT_MAX);

  const payload: SnippetPayload = {
    originalId: snippet.id,
    title: snippet.title,
    body: snippet.content ?? "{}",
    tags: snippet.tagsCache ?? null,
    contentSource: snippet.contentSource ?? null,
    sceneId: snippet.sceneId ?? null,
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "snippet",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        bodyPreview,
        tagsCache: snippet.tagsCache ?? null,
      },
      payload,
    },
    { tempId },
  );
}

export interface CaptureMapStickyOpts {
  projectId: string;
  sticky: MapSticky;
  position: MapNodePosition;
  tempId: string;
}

export function captureMapStickyDeletion(opts: CaptureMapStickyOpts): void {
  const { projectId, sticky, position, tempId } = opts;
  const bodyText = extractPlainText(sticky.body ?? "");
  // previewText + 本文の両方が空の Sticky は保存しない。
  // タイトルはデフォルト名で常に埋まっているため判定に含めない。
  if (allBlank(sticky.previewText, bodyText)) return;
  const bodyPreview = truncate(bodyText, BODY_PREVIEW_MAX);
  const previewText = truncate(
    sticky.title || sticky.previewText || bodyPreview,
    PREVIEW_TEXT_MAX,
  );

  const payload: MapStickyPayload = {
    originalId: sticky.id,
    boardId: sticky.boardId,
    title: sticky.title ?? null,
    body: sticky.body ?? '{"type":"doc","content":[]}',
    previewText: sticky.previewText ?? null,
    paletteId: sticky.paletteId,
    colorSlot: sticky.colorSlot,
    x: position.x,
    y: position.y,
    pinned: Boolean(position.pinned),
    zIndex: position.zIndex,
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "map-sticky",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        bodyPreview,
        paletteId: sticky.paletteId,
        colorSlot: sticky.colorSlot,
      },
      payload,
    },
    { tempId },
  );
}

export interface CaptureForeshadowOpts {
  projectId: string;
  foreshadow: ForeshadowRow;
  tempId: string;
}

export function captureForeshadowDeletion(opts: CaptureForeshadowOpts): void {
  const { projectId, foreshadow, tempId } = opts;
  // intent + notes の両方が空の伏線は保存しない。
  // タイトルはデフォルト名で常に埋まっているため判定に含めない。
  if (allBlank(foreshadow.intent, foreshadow.notes)) return;
  const previewText = truncate(
    foreshadow.title || foreshadow.intent || "",
    PREVIEW_TEXT_MAX,
  );

  const payload: ForeshadowPayload = {
    originalId: foreshadow.id,
    projectId: foreshadow.projectId,
    title: foreshadow.title,
    intent: foreshadow.intent ?? null,
    notes: foreshadow.notes ?? null,
    payoffSceneRef: foreshadow.payoffSceneId ?? null,
    payoffFromPos: foreshadow.payoffFromPos ?? null,
    payoffToPos: foreshadow.payoffToPos ?? null,
    payoffConfirmed: foreshadow.payoffConfirmed,
    abandoned: foreshadow.abandoned,
    secret: foreshadow.secret,
    loadBearing: foreshadow.loadBearing ?? null,
    codexLinkDirtyAt: foreshadow.codexLinkDirtyAt?.getTime() ?? null,
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "foreshadow",
      originSceneId: null,
      originCodexId: null,
      previewText,
      previewMeta: {
        intent: foreshadow.intent ?? null,
        loadBearing: foreshadow.loadBearing ?? null,
        abandoned: foreshadow.abandoned,
      },
      payload,
    },
    { tempId },
  );
}
