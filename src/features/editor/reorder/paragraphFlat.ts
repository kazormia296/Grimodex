import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { ParagraphFlat } from "./types";

/**
 * 単一 paragraph ノードを codexDocFlatten と同一規約で flatten する。
 * `contentFrom` は paragraph 内容先頭の doc 絶対 PM 位置。
 */
export function flattenParagraph(
  node: ProseMirrorNode,
  contentFrom: number,
): ParagraphFlat {
  let text = "";
  const flatPmPos: number[] = [];
  const flatIsRuby: boolean[] = [];

  node.forEach((child, offset) => {
    const absStart = contentFrom + offset;
    if (child.type.name === "ruby") {
      const base = (child.attrs.base as string) ?? "";
      for (let i = 0; i < base.length; i++) {
        flatPmPos.push(absStart);
        flatIsRuby.push(true);
      }
      text += base;
      return;
    }
    if (child.isText) {
      const t = child.text ?? "";
      for (let i = 0; i < t.length; i++) {
        flatPmPos.push(absStart + i);
        flatIsRuby.push(false);
      }
      text += t;
    }
    // mention / hardBreak 等の atom は非寄与。
  });

  return { text, flatPmPos, flatIsRuby };
}

/** flat offset 半開区間 [from, to) → PM 半開区間。 */
export function flatRangeToPm(
  flat: ParagraphFlat,
  from: number,
  to: number,
): { from: number; to: number } {
  if (from >= to || from < 0 || to > flat.text.length) {
    throw new RangeError("invalid flat range");
  }
  const pmFrom = flat.flatPmPos[from]!;
  const pmLast = flat.flatPmPos[to - 1]!;
  return { from: pmFrom, to: pmLast + 1 };
}

/** PM 位置が指す flat offset（最も近い slot）。 */
export function pmPosToFlatOffset(flat: ParagraphFlat, pmPos: number): number {
  const idx = flat.flatPmPos.findIndex((p) => p >= pmPos);
  if (idx === -1) return flat.text.length;
  if (idx === 0) return 0;
  const prev = flat.flatPmPos[idx - 1]!;
  const curr = flat.flatPmPos[idx]!;
  return pmPos - prev <= curr - pmPos ? idx - 1 : idx;
}

export interface ResolvedParagraph {
  /** paragraph ノードの開始 PM 位置。 */
  pos: number;
  node: ProseMirrorNode;
  /** paragraph 内容の PM 半開区間 [contentFrom, contentTo)。 */
  contentFrom: number;
  contentTo: number;
  flat: ParagraphFlat;
}

/** 選択位置を含む最上位 paragraph を解決する。対象外なら null。 */
export function resolveParagraphAtSelection(
  state: EditorState,
): ResolvedParagraph | null {
  const { $from, $to } = state.selection;
  if ($from.depth === 0) return null;
  if ($from.index(0) !== $to.index(0)) return null;

  let blockPos = 0;
  const index = $from.index(0);
  const doc = state.doc;
  for (let i = 0; i < index; i++) blockPos += doc.child(i).nodeSize;
  const node = doc.child(index);
  if (node.type.name !== "paragraph") return null;

  const contentFrom = blockPos + 1;
  const contentTo = blockPos + node.nodeSize - 1;
  return {
    pos: blockPos,
    node,
    contentFrom,
    contentTo,
    flat: flattenParagraph(node, contentFrom),
  };
}
