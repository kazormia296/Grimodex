import { profileEgressLocalRefusal } from "@/features/profile-egress/profileEgressClosure";
import { useAiSettingsStore } from "./store";

/**
 * AI の入口の UI を閉じる（NIR-1 DA-2b の PUB-G 前の必須 3・4、DR-DA2B-R22、R23）。
 * 状態の表示（`ProfileEgressStatusIndicator`、定数の後ろの lazy chunk）だけが、状態を
 * restricted、activating、unavailable のどれかと読めたときに呼ぶ。一方向。chat の feature に
 * 置くのは、chat の store を変えるのは chat の feature だけという architecture の規則
 * （`cross-feature-store-mutation`）のため。
 *
 * 閉鎖の状態は 2 か所に置く：`invoke` の手前の局所の拒否は renderer の global の
 * `__grimodexProfileEgressLocalRefusal` に台帳の関数を置く（`profileEgressClosure.ts`。
 * 起動時の `tauri` chunk は global を読むだけで、台帳はこの lazy chunk にある。R25）、
 * 見える control と chat の会話の作成は `useAiSettingsStore` の `profileEgressClosed`
 * （各起動時の chunk が既に import している store。新しい import と export を足さない）。
 * どちらもここで同時に立てる（R23）。
 *
 * 一方向は実行時にも守る（DR-DA2B-R27）：global は書換えも削除も再定義もできない
 * property として 1 回だけ置き、store の欄は true にしかしない。2 回目以降の呼出しと、
 * React の StrictMode の effect の再実行は何も戻さない。
 */
export function closeProfileEgressEntrances(): void {
  if (globalThis.__grimodexProfileEgressLocalRefusal === undefined) {
    Object.defineProperty(globalThis, "__grimodexProfileEgressLocalRefusal", {
      value: profileEgressLocalRefusal,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
  if (useAiSettingsStore.getState().profileEgressClosed !== true) {
    useAiSettingsStore.setState({ profileEgressClosed: true });
  }
}
