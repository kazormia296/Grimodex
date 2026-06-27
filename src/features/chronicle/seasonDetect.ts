/**
 * 季節名 → 季節を示す語（synonym）の既定辞書。
 * キーは「暦の季節名」と一致する想定（春夏秋冬 / spring..winter）。暦が独自名なら
 * synonym は効かず、季節名そのものの substring 一致のみが効く（honest な縮退）。
 */
export const DEFAULT_SEASON_SYNONYMS: Record<string, string[]> = {
  春: ["桜", "花見", "新緑", "梅の花"],
  夏: ["蝉", "梅雨", "海水浴", "向日葵", "猛暑"],
  秋: ["紅葉", "落ち葉", "稲刈り", "枯葉"],
  冬: ["雪", "木枯らし", "氷", "霜", "雪景色"],
  spring: ["cherry blossom", "vernal", "blossom"],
  summer: ["cicada", "heatwave", "midsummer"],
  autumn: ["foliage", "harvest", "autumnal"],
  fall: ["foliage", "harvest"],
  winter: ["snow", "frost", "blizzard"],
};

/** ASCII(ラテン)語か。語境界(\b)一致を使うかどうかの判定。 */
function isAsciiNeedle(w: string): boolean {
  return /^[\x20-\x7e]+$/.test(w);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * テキスト中に現れる季節を検出する純関数。
 * - seasonNames(暦の季節名)の一致。
 * - synonyms[seasonName] の各語が現れ、かつその seasonName が seasonNames にあれば加える。
 * - ASCII/ラテン語は語境界(\b)一致・大小無視（fall が waterfall/fallen、snow が
 *   Snowden 等に誤反応しない）。CJK(単漢字含む)は substring 一致。決定性: 乱数/時刻なし。
 */
export function detectSeasons(
  text: string,
  seasonNames: string[],
  synonyms: Record<string, string[]> = DEFAULT_SEASON_SYNONYMS,
): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  const has = (needle: string) => {
    if (isAsciiNeedle(needle)) {
      return new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i").test(text);
    }
    return text.includes(needle);
  };

  for (const name of seasonNames) {
    if (has(name)) found.add(name);
  }
  for (const name of seasonNames) {
    if (found.has(name)) continue;
    for (const syn of synonyms[name] ?? []) {
      if (has(syn)) {
        found.add(name);
        break;
      }
    }
  }
  return found;
}
