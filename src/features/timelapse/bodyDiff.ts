/**
 * 執筆タイムラプス: Codex / Snippet / Map 本文の「変更差分」を記録するための
 * compact な diff を作る。
 *
 * 設計意図:
 * - これらの update イベントは replayEngine の canvas 再生対象ではなく、
 *   TimelapsePlayer のインスペクタ表示用 (payload JSON)。よってフォーマットは
 *   自由で、人が読める生テキストの diff を採用する (diff-match-patch の patch
 *   形式は日本語を %xx エンコードして読めなくなるため使わない)。
 * - 本文 (Codex content / Snippet content / Map sticky body) は ProseMirror
 *   JSON で保存されているため、生 JSON を diff するとノイズだらけで読めない。
 *   `computeDocDiff` で**プレーンテキストを抽出してから** diff する。Codex
 *   summary はプレーンテキストなので `computeBodyDiff` を直接使う。
 * - payload は hash chain / snapshot / zip export に焼かれるため、サイズを
 *   「変更量」に比例させる: 変更されていない地の文 (等価 run) は変更箇所周辺の
 *   `EQ_CONTEXT` 字へ切り詰め、巨大な変更は `MAX_TOTAL_CHARS` で truncate する。
 *   これにより 5KB のノートの 1 文修正は文書サイズに依らず ~100B で済む。
 * - 切り詰め・テキスト抽出により完全な復元はできないが、これらは再生に使われ
 *   ないので可。書式 (太字/見出し等) の変更はテキスト diff には現れない。
 */

import DiffMatchPatch from "diff-match-patch";

/** -1 = 削除, 0 = 等価(変更なし), 1 = 挿入。 */
export type DiffOp = -1 | 0 | 1;
export type DiffSegment = [DiffOp, string];

export interface BodyDiff {
  segments: DiffSegment[];
  /** サイズ上限超過で末尾を切り捨てた場合に true。 */
  truncated?: boolean;
}

/** 変更箇所の前後に残す等価テキストの文字数。 */
const EQ_CONTEXT = 24;
/** payload に載せる diff テキスト総量の上限 (文字数)。 */
const MAX_TOTAL_CHARS = 8000;
/** この長さを超える等価 run のみ切り詰める (マーカー分の余裕込み)。 */
const EQ_TRIM_THRESHOLD = EQ_CONTEXT * 2 + 8;

const dmp = new DiffMatchPatch();

interface PmNode {
  text?: string;
  content?: PmNode[];
}

/**
 * ProseMirror JSON 文字列からプレーンテキストを抽出する。プレーンテキストが
 * 渡された場合 (JSON でない) は空文字を返す — 本関数は PM JSON フィールド専用。
 * パース失敗時も空文字 (extractTextFromProseMirror と同じ防御契約)。
 */
export function extractDocText(json: string | null | undefined): string {
  if (!json) return "";
  let parsed: PmNode;
  try {
    parsed = JSON.parse(json) as PmNode;
  } catch {
    return "";
  }
  const out: string[] = [];
  const walk = (node: PmNode) => {
    if (typeof node.text === "string") out.push(node.text);
    if (node.content) node.content.forEach(walk);
  };
  walk(parsed);
  return out.join("");
}

/**
 * `before` → `after` の差分を返す。変化が無ければ null。
 * 引数は null/undefined を空文字として扱う。プレーンテキスト同士に使う
 * (Codex summary など)。
 */
export function computeBodyDiff(
  before: string | null | undefined,
  after: string | null | undefined,
): BodyDiff | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a === b) return null;

  const raw = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(raw);

  // 1) 長い等価 run を変更箇所周辺のコンテキストへ切り詰める。
  //    先頭 run は末尾側、末尾 run は先頭側 (= 変更に隣接する側) を残す。
  const trimmed: DiffSegment[] = raw.map(([op, text], i) => {
    const o = op as DiffOp;
    if (o === 0 && text.length > EQ_TRIM_THRESHOLD) {
      const head = i === 0 ? "" : text.slice(0, EQ_CONTEXT);
      const tail = i === raw.length - 1 ? "" : text.slice(-EQ_CONTEXT);
      const omitted = text.length - head.length - tail.length;
      return [0, `${head}…(${omitted})…${tail}`];
    }
    return [o, text];
  });

  // 2) 総量上限。超えたら末尾を切って truncated を立てる。
  const segments: DiffSegment[] = [];
  let total = 0;
  let truncated = false;
  for (const [op, text] of trimmed) {
    if (total + text.length > MAX_TOTAL_CHARS) {
      const room = MAX_TOTAL_CHARS - total;
      if (room > 0) segments.push([op, text.slice(0, room)]);
      truncated = true;
      break;
    }
    segments.push([op, text]);
    total += text.length;
  }

  return truncated ? { segments, truncated: true } : { segments };
}

/**
 * ProseMirror JSON 同士の本文差分。両側からテキストを抽出してから diff する。
 * Codex content / Snippet content / Map sticky body に使う。
 */
export function computeDocDiff(
  beforeJson: string | null | undefined,
  afterJson: string | null | undefined,
): BodyDiff | null {
  return computeBodyDiff(extractDocText(beforeJson), extractDocText(afterJson));
}
