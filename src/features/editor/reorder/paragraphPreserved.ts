import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { ParagraphFlat } from "./types";
import { flatRangeToPm } from "./paragraphFlat";

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

/** unit slice と gap inline を flatAnchor 位置に挿入して並べ替え後 Fragment を構築。 */
export function buildPermutedParagraphContent(
  doc: ProseMirrorNode,
  units: ReadonlyArray<{ from: number; to: number }>,
  order: number[],
  unitSlices: ReadonlyArray<{ content: Fragment }>,
  preserved: PreservedInline[],
): Fragment {
  let combined = Fragment.empty;
  let preservedIdx = 0;
  let flatCursor = 0;

  const flushPreserved = (anchor: number) => {
    while (
      preservedIdx < preserved.length &&
      preserved[preservedIdx]!.flatAnchor === anchor
    ) {
      const p = preserved[preservedIdx]!;
      combined = combined.append(doc.slice(p.from, p.to).content);
      preservedIdx++;
    }
  };

  flushPreserved(0);
  for (const unitIdx of order) {
    combined = combined.append(unitSlices[unitIdx]!.content);
    flatCursor += units[unitIdx]!.to - units[unitIdx]!.from;
    flushPreserved(flatCursor);
  }
  return combined;
}

export function unitPmRangesFor(
  flat: ParagraphFlat,
  units: ReadonlyArray<{ from: number; to: number }>,
): { from: number; to: number }[] {
  return units.map((u) => flatRangeToPm(flat, u.from, u.to));
}
