import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * sceneBeat ノード内のテキストを除外して本文文字数を集計する。
 * generatedProseBlock 内のテキスト（生成 prose）は含める。
 * 設計書: Beat はプロンプトであって本文ではない（§「本文文字数カウント」）。
 */
export function countSceneBodyChars(doc: PMNode): number {
  let count = 0;
  doc.descendants((node, _pos, parent) => {
    if (node.type.name === "sceneBeat") {
      return false; // サブツリーをスキップ
    }
    if (node.isText && parent?.type.name !== "sceneBeat") {
      count += node.text?.length ?? 0;
    }
    return true;
  });
  return count;
}
