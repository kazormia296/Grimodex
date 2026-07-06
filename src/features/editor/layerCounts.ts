import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * doc 内の mark を「連続 run」単位で数える。
 * 隣接する text ノードにまたがる同種 mark は 1 と数え、ブロック境界で
 * run は切れる。本文レイヤーポップオーバーの件数バッジ用の近似値
 * （厳密な「注釈エンティティ数」ではなく、本文中の見た目上のまとまり数）。
 */
export function countMarkRuns(
  doc: ProseMirrorNode,
  markNames: readonly string[],
): number {
  const names = new Set(markNames);
  let count = 0;
  let prevHad = false;
  doc.descendants((node) => {
    if (!node.isText) {
      // ブロック/インラインatom 境界で run を切る
      prevHad = false;
      return true;
    }
    const has = node.marks.some((m) => names.has(m.type.name));
    if (has && !prevHad) count++;
    prevHad = has;
    return true;
  });
  return count;
}
