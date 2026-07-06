import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** doc 内の配置済みビート (sceneBeat ノード) を数える。 */
export function countPlacedBeats(doc: ProseMirrorNode | null): number {
  if (!doc) return 0;
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "sceneBeat") {
      count++;
      return false;
    }
    return true;
  });
  return count;
}

/**
 * トップレベル位置 pos にあるノードの「本文 ¶n」番号を返す。
 * n = pos より前に完結しているトップレベル textblock の数 + 1
 * （= そのビートが次に係る段落の番号）。sceneBeat 自身や scene-break
 * などの非 textblock ノードは数えない。
 */
export function paragraphOrdinalAtPos(
  doc: ProseMirrorNode,
  pos: number,
): number {
  let ordinal = 0;
  doc.forEach((child, offset) => {
    if (offset + child.nodeSize <= pos && child.isTextblock) {
      ordinal++;
    }
  });
  return ordinal + 1;
}
