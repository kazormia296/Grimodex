/**
 * 作中年表の複数選択の遷移を純関数で決める（クリック＋修飾キー）。
 * 決定性: 乱数/時刻/IO なし。store と分離してロジックを単体テスト可能にする。
 */

export interface SelectionState {
  /** プライマリ選択（範囲選択のアンカー / Inspector 対象）。 */
  selectedEventId: string | null;
  /** 選択集合（プライマリを含む）。 */
  selectedEventIds: string[];
}

export interface SelectMods {
  /** Ctrl/⌘=選択集合へトグル。 */
  toggle: boolean;
  /** Shift=アンカー〜id を範囲選択。 */
  range: boolean;
}

/**
 * クリック選択の次状態を返す。
 * - range(Shift) かつアンカーあり: timeOrderedIds 上の アンカー〜id 区間（両端含む）。
 * - toggle(Ctrl/⌘): 集合へ id をトグル（追加ならプライマリ=id、除去なら残りの末尾）。
 * - いずれでもない（修飾なし/アンカー無しの範囲）: 単一選択 [id]。
 */
export function nextSelection(
  cur: SelectionState,
  id: string,
  mods: SelectMods,
  timeOrderedIds: string[],
): { ids: string[]; primary: string | null } {
  if (mods.range && cur.selectedEventId) {
    const ia = timeOrderedIds.indexOf(cur.selectedEventId);
    const ib = timeOrderedIds.indexOf(id);
    if (ia !== -1 && ib !== -1) {
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      return { ids: timeOrderedIds.slice(lo, hi + 1), primary: id };
    }
  }
  if (mods.toggle) {
    const has = cur.selectedEventIds.includes(id);
    const ids = has
      ? cur.selectedEventIds.filter((x) => x !== id)
      : [...cur.selectedEventIds, id];
    return { ids, primary: has ? (ids[ids.length - 1] ?? null) : id };
  }
  return { ids: [id], primary: id };
}
