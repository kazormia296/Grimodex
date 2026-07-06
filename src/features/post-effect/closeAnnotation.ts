import type { Editor } from "@tiptap/core";
import { updateAnnotationStatus } from "./api";
import { useAnnotationStore } from "./annotationStore";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import { useTreeStore } from "@/features/tree/treeStore";
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
    // XPROJ ガード: 現在プロジェクトを渡す (他プロジェクトの id は Rust 側で弾かれる)。
    const projectId = useTreeStore.getState().projectId ?? "";
    await updateAnnotationStatus(ann.id, status, projectId);
  } catch {
    // DB エラーでもユーザーの意図 (このパネルから消す) は反映する
  }
  useAnnotationStore.getState().updateAnnotationStatus(ann.id, status);

  // mark refresh は annotation のシーンが「現在表示中のシーン」のときだけ行う。
  // editor は常にアクティブシーンの doc を持つため、別シーンの annotation で
  // 適用すると表示中シーンの下線が丸ごと別シーン分に差し替わる（＝全消し）。
  // 校閲トリアージの folder/project スコープは越境の解決/無視が普通に起きる。
  if (editor && ann.sceneId) {
    const activeSceneId = useTreeStore.getState().activeSceneId;
    if (ann.sceneId === activeSceneId) {
      const next =
        useAnnotationStore.getState().annotationsByScene.get(ann.sceneId) ?? [];
      applyAnnotationsToEditor(editor, next);
    }
  }
}
