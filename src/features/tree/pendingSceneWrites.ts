/**
 * In-flight scene-content write tracking — read-after-write barrier.
 *
 * The DB layer (drizzle sqlite-proxy → invoke("db_execute")) issues each SQL
 * as an independent IPC call with no read-after-write ordering: a SELECT fired
 * while an UPDATE is still in flight can reach the Rust Mutex first and return
 * the pre-write row. The editor hits exactly this race when a scene's autosave
 * flush is fired without being awaited (React unmount cleanup cannot await)
 * and the next surface immediately loads the same scene:
 *
 *   - linear mode OFF: LinearSceneBlock unmount flush vs EditorPane mount load
 *   - linear mode scroll: scene unmount flush vs remount load (same scene)
 *
 * The stale read then becomes a real wipe once the new editor autosaves the
 * stale doc back. Because the autosave debounce resets on every keystroke,
 * the unsaved window is "everything since the last 2s typing pause", not 2s.
 *
 * Writers register their content write here (synchronously, before the first
 * await) and readers await any pending write for the scene before SELECTing.
 */
const pendingWrites = new Map<string, Promise<unknown>>();

/**
 * Per-scene write chain — write-write serialization.
 *
 * DB コマンドの async 化 (M3) で Tauri 側の暗黙のメインスレッド直列化が消え、
 * 同一シーンへの UPDATE 同士 (autosave A と flush B 等) が Rust の非公平
 * Mutex 上で並行しうる。B→A の順にコミットされると旧本文で確定する
 * (黙示データ損失) ため、同一 tree_nodes 行を書く API はこのチェーンで
 * 「発行順 = コミット順」を per-scene に復元する。
 */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * Run `write` after every previously-issued write for the same scene has
 * settled (failed predecessors do not block). Returns the chained promise —
 * created synchronously, so callers can register it with
 * `trackSceneContentWrite` before their first await. When no write is in
 * flight the callback runs synchronously, preserving the pre-existing
 * "dispatch happens in the same task" behavior the read barrier relies on.
 */
export function serializeSceneWrite<T>(
  sceneId: string,
  write: () => Promise<T>,
): Promise<T> {
  const prev = writeChains.get(sceneId);
  let chained: Promise<T>;
  if (prev) {
    chained = prev.catch(() => {}).then(write);
  } else {
    try {
      chained = write();
    } catch (e) {
      chained = Promise.reject(e);
    }
  }
  writeChains.set(sceneId, chained);
  chained
    .catch(() => {})
    .finally(() => {
      if (writeChains.get(sceneId) === chained) {
        writeChains.delete(sceneId);
      }
    });
  return chained;
}

/**
 * Wait until every pending scene write (serialized chains + tracked content
 * writes) has settled. Used to quiesce the DB before `open_workspace` swaps
 * the active database — an in-flight write landing after the swap would be
 * silently lost (UPDATE, 0 rows) or leak rows into the new workspace (INSERT).
 * Strict and bounded: every write is allowed to settle, but any failure (or a
 * producer that never reaches quiescence within the round cap) rejects the
 * destructive lifecycle operation. Proceeding would discard the only live
 * copy of an editor buffer.
 */
export async function awaitAllPendingSceneWrites(): Promise<void> {
  const failures: unknown[] = [];
  for (let round = 0; round < 50; round++) {
    if (writeChains.size === 0 && pendingWrites.size === 0) {
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more scene writes failed");
      }
      return;
    }
    const snapshot = [
      ...new Set([...writeChains.values(), ...pendingWrites.values()]),
    ];
    const results = await Promise.allSettled(snapshot);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  throw new AggregateError(
    failures,
    "Scene writes did not reach quiescence after 50 rounds",
  );
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("scene-writes"),
  stage: "scene-writes",
  flush: awaitAllPendingSceneWrites,
});

/**
 * Register an in-flight content write for a scene. Must be called
 * synchronously where the write is created so that a reader fired later in
 * the same task (e.g. a React effect after an unmount cleanup) sees it.
 * Tracks only the latest write per scene; the entry self-clears on settle.
 */
export function trackSceneContentWrite(
  sceneId: string,
  write: Promise<unknown>,
): void {
  pendingWrites.set(sceneId, write);
  write
    .catch(() => {})
    .finally(() => {
      if (pendingWrites.get(sceneId) === write) {
        pendingWrites.delete(sceneId);
      }
    });
}

/**
 * Wait until no content write is pending for the scene. Resolves immediately
 * in the common case (no pending entry). Failed writes unblock the reader —
 * the read then returns the last committed row, same as before the barrier.
 *
 * `writeChains` も待つ: チェーン entry は serializeSceneWrite が同期登録する
 * ので、「発行済みだがまだ UPDATE をディスパッチしていない write」(先行 write
 * の後ろに並んでいる) も reader から見える。pendingWrites (実ディスパッチ済み
 * UPDATE) だけだとこの窓を追い越して stale read しうる。
 */
export async function awaitPendingSceneContentWrite(
  sceneId: string,
): Promise<void> {
  let write = writeChains.get(sceneId) ?? pendingWrites.get(sceneId);
  while (write) {
    await write.catch(() => {});
    const next = writeChains.get(sceneId) ?? pendingWrites.get(sceneId);
    // The settle handler above removes the entry before this continuation
    // runs (it was attached first). Seeing the same promise again would mean
    // re-awaiting a settled write forever — treat it as done defensively.
    write = next === write ? undefined : next;
  }
}

/**
 * Snapshot-grade per-Scene barrier. Unlike ordinary UI readers, a failed
 * predecessor cannot be treated as "last committed row is good enough".
 */
export async function awaitPendingSceneWriteStrict(
  sceneId: string,
): Promise<void> {
  const failures: unknown[] = [];
  let write = writeChains.get(sceneId) ?? pendingWrites.get(sceneId);
  while (write) {
    try {
      await write;
    } catch (error) {
      failures.push(error);
    }
    const next = writeChains.get(sceneId) ?? pendingWrites.get(sceneId);
    write = next === write ? undefined : next;
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `One or more writes failed for Scene ${sceneId}`,
    );
  }
}
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
