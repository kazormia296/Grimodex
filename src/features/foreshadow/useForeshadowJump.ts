import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { useForeshadowNavStore } from "./foreshadowNavStore";

/**
 * 伏線パネルの「→ ジャンプ」要求をエディタへ反映する。
 * 該当 sceneId のシーンがロードされた直後に一度だけ消費し、
 * setTextSelection + scrollIntoView を実行する。
 *
 * useLinter のクロスシーン pendingJump と同じ流儀。
 * 伏線は ProseMirror ポジションを直接保持しているので
 * オフセット変換は不要。
 */
export function useForeshadowJump(
  editor: Editor | null,
  sceneId: string | null,
) {
  useEffect(() => {
    if (!editor || !sceneId) return;

    let jumpAttempted = false;

    const tryJump = () => {
      if (jumpAttempted || !editor || !sceneId) return;
      const jump = useForeshadowNavStore.getState().consumeJump(sceneId);
      if (!jump) {
        jumpAttempted = true;
        return;
      }
      const docSize = editor.state.doc.content.size;
      if (jump.toPos > docSize) {
        // ドキュメント未ロード or 位置が範囲外。
        // 未ロードなら次のトランザクションで再試行できるよう戻す。
        if (docSize <= 2) {
          useForeshadowNavStore.getState().requestJump(jump);
          return;
        }
        // 範囲外（ドリフト）: 選択は諦めシーンへフォーカスのみ。
        editor.chain().focus().scrollIntoView().run();
        jumpAttempted = true;
        return;
      }
      editor
        .chain()
        .focus()
        .setTextSelection({ from: jump.fromPos, to: jump.toPos })
        .scrollIntoView()
        .run();
      jumpAttempted = true;
    };

    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean };
    }) => {
      if (!transaction.docChanged) return;
      tryJump();
    };
    editor.on("transaction", onTransaction);

    queueMicrotask(tryJump);

    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, sceneId]);
}
