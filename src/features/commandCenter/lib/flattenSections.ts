import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

/**
 * sections を flat な items 配列に展開する。空 section は items を 0 個寄与する。
 * Section header 自体は UI 側が描画するため、ここでは items のみを並べる。
 *
 * キーボード操作 (↑↓ で selectedIndex を移動) や Enter での実行に使う。
 */
export function flattenSections(
  sections: readonly CommandCenterSection[],
): CommandCenterItem[] {
  const items: CommandCenterItem[] = [];
  for (const section of sections) {
    for (const item of section.items) items.push(item);
  }
  return items;
}
