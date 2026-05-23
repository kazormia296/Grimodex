import type { Node as PMNode } from "@tiptap/pm/model";

interface PmJsonNode {
  type?: string;
  text?: string;
  content?: PmJsonNode[];
}

/**
 * ProseMirror JSON から本文文字数を集計する（Editor インスタンス不要）。
 * sceneBeat 内テキストは countSceneBodyChars と同様に除外する。
 */
export function countSceneBodyCharsFromJson(json: string | PmJsonNode): number {
  const doc =
    typeof json === "string" ? (JSON.parse(json) as PmJsonNode) : json;
  let count = 0;

  function walk(node: PmJsonNode, parentType: string | null): void {
    if (node.type === "sceneBeat") return;
    if (node.type === "text" && parentType !== "sceneBeat") {
      count += node.text?.length ?? 0;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child, node.type ?? null);
      }
    }
  }

  walk(doc, null);
  return count;
}

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
