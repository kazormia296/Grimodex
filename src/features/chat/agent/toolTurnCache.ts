/**
 * エージェントループ「1ターン」（LLM 応答 1 回分のツールバッチ）内で共有する
 * lazy キャッシュの基盤。ツール毎に同じ全件クエリ（listEvents 等）をフルロード
 * し直すのを避けるため、ロード結果を in-flight promise ごと共有する。
 *
 * 生存期間の契約:
 *  - runAgentLoop がツールバッチ実行前に beginAgentToolTurn() を呼び、毎ターン破棄。
 *  - write 系ツールがデータを変更したら明示 invalidate で即破棄。
 *  - key に projectId を含めるため、プロジェクト切替でも必ず無効化される。
 * リセット/invalidate は「余分な再ロード」を招くだけで stale を生まない（安全側）。
 *
 * agentLoop（汎用層）が chronicle 等のデータ層へ依存しないよう、リセットは
 * レジストリ経由にする（具体的な loader は chronicleToolCache.ts 側で登録）。
 */

/** 同一 key のロードを in-flight promise ごと共有する lazy 単一スロットキャッシュ。 */
export class SharedLoader<T> {
  private slot: { key: string; promise: Promise<T> } | null = null;

  constructor(private readonly load: (key: string) => Promise<T>) {}

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

const resetHooks: Array<() => void> = [];

/** ターン開始時に破棄すべきキャッシュのリセット関数を登録する（module load 時に 1 回）。 */
export function registerToolTurnReset(reset: () => void): void {
  resetHooks.push(reset);
}

/** ツールバッチ実行前に呼び、登録済みキャッシュを全て破棄する（runAgentLoop が呼ぶ）。 */
export function beginAgentToolTurn(): void {
  for (const reset of resetHooks) reset();
}
