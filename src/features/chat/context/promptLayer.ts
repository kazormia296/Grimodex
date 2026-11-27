import { PROMPT_RESERVED_TAG_NAMES } from "@/prompts/shared/dataLayerRegistry";

// 予約タグ名の開閉タグ風文字列 (大文字小文字・空白変種を含む) を導く `<`。
// データ内に閉じタグが混入するとブロック境界の終了を偽装できるため、`<` の
// 直後に `\` を挿入して無害化する。挿入後は `<` の次が `\` になり再マッチ
// しない (冪等)。`<note>` `<sticky>` `<map>` は予約外なので素通しになる。
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RESERVED_TAG_RE = new RegExp(
  `<(?=\\s*\\/?\\s*(?:${PROMPT_RESERVED_TAG_NAMES.map(escapeRegex).join("|")})\\b)`,
  "gi",
);

/** データ内の予約タグ偽装をエスケープする (`</current_scene>` → `<\/current_scene>`)。 */
export function escapeReservedTags(text: string): string {
  return text.replace(RESERVED_TAG_RE, "<\\");
}

/**
 * trim 済みのレイヤーテキストを予約タグで包む。空白のみなら空文字を返し、
 * 空レイヤーに `<story_so_far></story_so_far>` のような空ブロックを出さない。
 */
export function wrapPromptLayer(text: string, tag: string): string {
  if (!text.trim()) return "";
  const escaped = escapeReservedTags(text);
  const body = escaped.startsWith("\n") ? escaped.slice(1) : escaped;
  return `\n<${tag}>\n${body}\n</${tag}>`;
}

export function wrapDataLayer(text: string, tag: string): string {
  return wrapPromptLayer(text, tag);
}
