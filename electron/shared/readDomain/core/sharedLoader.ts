/**
 * 同一 key のロードを in-flight promise ごと共有する lazy 単一スロットキャッシュ。
 *
 * The one-slot loader of the chronicle tools' per-batch cache, moved out of the
 * renderer's `toolTurnCache.ts` (MP-4b PR-7a; that file re-exports it, so its
 * importers and `toolTurnCache.test.ts` are unchanged). A pure class: no store,
 * no registry, no module-level state. The renderer keeps its module singletons
 * (reset by `beginAgentToolTurn`); Main builds one set per turn
 * (`chronicleMainContext.ts`).
 *
 * A failed load is not kept (the slot is freed so the next call retries), and a
 * `clear()` while a load is in flight leaves that load's result out of the slot.
 */
export class SharedLoader<T> {
  private slot: { key: string; promise: Promise<T> } | null = null;
  private readonly load: (key: string) => Promise<T>;

  constructor(load: (key: string) => Promise<T>) {
    this.load = load;
  }

  get(key: string): Promise<T> {
    if (this.slot && this.slot.key === key) return this.slot.promise;
    const promise = this.load(key).catch((e: unknown) => {
      // 失敗はキャッシュしない（次の呼び出しで再試行できるようスロットを空ける）。
      if (this.slot?.promise === promise) this.slot = null;
      throw e;
    });
    this.slot = { key, promise };
    return promise;
  }

  clear(): void {
    this.slot = null;
  }
}
