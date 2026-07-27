/**
 * Registry of per-scene save handlers.
 * EditorPane / LinearSceneBlock register their save function here so external
 * callers (tab context menu "Save all and close", agent writes, rename
 * propagation, post-effect flush, …) can trigger saves without accessing
 * editor component state directly.
 */
import {
  documentIdFromKey,
  encodeDocumentKey,
  type DocumentKey,
  type EditorInstanceId,
} from "./document/documentKey";
import type { LoadedEditorBinding } from "./document/types";

type SaveHandler = () => Promise<void>;
type DiscardHandler = () => void;
type DocumentReference = string | DocumentKey;

interface HandlerBucket {
  documentId: string;
  handlers: Map<string, SaveHandler>;
}

const LEGACY_INSTANCE = "__legacy__";
const handlers = new Map<string, HandlerBucket>();
const persistedBindingHandlers = new Map<
  string,
  Map<string, (binding: LoadedEditorBinding) => void>
>();
const discardHandlers = new Map<
  string,
  {
    documentId: string;
    handlers: Map<
      string,
      { groupIndex: number | null; handler: DiscardHandler }
    >;
  }
>();

function referenceIdentity(reference: DocumentReference): {
  encoded: string;
  documentId: string;
} {
  if (typeof reference === "string") {
    return {
      encoded: `legacy:${encodeURIComponent(reference)}`,
      documentId: reference,
    };
  }
  return {
    encoded: encodeDocumentKey(reference),
    documentId: documentIdFromKey(reference),
  };
}

export function registerSaveHandler(
  reference: DocumentReference,
  fn: SaveHandler,
): void;
export function registerSaveHandler(
  reference: DocumentReference,
  instanceId: EditorInstanceId,
  fn: SaveHandler,
): void;
export function registerSaveHandler(
  reference: DocumentReference,
  instanceOrFn: EditorInstanceId | SaveHandler,
  maybeFn?: SaveHandler,
): void {
  const { encoded, documentId } = referenceIdentity(reference);
  const instanceId =
    typeof instanceOrFn === "function" ? LEGACY_INSTANCE : instanceOrFn;
  const fn = typeof instanceOrFn === "function" ? instanceOrFn : maybeFn;
  if (!fn) return;
  const bucket = handlers.get(encoded) ?? {
    documentId,
    handlers: new Map<string, SaveHandler>(),
  };
  bucket.handlers.set(instanceId, fn);
  handlers.set(encoded, bucket);
}

/**
 * Unregister a save handler. Pass the registered `fn` to make the call a
 * no-op when a newer instance for the same nodeId has already re-registered
 * (remount races: the new mount's register can run before the old mount's
 * cleanup — an unconditional delete would drop the live handler).
 */
export function unregisterSaveHandler(
  reference: DocumentReference,
  fn?: SaveHandler,
): void;
export function unregisterSaveHandler(
  reference: DocumentReference,
  instanceId: EditorInstanceId,
  fn?: SaveHandler,
): void;
export function unregisterSaveHandler(
  reference: DocumentReference,
  instanceOrFn?: EditorInstanceId | SaveHandler,
  maybeFn?: SaveHandler,
): void {
  if (typeof reference === "string" && instanceOrFn === undefined) {
    for (const [encoded, bucket] of handlers) {
      if (bucket.documentId === reference) handlers.delete(encoded);
    }
    return;
  }
  const { encoded } = referenceIdentity(reference);
  const bucket = handlers.get(encoded);
  if (!bucket) return;

  if (typeof instanceOrFn === "string") {
    const current = bucket.handlers.get(instanceOrFn);
    if (maybeFn !== undefined && current !== maybeFn) return;
    bucket.handlers.delete(instanceOrFn);
  } else {
    const current = bucket.handlers.get(LEGACY_INSTANCE);
    if (instanceOrFn !== undefined && current !== instanceOrFn) return;
    bucket.handlers.delete(LEGACY_INSTANCE);
  }

  if (bucket.handlers.size === 0) handlers.delete(encoded);
}

/**
 * Register the per-instance OCC-base listener for one exact document. Local
 * mirrored panes already receive each other's content through the live-content
 * channel; after one pane persists that shared snapshot, peers must also adopt
 * the returned version before their next edit.
 */
export function registerPersistedBindingHandler(
  documentKey: DocumentKey,
  instanceId: EditorInstanceId,
  handler: (binding: LoadedEditorBinding) => void,
): void {
  const encoded = encodeDocumentKey(documentKey);
  const bucket = persistedBindingHandlers.get(encoded) ?? new Map();
  bucket.set(instanceId, handler);
  persistedBindingHandlers.set(encoded, bucket);
}

