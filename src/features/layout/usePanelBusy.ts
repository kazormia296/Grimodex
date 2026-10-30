import { useAnyPostEffectRunning } from "@/features/post-effect/runStore";
import type { PanelId } from "./panelIds";

/**
 * パネルが裏で処理中か。閉じていても分かるよう、Stripe のアイコンと
 * オーバーレイの rail のつまみが同じ判定で印（ドットバッジ）を出す。
 *
 * 今は校閲 (post-effect) 実行中の kouetsu だけ。他パネルへ広げる時はここを map 化する。
 */
export function usePanelBusy(panelId: PanelId): boolean {
  const anyPostEffectRunning = useAnyPostEffectRunning();
  return panelId === "kouetsu" && anyPostEffectRunning;
}
