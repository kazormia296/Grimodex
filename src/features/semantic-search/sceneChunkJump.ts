import { useSemanticNavStore } from "./semanticNavStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";

/**
 * シーンを開いてチャンク位置へスクロール+選択ハイライトするジャンプ要求の共通実装。
 *
 * 順序は不変条件: **requestJump → setActiveScene → showPanel("editor")**。
 * EditorPane の switchScene 経路が同一 microtask で `consumeJump(sceneId)` するため、
 * pendingJump を setActiveScene より先に積んでおく必要がある。
 *
 * 意味検索ダイアログ (`semanticSearchProvider`) と「関連する過去シーン」セクション
 * (`RelatedScenesSection`) が共有し、この順序契約を 1 箇所に集約する。
 */
export function requestSceneChunkJump(
  sceneId: string,
  chunkText: string,
): void {
  useSemanticNavStore.getState().requestJump({ sceneId, chunkText });
  openEditorDocument(
    {
      target: { kind: "scene", documentId: sceneId },
      mode: "pinned",
      revealEditor: true,
      focusEditor: false,
      syncSceneContext: true,
    },
    defaultEditorNavigationPorts,
  );
}
