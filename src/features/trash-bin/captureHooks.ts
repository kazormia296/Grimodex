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
  PinPayload,
  ScenePayload,
  SnippetPayload,
} from "./types";

const PREVIEW_TEXT_MAX = 500;
const BODY_PREVIEW_MAX = 60;

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

  // folder ノードは Grid 章ヘッダ扱い (subKind=grid-chapter)。設計書 §4-C / §16.8。
  if (node.nodeType === "folder") {
    captureGridChapterDeletion({ projectId, node, folderHintName, tempId });
    return;
  }

  const bodyPreview = truncate(extractPlainText(content), BODY_PREVIEW_MAX);
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
  const previewText = truncate(node.title || "(無題)", PREVIEW_TEXT_MAX);

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
  const bodyPreview = truncate(
    extractPlainText(entry.content ?? ""),
    BODY_PREVIEW_MAX,
  );
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
  const bodyPreview = truncate(
    extractPlainText(snippet.content ?? ""),
    BODY_PREVIEW_MAX,
  );
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
  const bodyPreview = truncate(
    extractPlainText(sticky.body ?? ""),
    BODY_PREVIEW_MAX,
  );
  const previewText = truncate(
    sticky.title || sticky.previewText || bodyPreview || "(無題)",
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
  const previewText = truncate(
    foreshadow.title || foreshadow.intent || "(無題)",
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
    loadBearing: foreshadow.loadBearing ?? null,
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

export interface CapturePinOpts {
  projectId: string;
  sceneId: string;
  entryId: string;
  /** 削除時点での scene title (Tree から解決して渡す) */
  sceneTitleHint: string | null;
  /** 削除時点での codex entry name */
  entryNameHint: string | null;
  /** 削除時点での codex icon (Lucide name) */
  entryIconHint: string | null;
  tempId: string;
}

export function capturePinDeletion(opts: CapturePinOpts): void {
  const {
    projectId,
    sceneId,
    entryId,
    sceneTitleHint,
    entryNameHint,
    entryIconHint,
    tempId,
  } = opts;
  const previewText = truncate(
    entryNameHint || sceneTitleHint || "(ピン)",
    PREVIEW_TEXT_MAX,
  );

  const payload: PinPayload = {
    sceneId,
    entryId,
    sceneTitleHint,
    entryNameHint,
    entryIconHint,
  };

  useTrashBinStore.getState().enqueuePending(
    {
      projectId,
      kind: "structure-item",
      subKind: "pin",
      originSceneId: sceneId,
      originCodexId: entryId,
      previewText,
      previewMeta: {
        sceneTitleHint,
        entryNameHint,
        entryIconHint,
      },
      payload,
    },
    { tempId },
  );
}
