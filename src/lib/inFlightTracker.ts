/**
 * 同一キーの非同期ロードを「in-flight の間だけ」共有する小さなトラッカー。
 *
 * パネル mount の eager load が複数同時に走るとき (起動時に同系パネルが
 * 並んで mount する等) のクエリ重複を畳むために使う。settle したら即座に
 * 忘れるので、remount 時の再フェッチ (外部書き込みの追従) は阻害しない。
 */
export interface InFlightTracker {
  /**
   * ロード開始を記録する。rejecting な canonical promise も保持できる。
   * 呼び出し側は用途ごとに reject を伝播／吸収する wrapper を選べる。
   */
  track(key: string, promise: Promise<void>): void;
  /** 同一キーのロードが進行中ならその promise、なければ null。 */
  peek(key: string): Promise<void> | null;
  /** scope replacement 時に、settle 前の旧 scope load への相乗りを禁止する。 */
  clear(): void;
}

export function createInFlightTracker(): InFlightTracker {
  let current: { key: string; promise: Promise<void> } | null = null;
  return {
    track(key, promise) {
      current = { key, promise };
      const clearIfCurrent = () => {
        // 後続の track / clear で上書きされていたら触らない
        if (current?.promise === promise) current = null;
      };
      // `finally` は元 promise が reject すると新しい rejected promise を
      // 作るため使わない。両 branch を処理して cleanup 自体は必ず resolve。
      void promise.then(clearIfCurrent, clearIfCurrent);
    },
    peek(key) {
      return current && current.key === key ? current.promise : null;
    },
    clear() {
      current = null;
    },
  };
}
