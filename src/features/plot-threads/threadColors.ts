import { activeCodexPaletteSlots } from "@/lib/resolveCodexColors";

/**
 * 一括追加（AI 抽出取り込み等）するスレッドに、Codex タイプと同じパレットから
 * 色を散らして割り当てる。返すのはスロットの `fg`（スレッド色ピッカーと同じ値）。
 *
 * 既存スレッド数を起点にローテーションするので
 *  (1) 取り込みバッチ内で色が重ならず（パレット 1 周分までは全部別色）、
 *  (2) 直前までに使っていた色ともずれる。
 *
 * 色を割り当てないと（color=null）描画時に全スレッドが同じ `--primary` へ
 * 潰れて見分けが付かなくなるのを防ぐのが目的。
 */
export function spreadThreadColors(
  count: number,
  existingCount: number,
  themeId: string | undefined,
  isDark: boolean,
): string[] {
  const slots = activeCodexPaletteSlots(themeId, isDark);
  return Array.from(
    { length: Math.max(0, count) },
    (_, i) => slots[(existingCount + i) % slots.length].fg,
  );
}
