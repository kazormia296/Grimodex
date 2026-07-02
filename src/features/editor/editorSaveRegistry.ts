/**
 * Registry of per-scene save handlers.
 * EditorPane / LinearSceneBlock register their save function here so external
 * callers (tab context menu "Save all and close", agent writes, rename
 * propagation, post-effect flush, …) can trigger saves without accessing
 * editor component state directly.
 */
const handlers = new Map<string, () => Promise<void>>();

export function registerSaveHandler(nodeId: string, fn: () => Promise<void>) {
  handlers.set(nodeId, fn);
}

/**
 * Unregister a save handler. Pass the registered `fn` to make the call a
 * no-op when a newer instance for the same nodeId has already re-registered
 * (remount races: the new mount's register can run before the old mount's
 * cleanup — an unconditional delete would drop the live handler).
 */
export function unregisterSaveHandler(
  nodeId: string,
  fn?: () => Promise<void>,
) {
  if (fn !== undefined && handlers.get(nodeId) !== fn) return;
  handlers.delete(nodeId);
}

/** Save a scene by nodeId. No-op if no handler is registered. */
export async function saveScene(nodeId: string): Promise<void> {
  const fn = handlers.get(nodeId);
  if (fn) await fn();
}

/**
 * IDs of every node with a live, flushable editor (tab panes and mounted
 * linear blocks alike). Callers that need "flush all open editors so the DB
 * reflects unsaved edits" should iterate this — a tab list misses linear-mode
 * editors, which have no tab.
 */
export function registeredSaveHandlerIds(): string[] {
  return [...handlers.keys()];
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
