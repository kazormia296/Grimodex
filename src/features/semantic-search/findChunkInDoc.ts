import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * `findChunkInDoc` の戻り値。ProseMirror の position 区間
 * ([from, to) — `to` は exclusive)。
 */
export interface FoundRange {
  from: number;
  to: number;
}

/**
 * PM doc 内で `chunkText` の先頭 line をプレーンテキスト一致で探し、
 * 見つかれば PM position 区間を返す (MVP 仕様: §3.6)。
 *
 * 戦略:
 * - chunkText は Rust 側で `paragraphs.join("\n")` から切り出されているため
 *   段落跨ぎの `\n` を含む。PM doc のテキストには `\n` が無い (段落 node が
 *   分かれているだけ) ので、まず chunkText の先頭 `\n` までで切る。
 * - その先頭 line の最大 60 文字を search prefix に使う。短すぎる (4 文字未満)
 *   ものは誤マッチを誘発するため無視。
 * - PM doc を descend して全 text node を flat な文字列に連結 (mark で割れた
 *   node も連続として扱う)。各文字 index ↔ PM position のマップを並行で作る。
 * - `indexOf(prefix)` で先頭一致箇所を見つけ、PM range に変換して返す。
 *
 * 見つからない場合 (本文編集で chunk が消えた、prefix が短すぎる、空 doc 等)
 * は `null`。呼び出し側はスクロール無しでシーンを開くだけにフォールバックする。
 */
export function findChunkInDoc(
  doc: PMNode,
  chunkText: string,
): FoundRange | null {
  const prefix = makeSearchPrefix(chunkText);
  if (!prefix) return null;
  const { flatText, flatToPm } = flattenTextNodes(doc);
  if (flatText.length === 0) return null;
  const idx = flatText.indexOf(prefix);
  if (idx === -1) return null;
  const from = flatToPm[idx];
  const lastCharIdx = idx + prefix.length - 1;
  const safeEnd = Math.min(lastCharIdx, flatToPm.length - 1);
  const to = flatToPm[safeEnd] + 1; // PM range: to は exclusive
  return { from, to };
}

const MAX_PREFIX_CHARS = 60;
const MIN_PREFIX_CHARS = 4;

function makeSearchPrefix(chunkText: string): string {
  const firstNl = chunkText.indexOf("\n");
  const line = firstNl >= 0 ? chunkText.slice(0, firstNl) : chunkText;
  const trimmed = line.trim();
  if (trimmed.length < MIN_PREFIX_CHARS) return "";
  return trimmed.slice(0, MAX_PREFIX_CHARS);
}

interface FlattenResult {
  flatText: string;
  /** flatText 上の char index → PM position の写像。長さ = flatText.length。 */
  flatToPm: number[];
}

function flattenTextNodes(doc: PMNode): FlattenResult {
  const flatChars: string[] = [];
  const flatToPm: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      const t = node.text ?? "";
      for (let i = 0; i < t.length; i++) {
        flatChars.push(t[i]);
        flatToPm.push(pos + i);
      }
    }
    return true;
  });
  return { flatText: flatChars.join(""), flatToPm };
}
