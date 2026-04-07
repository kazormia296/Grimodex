/** Codex entry type → 日本語ラベル の共有マップ */
export const TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定",
};

/** type 文字列を日本語ラベルに変換。未知の type はそのまま返す */
export function getTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}
