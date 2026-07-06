import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { ANNOTATION_REBUILD_META } from "@/features/post-effect/AnnotationPlugin";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";
import { GUTTER_REBUILD_META } from "./GutterMarksPlugin";
import { LINT_REBUILD_META } from "./LintDecorationPlugin";

/**
 * 本文レイヤーのパネル連動 (Auto) モード。
 * layerAutoFollow ON の間、対応パネルの可視状態にレイヤー表示を完全追従させる:
 *   kouetsu パネル → 校閲の指摘 (校閲+Lint) と読者コメント
 *   codex パネル → Codex ハイライト
 *   attribution パネル → 帰属ハイライト
 *   foreshadow パネル → 伏線マーク
 * （コメントレイヤーは対応パネルがないため手動のまま。）
 *
 * 自動追従は persist:false で設定 (display.layer*) を書き換えない —
 * 手動基準値は保存されたまま残り、Auto OFF 復帰時に initFromSettings で戻す。
 * Auto 中の手動トグルも可能で、次のパネル可視状態の変化までの一時上書きになる
 * (useMapBoardAutoActivate と同じ完全追従セマンティクス)。
 */
export function useLayerAutoFollow(editor: Editor | null): void {
  const enabled = useCursorSettingsStore((s) => s.layerAutoFollow);
  const kouetsuActive = useLayoutStore((s) => s.isPanelActive("kouetsu"));
  const codexActive = useLayoutStore((s) => s.isPanelActive("codex"));
  const attributionActive = useLayoutStore((s) =>
    s.isPanelActive("attribution"),
  );
  const foreshadowActive = useLayoutStore((s) => s.isPanelActive("foreshadow"));

  // 追従: パネル可視状態が変わるたびランタイム状態へ反映（設定には書かない）。
  // decoration plugin はストアを build 時に読むだけなので、切替を反映させる
  // には各レイヤーの rebuild meta を dispatch する必要がある（LayersPopover の
  // トグルと同じ規約）。attribution は useAttribution、Codex は
  // useCodexHighlight がストア購読で自前 dispatch するため meta 不要。
  useEffect(() => {
    if (!enabled) return;
    const dispatchMeta = (meta: string) => {
      if (!editor || editor.isDestroyed || !editor.view) return;
      editor.view.dispatch(editor.state.tr.setMeta(meta, true));
    };
    const annotation = useAnnotationStore.getState();
    annotation.setShowAnnotations(kouetsuActive, { persist: false });
    annotation.setShowReaderComments(kouetsuActive, { persist: false });
    useCursorSettingsStore.getState().setShowLint(kouetsuActive, {
      persist: false,
    });
    dispatchMeta(ANNOTATION_REBUILD_META);
    dispatchMeta(LINT_REBUILD_META);
    useCursorSettingsStore
      .getState()
      .setShowForeshadowMarks(foreshadowActive, { persist: false });
    dispatchMeta(GUTTER_REBUILD_META);
    useAttributionStore
      .getState()
      .setShowAttribution(attributionActive, { persist: false });
    useCodexHighlightStore.getState().setEnabled(codexActive, {
      persist: false,
    });
  }, [
    enabled,
    editor,
    kouetsuActive,
    codexActive,
    attributionActive,
    foreshadowActive,
  ]);

  // OFF 復帰: 保存済み設定 (手動基準値) にランタイム状態を戻す
  const prevEnabled = useRef(enabled);
  useEffect(() => {
    if (prevEnabled.current && !enabled) {
      useAnnotationStore.getState().initFromSettings();
      useCursorSettingsStore.getState().initFromSettings();
      useAttributionStore.getState().initFromSettings();
      useCodexHighlightStore.getState().initFromSettings();
      if (editor && !editor.isDestroyed && editor.view) {
        for (const meta of [
          ANNOTATION_REBUILD_META,
          LINT_REBUILD_META,
          COMMENT_REBUILD_META,
          GUTTER_REBUILD_META,
        ]) {
          editor.view.dispatch(editor.state.tr.setMeta(meta, true));
        }
      }
    }
    prevEnabled.current = enabled;
  }, [enabled, editor]);
}
