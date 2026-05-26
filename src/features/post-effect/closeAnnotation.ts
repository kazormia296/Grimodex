import type { Editor } from "@tiptap/core";
import { updateAnnotationStatus } from "./api";
import { useAnnotationStore } from "./annotationStore";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import type { PostEffectAnnotation, PostEffectStatus } from "./types";

/**
 * Annotation を `resolved` / `dismissed` に閉じ、対応するシーンの editor
 * オーバーレイ (`peAnnotation` mark) を refresh する。
 *
 * `updateAnnotationStatus` (DB) → `annotationStore.updateAnnotationStatus`
 * (zustand) → `applyAnnotationsToEditor` (PM) の 3 段を 1 callsite から呼べる
 * 形にまとめ、パネルの ✓ / × ボタンと editor の underline を同期させる。
 *
 * editor が null だったり、annotation のシーンが現在表示されていない場合は
 * mark refresh はスキップする (シーン切替時の applyAnnotationsToEditor で
 * 自然に直る)。DB / store 更新は常に行う。
 */
export async function closeAnnotation(
  ann: PostEffectAnnotation,
  status: Extract<PostEffectStatus, "resolved" | "dismissed">,
  editor: Editor | null,
): Promise<void> {
  try {
    await updateAnnotationStatus(ann.id, status);
  } catch {
    // DB エラーでもユーザーの意図 (このパネルから消す) は反映する
  }
  useAnnotationStore.getState().updateAnnotationStatus(ann.id, status);

  if (editor && ann.sceneId) {
    const next =
      useAnnotationStore.getState().annotationsByScene.get(ann.sceneId) ?? [];
    applyAnnotationsToEditor(editor, next);
  }
}
