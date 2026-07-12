import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEditorStore } from "@/features/editor/editorStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/application/editor/defaultEditorNavigation";
import type { HumanComment } from "./commentsAggregation";

export interface CommentMatcher {
  /** コメント本文（トリム済み）。 */
  text: string;
  createdAt: string | null;
  /** 同一 (text, createdAt) 内での出現順 index（0 始まり）。 */
  ordinal: number;
}

/**
 * ライブ ProseMirror doc から matcher に一致する `comment` mark の範囲を返す。
 *
 * 連続する同一 `comment` mark の text node を結合し（`humanCommentsFromDoc` と
 * 同じ走査規則）、`trim(text attr) === matcher.text && createdAt 一致` の run のうち
 * `ordinal` 番目（0 始まり）の {from, to}（PM 位置）を返す。該当なしは null。
 *
 * 位置は disk JSON のオフセットではなく **ライブ doc を走査して得た PM 位置**を使う
 * （未保存編集や doc ノードのオフセット差に影響されない）。
 */
export function findCommentMarkRange(
  doc: ProseMirrorNode,
  { text, createdAt, ordinal }: CommentMatcher,
): { from: number; to: number } | null {
  let occurrence = 0;
  let result: { from: number; to: number } | null = null;
  let from = -1;
  let to = -1;
  let bodyRaw: string | null = null;
  let created: string | null = null;

  const flushRun = () => {
    if (bodyRaw !== null) {
      if (bodyRaw.trim() === text && created === createdAt) {
        if (occurrence === ordinal && result === null) {
          result = { from, to };
        }
        occurrence += 1;
      }
    }
    bodyRaw = null;
  };

  doc.descendants((node, pos) => {
    if (!node.isText) {
      flushRun();
      return true;
    }
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark) {
      flushRun();
      return true;
    }
    const nodeBody = String(mark.attrs.text ?? "");
    const nodeCreated = (mark.attrs.createdAt as string | null) ?? null;
    if (bodyRaw === nodeBody && created === nodeCreated) {
      to = pos + node.nodeSize;
    } else {
      flushRun();
      from = pos;
      to = pos + node.nodeSize;
      bodyRaw = nodeBody;
      created = nodeCreated;
    }
    return true;
  });
  flushRun();
  return result;
}

/** rAF リトライの上限（≒ 1s 相当）。これを超えたらシーンだけ開いて選択は諦める。 */
const MAX_JUMP_FRAMES = 60;

/**
 * コメント行クリック時の挙動: 該当シーンを開き、コメントが紐づく本文範囲を選択して
 * スクロール表示する。
 *
 * シーンを開くのは `useTabStore.openPinned` —— エディタを前面化しシーンをタブとして
 * 開く正準アクション（tree/grid/matrix/lint 等が全てこれを使う）。`setActiveScene` は
 * ツリー選択を変えるだけでタブを開かないため、別シーンを開けなかった（同一シーンは
 * 既にタブが開いているので選択だけ効いた）。
 *
 * content 反映は非同期（EditorPane の switchScene）なので、対象シーンの doc が載って
 * 該当 mark が見つかるまで rAF でリトライする。最初の試行は microtask で即実行し、
 * すでに開いている warm なシーンのコメントは即座に選択する。mark 照合自体が自己検証に
 * なる（対象シーンの doc が載るまで一致しない）ため doc を直接走査する＝useLinter の
 * tryJump と同方式。シーンを開く動作は確実、範囲選択は best-effort。
 */
export function jumpToComment(comment: HumanComment): void {
  openEditorDocument(
    {
      target: { kind: "scene", documentId: comment.sceneId },
      mode: "pinned",
      revealEditor: true,
      focusEditor: false,
      syncSceneContext: true,
    },
    defaultEditorNavigationPorts,
  );
  const matcher: CommentMatcher = {
    text: comment.text,
    createdAt: comment.createdAt,
    ordinal: comment.ordinal,
  };
  let frames = 0;
  const attempt = () => {
    const editor = useEditorStore.getState().editor;
    if (editor) {
      const range = findCommentMarkRange(editor.state.doc, matcher);
      if (range) {
        const size = editor.state.doc.content.size;
        const from = Math.max(0, Math.min(range.from, size));
        const to = Math.max(from, Math.min(range.to, size));
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .scrollIntoView()
          .run();
        return;
      }
    }
    if (frames++ < MAX_JUMP_FRAMES) requestAnimationFrame(attempt);
  };
  queueMicrotask(attempt);
}
