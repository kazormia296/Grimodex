import type { EditorState } from "@tiptap/pm/state";
import type { ReorderGranularity, ReorderUnit } from "./types";
import { pmPosToFlatOffset, type ResolvedParagraph } from "./paragraphFlat";
import { splitSentences } from "./sentenceSplit";
import { getCachedBunsetsuUnits, isJapanese } from "./bunsetsuSegmenter";

/** 非空の段落内 range 選択を flat 半開区間へ。単一 paragraph 外は null。 */
export function getSelectionFlatRange(
  state: EditorState,
  resolved: ResolvedParagraph,
): { from: number; to: number } | null {
  const { selection } = state;
  if (selection.empty) return null;
  const from = pmPosToFlatOffset(resolved.flat, selection.from);
  const to = pmPosToFlatOffset(resolved.flat, selection.to);
  if (from >= to) return null;
  return { from, to };
}

function offsetUnits(units: ReorderUnit[], offset: number): ReorderUnit[] {
  return units.map((u) => ({
    from: u.from + offset,
    to: u.to + offset,
    surface: u.surface,
  }));
}

/** flat テキスト上の 1 文字ずつ unit。 */
export function splitCharacters(
  text: string,
  from = 0,
  to = text.length,
): ReorderUnit[] {
  const units: ReorderUnit[] = [];
  const end = Math.min(to, text.length);
  for (let i = Math.max(0, from); i < end; i++) {
    const ch = text[i];
    if (ch == null) continue;
    units.push({ from: i, to: i + 1, surface: ch });
  }
  return units;
}

/**
 * 段落 flat 上の [regionFrom, regionTo) を粒度どおり unit 化（絶対 offset）。
 * **必ず領域全体を連続被覆する**（隙間を作らない）。permutation は units 外の
 * テキストを保持しないため、被覆に穴があるとその文字が段落 replace で消失する。
 */
function segmentRegionAbsolute(
  text: string,
  regionFrom: number,
  regionTo: number,
  granularity: ReorderGranularity,
  language: string | undefined,
  fullBunsetsu: ReorderUnit[] | null | undefined,
): ReorderUnit[] {
  if (regionFrom >= regionTo) return [];
  if (granularity === "character") {
    return splitCharacters(text, regionFrom, regionTo);
  }
  if (granularity === "bunsetsu" && fullBunsetsu) {
    // 文節は段落全体をタイルするので、領域境界でクリップすれば領域を連続被覆
    // する（境界を跨ぐ文節は選択端で分割される — 脱落させない）。
    const out: ReorderUnit[] = [];
    for (const u of fullBunsetsu) {
      const from = Math.max(u.from, regionFrom);
      const to = Math.min(u.to, regionTo);
      if (from < to) out.push({ from, to, surface: text.slice(from, to) });
    }
    if (out.length > 0) return out;
    // fullBunsetsu が領域を覆えない異常時は文で連続被覆へフォールバック。
  }
  const slice = text.slice(regionFrom, regionTo);
  return offsetUnits(splitSentences(slice, language), regionFrom);
}

/**
 * 段落の reorder units を構築する。返す units は **常に段落全体を連続被覆する**。
 * - 非空 range 選択時: その区間を 1 unit として強制（override）。前後領域は
 *   同粒度でタイルして被覆する。
 * - 選択なし: 段落全体を粒度どおり分割。
 */
export function buildReorderUnits(
  state: EditorState,
  resolved: ResolvedParagraph,
  granularity: ReorderGranularity,
  language: string | undefined,
  bunsetsuOverride?: ReorderUnit[] | null,
): ReorderUnit[] | null {
  const text = resolved.flat.text;
  const selectionRange = getSelectionFlatRange(state, resolved);

  const bunsetsu =
    granularity === "bunsetsu" && isJapanese(language)
      ? (bunsetsuOverride ?? getCachedBunsetsuUnits(state, language))
      : null;

  // 文節モードで cache miss のときは null を返し、呼び出し側で文へフォールバック
  // させる（文節境界が無いと override の前後を文節でタイルできない）。
  if (granularity === "bunsetsu" && isJapanese(language) && !bunsetsu) {
    return null;
  }

  if (!selectionRange) {
    if (granularity === "character") {
      const units = splitCharacters(text);
      return units.length > 1 ? units : null;
    }
    if (granularity === "bunsetsu" && isJapanese(language)) {
      return bunsetsu && bunsetsu.length > 1 ? bunsetsu : null;
    }
    const units = splitSentences(text, language);
    return units.length > 1 ? units : null;
  }

  const { from: selFrom, to: selTo } = selectionRange;
  const parts: ReorderUnit[] = [];
  parts.push(
    ...segmentRegionAbsolute(text, 0, selFrom, granularity, language, bunsetsu),
  );
  parts.push({
    from: selFrom,
    to: selTo,
    surface: text.slice(selFrom, selTo),
  });
  parts.push(
    ...segmentRegionAbsolute(
      text,
      selTo,
      text.length,
      granularity,
      language,
      bunsetsu,
    ),
  );
  return parts.length > 1 ? parts : null;
}

/** 選択強制 unit か（装飾用）。 */
export function isSelectionOverrideUnit(
  unit: ReorderUnit,
  selectionRange: { from: number; to: number } | null,
): boolean {
  if (!selectionRange) return false;
  return unit.from === selectionRange.from && unit.to === selectionRange.to;
}
