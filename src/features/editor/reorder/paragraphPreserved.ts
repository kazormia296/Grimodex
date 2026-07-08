import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { ParagraphFlat, ReorderUnit } from "./types";
import { flatRangeToPm } from "./paragraphFlat";
import { isEnglishLanguage, needsEnglishSentenceGap } from "./sentenceSplit";

/** inline 直前の flat offset（unit 境界 = 前 unit の to）。 */
export function flatAnchorBeforePm(flat: ParagraphFlat, pmPos: number): number {
  let anchor = 0;
  for (let i = 0; i < flat.flatPmPos.length; i++) {
    if (flat.flatPmPos[i]! >= pmPos) break;
    anchor = i + 1;
  }
  return anchor;
}

/** unit 間ギャップに置かれた非寄与 inline（mention 等）。 */
export interface PreservedInline {
  from: number;
  to: number;
  flatAnchor: number;
}

function isInsideUnitPmRange(
  inlineFrom: number,
  inlineTo: number,
  unitPmRanges: ReadonlyArray<{ from: number; to: number }>,
): boolean {
  for (const range of unitPmRanges) {
    if (inlineFrom >= range.from && inlineTo <= range.to) return true;
  }
  return false;
}

/** paragraph 内の非寄与 inline を flatAnchor 付きで収集（unit 内は slice に含まれるため除外）。 */
export function collectPreservedInlines(
  doc: ProseMirrorNode,
  contentFrom: number,
  contentTo: number,
  flat: ParagraphFlat,
  unitPmRanges: ReadonlyArray<{ from: number; to: number }>,
): PreservedInline[] {
  const preserved: PreservedInline[] = [];
  doc.nodesBetween(contentFrom, contentTo, (node, pos) => {
    if (node.isText || node.type.name === "ruby") return;
    if (!node.isInline) return;
    const from = pos;
    const to = pos + node.nodeSize;
    if (isInsideUnitPmRange(from, to, unitPmRanges)) return false;
    preserved.push({
      from,
      to,
      flatAnchor: flatAnchorBeforePm(flat, from),
    });
    return false;
  });
  return preserved.sort(
    (a, b) => a.flatAnchor - b.flatAnchor || a.from - b.from,
  );
}

/** unit slice と gap inline を「元 unit 境界」に基づいて並べ替え後 Fragment に構築。 */
export function buildPermutedParagraphContent(
  doc: ProseMirrorNode,
  units: ReadonlyArray<ReorderUnit>,
  order: number[],
  unitSlices: ReadonlyArray<{ content: Fragment }>,
  preserved: PreservedInline[],
  language?: string,
): Fragment {
  // 各 preserved inline は元 unit の境界に位置する（flatAnchor = 先行する元 unit
  // 長さの累積）。並べ替え後も「元々その inline が続いていた元 unit」の直後へ置く。
  // 旧実装は flatAnchor を **新順序の累積 offset** と `===` 比較していたため、
  // 入れ替えた 2 unit の長さが異なると境界がずれて inline が一切 append されず、
  // 段落 replace で mention/hardBreak が **無言で消失**していた（データ欠損）。
  const byAnchor = new Map<number, PreservedInline[]>();
  for (const p of preserved) {
    const arr = byAnchor.get(p.flatAnchor);
    if (arr) arr.push(p);
    else byAnchor.set(p.flatAnchor, [p]);
  }

  // 元 unit index j の終端 flat offset（= その直後 inline の flatAnchor）。
  const originalEnd: number[] = [];
  let acc = 0;
  for (let j = 0; j < units.length; j++) {
    acc += units[j]!.to - units[j]!.from;
    originalEnd[j] = acc;
  }

  let combined = Fragment.empty;
  const emitted = new Set<PreservedInline>();
  const appendPreserved = (arr: PreservedInline[] | undefined) => {
    if (!arr) return;
    for (const p of arr) {
      combined = combined.append(doc.slice(p.from, p.to).content);
      emitted.add(p);
    }
  };

  const enGap = isEnglishLanguage(language);
  const gapText = doc.type.schema.text(" ");

  // 先頭（flatAnchor 0 = 元 unit 0 の前）。
  appendPreserved(byAnchor.get(0));
  let prevUnitIdx: number | null = null;
  for (const unitIdx of order) {
    if (
      prevUnitIdx !== null &&
      enGap &&
      needsEnglishSentenceGap(units[prevUnitIdx]!, units[unitIdx]!)
    ) {
      combined = combined.append(Fragment.from(gapText));
    }
    combined = combined.append(unitSlices[unitIdx]!.content);
    // この元 unit の直後に位置していた inline を続けて置く。
    appendPreserved(byAnchor.get(originalEnd[unitIdx]!));
    prevUnitIdx = unitIdx;
  }
  // 防御的フラッシュ: 境界に一致しなかった inline（gap 等の想定外）も
  // 末尾へ必ず出す。欠落（データ欠損）よりは順序ずれの方が遥かに安全。
  for (const p of preserved) {
    if (!emitted.has(p))
      combined = combined.append(doc.slice(p.from, p.to).content);
  }
  return combined;
}

export function unitPmRangesFor(
  flat: ParagraphFlat,
  units: ReadonlyArray<{ from: number; to: number }>,
): { from: number; to: number }[] {
  return units.map((u) => flatRangeToPm(flat, u.from, u.to));
}
