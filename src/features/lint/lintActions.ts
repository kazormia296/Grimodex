import type { Editor } from "@tiptap/core";
import i18next from "@/lib/i18n";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import {
  applyAutoResolvedTypos,
  collectTypoAnnotationsResolvedByFix,
} from "@/features/post-effect/autoResolveOnLintFix";
import type { Diagnostic } from "./types";
import { useLintStore } from "./lintStore";
import { runLintNow } from "./useLinter";

/**
 * lintActions.ts — lint diagnostic への操作（ジャンプ / Fix 適用 / 一括 Fix）を
 * 校閲トリアージ（kouetsu/triage）から呼ぶ共有モジュール。
 * - Fix は inline AI pending 中はガードで no-op
 * - Fix 前の doc で typo annotation の auto-resolve 候補を収集（適用後は
 *   textSnapshot がずれ resolveAnnotationRange が orphan になるため）
 * - Fix により lint 無効化 directive が消えた場合は通知
 * - 適用後は現在シーンを再 lint
 */

/** diagnostic の範囲を選択してスクロールする（現在シーンの doc 前提）。 */
export function jumpToDiagnostic(editor: Editor, d: Diagnostic): void {
  const map = buildOffsetMap(editor.state.doc);
  const from = strOffsetToPmPos(map, d.range.start);
  const to = strOffsetToPmPos(map, d.range.end);
  if (from == null || to == null) return;
  editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
}

/** 単一 Fix を適用する。 */
export function applyLintFix(
  editor: Editor,
  sceneId: string | null,
  d: Diagnostic,
): void {
  if (!d.fix) return;
  if (guardInlineAiPending()) return;
  const before = buildOffsetMap(editor.state.doc);
  const from = strOffsetToPmPos(before, d.fix.range.start);
  const to = strOffsetToPmPos(before, d.fix.range.end);
  if (from == null || to == null) return;
  const beforeDisableCount = before.disables.length;
  // AI typo annotation の auto-resolve 候補は Fix 適用前の doc/位置を必須とする
  const autoResolveIds = sceneId
    ? collectTypoAnnotationsResolvedByFix(
        sceneId,
        editor.state.doc,
        from,
        to,
        d.fix.replacement,
      )
    : [];
  editor.chain().focus().insertContentAt({ from, to }, d.fix.replacement).run();
  // Fix 結果として disable directive が消滅した場合は 1 回だけ通知する。
  const afterDisableCount = buildOffsetMap(editor.state.doc).disables.length;
  const removed = beforeDisableCount - afterDisableCount;
  if (removed > 0) {
    useLintStore.getState().pushNotification(
      i18next.t("lint.fix.disablesRemoved", {
        count: removed,
        defaultValue:
          "Fix 適用により {{count}} 件の Lint 無効化が削除されました",
      }),
    );
  }
  if (autoResolveIds.length > 0) {
    void applyAutoResolvedTypos(autoResolveIds, editor, sceneId);
  }
  if (sceneId) {
    void runLintNow(editor, sceneId);
  }
}

/**
 * 一括 Fix。range.start 降順で 1 transaction に畳む（先頭側のオフセットが
 * 後続の置換でずれないように）。
 */
export function applyAllLintFixes(
  editor: Editor,
  sceneId: string | null,
  diagnostics: Diagnostic[],
): void {
  if (guardInlineAiPending()) return;
  const withFix = diagnostics.filter((d) => d.fix);
  if (withFix.length === 0) return;
  const map = buildOffsetMap(editor.state.doc);
  const beforeDisableCount = map.disables.length;
  const sorted = [...withFix].sort(
    (a, b) => b.fix!.range.start - a.fix!.range.start,
  );
  // 適用前 doc で全 Fix の auto-resolve 候補を集める（Fix 後は textSnapshot が
  // ずれて resolveAnnotationRange が orphan を返すため）。
  const preDoc = editor.state.doc;
  const autoResolveIds: string[] = [];
  if (sceneId) {
    for (const d of sorted) {
      const from = strOffsetToPmPos(map, d.fix!.range.start);
      const to = strOffsetToPmPos(map, d.fix!.range.end);
      if (from == null || to == null) continue;
      autoResolveIds.push(
        ...collectTypoAnnotationsResolvedByFix(
          sceneId,
          preDoc,
          from,
          to,
          d.fix!.replacement,
        ),
      );
    }
  }
  let chain = editor.chain().focus();
  for (const d of sorted) {
    const from = strOffsetToPmPos(map, d.fix!.range.start);
    const to = strOffsetToPmPos(map, d.fix!.range.end);
    if (from == null || to == null) continue;
    chain = chain.insertContentAt({ from, to }, d.fix!.replacement);
  }
  chain.run();
  const afterDisableCount = buildOffsetMap(editor.state.doc).disables.length;
  const removed = beforeDisableCount - afterDisableCount;
  if (removed > 0) {
    useLintStore.getState().pushNotification(
      i18next.t("lint.fix.disablesRemovedBulk", {
        count: removed,
        defaultValue:
          "一括 Fix 適用により {{count}} 件の Lint 無効化が削除されました",
      }),
    );
  }
  if (autoResolveIds.length > 0) {
    void applyAutoResolvedTypos([...new Set(autoResolveIds)], editor, sceneId);
  }
  if (sceneId) void runLintNow(editor, sceneId);
}
