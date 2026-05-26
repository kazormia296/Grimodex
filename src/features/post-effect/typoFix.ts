import type { Editor } from "@tiptap/core";
import { resolveAnnotationRange } from "./resolveAnnotationRange";
import { updateAnnotationStatus } from "./api";
import { useAnnotationStore } from "./annotationStore";
import { parseAnnotationMeta } from "./annotationMeta";
import type { PostEffectAnnotation } from "./types";

export interface ApplyTypoFixResult {
  /** 置換が成立したか (annotation の位置を doc 上で解決できなかった場合は false) */
  applied: boolean;
  /** 置換に使った PM 範囲 */
  range?: { from: number; to: number };
}

/**
 * AI typo annotation の suggestion を本文に適用し、annotation を resolved に閉じる。
 *
 * Lint Fix と同じく `insertContentAt` で置換するため、TipTap の通常の編集 transaction
 * として走る (undo / redo にも乗る)。
 *
 * Lint Fix 経路の auto-resolve (`autoResolveOnLintFix`) と挙動を揃えるため、
 * 置換成功時は明示的に `updateAnnotationStatus(id, "resolved")` を発行する。
 * - 同じ found_text が他にも残っているか / orphan 化したかを問わず resolved 扱い
 *   (ユーザーは「直す」アクションを取った時点で issue 自体を解消したと見做す)
 */
export async function applyTypoFixAndResolve(
  editor: Editor | null,
  ann: PostEffectAnnotation,
): Promise<ApplyTypoFixResult> {
  if (!editor) return { applied: false };
  const parsed = parseAnnotationMeta(ann);
  if (parsed.kind !== "typo" || !parsed.typo) return { applied: false };
  const suggestion = parsed.typo.suggestion;
  if (!suggestion) return { applied: false };

  const resolved = resolveAnnotationRange(editor.state.doc, {
    rangeStart: ann.rangeStart,
    rangeEnd: ann.rangeEnd,
    textSnapshot: ann.textSnapshot,
  });
  if (!resolved) return { applied: false };

  editor
    .chain()
    .focus()
    .insertContentAt({ from: resolved.from, to: resolved.to }, suggestion)
    .run();

  try {
    await updateAnnotationStatus(ann.id, "resolved");
    useAnnotationStore.getState().updateAnnotationStatus(ann.id, "resolved");
  } catch {
    /* DB エラー時も置換自体は完了しているので applied:true で返す */
  }

  return { applied: true, range: resolved };
}