export function unregisterPersistedBindingHandler(
  documentKey: DocumentKey,
  instanceId: EditorInstanceId,
  handler?: (binding: LoadedEditorBinding) => void,
): void {
  const encoded = encodeDocumentKey(documentKey);
  const bucket = persistedBindingHandlers.get(encoded);
  if (!bucket) return;
  if (handler !== undefined && bucket.get(instanceId) !== handler) return;
  bucket.delete(instanceId);
  if (bucket.size === 0) persistedBindingHandlers.delete(encoded);
}

/**
 * Register the explicit-discard path for one editor instance. This is kept
 * separate from save handlers: "Close without saving" must cancel a paused
 * AutoSave before React unmounts the conflict surface, otherwise its cleanup
 * retains a permanently unresolvable retired instance.
 */
export function registerDiscardHandler(
  reference: DocumentReference,
  instanceId: EditorInstanceId,
  handler: DiscardHandler,
  groupIndex: number | null = null,
): void {
  const { encoded, documentId } = referenceIdentity(reference);
  const bucket = discardHandlers.get(encoded) ?? {
    documentId,
    handlers: new Map(),
  };
  bucket.handlers.set(instanceId, { groupIndex, handler });
  discardHandlers.set(encoded, bucket);
}

export function unregisterDiscardHandler(
  reference: DocumentReference,
  instanceId: EditorInstanceId,
  handler?: DiscardHandler,
): void {
  const { encoded } = referenceIdentity(reference);
  const bucket = discardHandlers.get(encoded);
  if (!bucket) return;
  const current = bucket.handlers.get(instanceId);
  if (handler !== undefined && current?.handler !== handler) return;
  bucket.handlers.delete(instanceId);
  if (bucket.handlers.size === 0) discardHandlers.delete(encoded);
}

/**
 * Explicitly abandon the live draft displayed in one editor group.
 *
 * The group filter matters in split view: closing one copy must not cancel the
 * other pane's independent dirty instance for the same document.
 */
export function discardDocumentInGroup(
  documentId: string,
  groupIndex: number,
): void {
  for (const bucket of discardHandlers.values()) {
    if (bucket.documentId !== documentId) continue;
    for (const registered of bucket.handlers.values()) {
      if (registered.groupIndex === groupIndex) registered.handler();
    }
  }
}

/** Fan out a successful local save to every peer instance except its origin. */
export function announcePersistedBinding(
  documentKey: DocumentKey,
  originInstanceId: EditorInstanceId,
  binding: LoadedEditorBinding,
): void {
  const bucket = persistedBindingHandlers.get(encodeDocumentKey(documentKey));
  if (!bucket) return;
  for (const [instanceId, handler] of bucket) {
    if (instanceId !== originInstanceId) handler(binding);
  }
}

/** Save every mounted editor for a raw entity id. No-op when none is open. */
export async function saveScene(nodeId: string): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const bucket of handlers.values()) {
    if (bucket.documentId !== nodeId) continue;
    for (const fn of bucket.handlers.values()) pending.push(fn());
  }
  await Promise.all(pending);
}

/** Save only instances that display the exact canonical document. */
export async function saveDocument(key: DocumentKey): Promise<void> {
  const bucket = handlers.get(encodeDocumentKey(key));
  if (!bucket) return;
  await Promise.all([...bucket.handlers.values()].map((fn) => fn()));
}

/**
 * IDs of every node with a live, flushable editor (tab panes and mounted
 * linear blocks alike). Callers that need "flush all open editors so the DB
 * reflects unsaved edits" should iterate this — a tab list misses linear-mode
 * editors, which have no tab.
 */
export function registeredSaveHandlerIds(): string[] {
  return [...new Set([...handlers.values()].map((entry) => entry.documentId))];
}

/**
 * saveScene() の外部 flush 契約は「DB を live editor の状態に追いつかせる」
 * こと。編集が保存済み (clean) なら DB は既に追いついているので書かない。
 *
 * clean でも無条件に保存すると、saveSceneContent の OCC version が flush の
 * たびに bump され、propose 時点の base_version と必ず食い違う — 開いている
 * だけのシーンへの headless 自動適用 (autoApplyProse) が恒久 stale ブロック
 * になり、「clean な open シーンは自動反映 + live resync」の設計
 * (externalWriteFeed と同じポリシー) が死ぬ。dirty 情報を持つのは各エディタ
 * コンポーネントだけなので、登録側がこのゲートで包んで登録する。
 *
 * `isDirty` は呼び出し時点で評価する (登録時の値を閉じ込めない)。
 */
export function dirtyGatedSaveHandler(
  isDirty: () => boolean,
  save: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!isDirty()) return;
    await save();
  };
}
