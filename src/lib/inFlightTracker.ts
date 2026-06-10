/**
 * 同一キーの非同期ロードを「in-flight の間だけ」共有する小さなトラッカー。
 *
 * パネル mount の eager load が複数同時に走るとき (起動時に同系パネルが
 * 並んで mount する等) のクエリ重複を畳むために使う。settle したら即座に
 * 忘れるので、remount 時の再フェッチ (外部書き込みの追従) は阻害しない。
 */
export interface InFlightTracker {
  /** ロード開始を記録する。promise は内部で reject しないこと (store の
   *  load 関数は catch 込みで void を返す前提)。 */
  track(key: string, promise: Promise<void>): void;
  /** 同一キーのロードが進行中ならその promise、なければ null。 */
  peek(key: string): Promise<void> | null;
}

export function createInFlightTracker(): InFlightTracker {
  let current: { key: string; promise: Promise<void> } | null = null;
  return {
    track(key, promise) {
      current = { key, promise };
      void promise.finally(() => {
        // 後続の track で上書きされていたら触らない
        if (current?.promise === promise) current = null;
      });
    },
    peek(key) {
      return current && current.key === key ? current.promise : null;
    },
  };
}
