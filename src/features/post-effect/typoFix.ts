import type { Editor } from "@tiptap/core";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { aiAuthorshipAttrs } from "@/features/attribution/aiAuthorship";
import { resolveAnnotationRange } from "./resolveAnnotationRange";
import { updateAnnotationStatus } from "./api";
import { useAnnotationStore } from "./annotationStore";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import { parseAnnotationMeta } from "./annotationMeta";
import { useTreeStore } from "@/features/tree/treeStore";
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
  // 未確定の inline-AI diff があるなら本文置換を弾く (B1 plugin lock の上の明示ガード
  // ＝ owner 以外/将来の DB 直経路も含め toast 付きで止める)。
  if (guardInlineAiPending()) return { applied: false };
  // AI 提案テキストの本文適用は bodyWrite アクション。policy=off のプロジェクト
  // では弾く (security audit AI-1)。決定論的な「ローカル検出」の applyFix は
  // AI 出力ではないため別経路として gate しない。
  if (blockIfPolicyOff("bodyWrite")) return { applied: false };
  if (blockIfUnlicensed()) return { applied: false };
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

  // The suggestion is AI-generated; tag the replacement source='ai' so it is
  // not mis-counted as human in authorship_spans / loadBatchAiRatio. plain text
  // occupies [from, from+suggestion.length) after the replace. programmaticInsert
  // keeps AiEditedPlugin from splitting the mark on this transaction.
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      return true;
    })
    .insertContentAt({ from: resolved.from, to: resolved.to }, suggestion)
    .setTextSelection({
      from: resolved.from,
      to: resolved.from + suggestion.length,
    })
    .setMark("authorship", aiAuthorshipAttrs())
    .run();

  try {
    await updateAnnotationStatus(
      ann.id,
      "resolved",
      useTreeStore.getState().projectId ?? "",
    );
  } catch {
    /* DB エラー時も置換自体は完了しているので applied:true で返す */
  }
  useAnnotationStore.getState().updateAnnotationStatus(ann.id, "resolved");

  // 置換で text snapshot が消えるので元の mark は既にエディタから外れているが、
  // 「同じ文字列が他の場所にもあって別 annotation で underline されていた」
  // 等のケースを綺麗にするため一度 refresh する。
  if (ann.sceneId) {
    const next =
      useAnnotationStore.getState().annotationsByScene.get(ann.sceneId) ?? [];
    applyAnnotationsToEditor(editor, next);
  }

  return { applied: true, range: resolved };
}
