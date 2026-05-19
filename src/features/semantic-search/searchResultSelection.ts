/**
 * セマンティック検索 Dialog の結果リスト用キーボード選択 index 計算。
 * 結果 0 件のときは null (呼び出し側でキー操作を無視する)。
 */
export function nextSearchResultIndex(
  current: number,
  direction: "up" | "down",
  resultCount: number,
): number | null {
  if (resultCount <= 0) return null;
  if (direction === "down") {
    return Math.min(current + 1, resultCount - 1);
  }
  return Math.max(current - 1, 0);
}
