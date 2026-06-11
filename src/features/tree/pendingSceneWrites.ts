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
 */
export async function awaitPendingSceneContentWrite(
  sceneId: string,
): Promise<void> {
  let write = pendingWrites.get(sceneId);
  while (write) {
    await write.catch(() => {});
    const next = pendingWrites.get(sceneId);
    // The settle handler above removes the entry before this continuation
    // runs (it was attached first). Seeing the same promise again would mean
    // re-awaiting a settled write forever — treat it as done defensively.
    write = next === write ? undefined : next;
  }
}
