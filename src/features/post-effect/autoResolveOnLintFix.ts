import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAnnotationStore } from "./annotationStore";
import { updateAnnotationStatus } from "./api";
import { parseAnnotationMeta } from "./annotationMeta";
import { resolveAnnotationRange } from "./resolveAnnotationRange";

/**
 * Lint Fix が結果として AI typo annotation の suggestion と完全一致するとき、
 * かつ Fix の置換範囲が annotation の現在位置と重なるとき、その annotation を
 * resolved に自動クローズする。
 *
 * 2 つの条件を AND で要求するのは、別ルール (e.g. halfwidth-fullwidth-mix) が
 * AI typo annotation の範囲内で偶然 Fix を出した場合に、別指摘 (e.g. 助詞欠落)
 * を巻き込んで誤クローズするのを防ぐため。
 *
 * 「Fix 前の doc 位置」を使う必要があるため、必ず `editor.chain().run()` の
 * **前** に候補 ID を集めること (Fix 適用後は textSnapshot がドキュメントから
 * 消えるので resolveAnnotationRange が orphan になる)。
 */
export function collectTypoAnnotationsResolvedByFix(
  sceneId: string,
  preDoc: ProseMirrorNode,
  fixFrom: number,
  fixTo: number,
  replacement: string,
): string[] {
  const annotations =
    useAnnotationStore.getState().annotationsByScene.get(sceneId) ?? [];
  const candidates = annotations.filter(
    (a) => a.status === "open" && a.category === "typo_anchor",
  );
  if (candidates.length === 0) return [];

  const replaceN = strongNormalize(replacement);
  if (!replaceN) return [];

  const matches: string[] = [];
  for (const ann of candidates) {
    const parsed = parseAnnotationMeta(ann);
    if (parsed.kind !== "typo" || !parsed.typo) continue;
    if (strongNormalize(parsed.typo.suggestion) !== replaceN) continue;

    const resolved = resolveAnnotationRange(preDoc, {
      rangeStart: ann.rangeStart,
      rangeEnd: ann.rangeEnd,
      textSnapshot: ann.textSnapshot,
    });
    if (!resolved) continue;
    // overlap: [resolved.from, resolved.to) ∩ [fixFrom, fixTo)
    if (resolved.to <= fixFrom || resolved.from >= fixTo) continue;
    matches.push(ann.id);
  }
  return matches;
}

/**
 * `collectTypoAnnotationsResolvedByFix` の結果を DB / store に反映する。
 * fire-and-forget で呼べる (個別失敗はログに出さず黙って次へ)。
 */
export async function applyAutoResolvedTypos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const localUpdate = useAnnotationStore.getState().updateAnnotationStatus;
  for (const id of ids) {
    try {
      await updateAnnotationStatus(id, "resolved");
      localUpdate(id, "resolved");
    } catch {
      /* ignore individual failure; orphan-state will surface in panel */
    }
  }
}

/**
 * Mirrors Rust `strong_normalize`: 空白・句読点・記号・括弧類を除去し小文字化。
 * 表現揺れ (末尾の句点・大小文字・空白差) を吸収して suggestion と replacement を
 * 同一視するためのキー正規化。
 */
function strongNormalize(s: string): string {
  let out = "";
  for (const ch of s) {
    if (STRIPPABLE.has(ch) || /\s/u.test(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

const STRIPPABLE = new Set<string>([
  // 日本語句読点
  "。",
  "、",
  "．",
  "，",
  "・",
  "：",
  "；",
  "！",
  "？",
  "〜",
  "～",
  "…",
  "‥",
  // 日本語括弧
  "「",
  "」",
  "『",
  "』",
  "（",
  "）",
  "【",
  "】",
  "［",
  "］",
  "〈",
  "〉",
  "《",
  "》",
  "〔",
  "〕",
  "｛",
  "｝",
  "“", // “
  "”", // ”
  "‘", // ‘
  "’", // ’
  // 英語句読点・記号
  ".",
  ",",
  ":",
  ";",
  "!",
  "?",
  "/",
  "\\",
  "|",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  '"',
  "'",
  "`",
  "-",
  "_",
]);
