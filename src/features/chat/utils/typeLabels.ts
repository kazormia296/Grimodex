import i18next from "@/lib/i18n";

/** Codex type slug → localized label lookup map (keyed to codex.* locale keys) */
const TYPE_LABEL_KEYS: Record<string, string> = {
  character: "codex.character",
  location: "codex.location",
  item: "codex.item",
  lore: "codex.lore",
};

/** type 文字列をローカライズ済みラベルに変換。未知の type はそのまま返す */
export function getTypeLabel(type: string): string {
  const key = TYPE_LABEL_KEYS[type];
  return key ? i18next.t(key) : type;
}
