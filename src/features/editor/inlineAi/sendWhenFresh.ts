import { debugLog, errorDetail } from "@/lib/debugLog";

/**
 * 非同期で作った Inline AI の context を、送信時点でまだ有効なときだけ使う。
 *
 * `buildInlineAiContextForSend` は hidden 判定のために DB を引くので、呼び出しから
 * `generate` までの間にカーソル・文書・projection・書込み可否が変わりうる。変わっていたら
 * 古い context を送らず黙って捨てる（A/B 経路と同じ規則）。reject は未処理にせず記録する。
 */
export function sendWhenFresh<T>(
  contextPromise: Promise<T>,
  isStillFresh: () => boolean,
  run: (context: T) => void,
): void {
  void contextPromise
    .then((context) => {
      if (!isStillFresh()) return;
      run(context);
    })
    .catch((error: unknown) => {
      debugLog.warn(
        "inline-ai",
        "インライン AI の context の作成または送信に失敗した",
        errorDetail(error),
      );
    });
}
