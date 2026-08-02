import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Eye, X } from "lucide-react";
import { CSS_DURATIONS, CSS_EASINGS } from "@/lib/animation";
import { resolveAnnotationRange } from "./resolveAnnotationRange";
import { useAnnotationStore } from "./annotationStore";
import { useLiveReaderStore, type LiveReaderComment } from "./liveReaderStore";

interface Props {
  editor: Editor | null;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  sceneId: string;
}

interface PositionedComment {
  comment: LiveReaderComment;
  top: number;
  left: number;
  width: number;
}

const CARD_WIDTH = 232;
const CARD_GAP = 10;
const CARD_HEIGHT_ESTIMATE = 84;
const EMPTY_COMMENTS: LiveReaderComment[] = [];

function findCommentTop(
  editor: Editor,
  container: HTMLDivElement,
  comment: LiveReaderComment,
  fallbackIndex: number,
): number {
  if (!comment.foundText) {
    return (
      container.getBoundingClientRect().top +
      24 +
      fallbackIndex * CARD_HEIGHT_ESTIMATE
    );
  }
  const range = resolveAnnotationRange(editor.state.doc, {
    rangeStart: null,
    rangeEnd: null,
    textSnapshot: comment.foundText,
  });
  if (!range) {
    return (
      container.getBoundingClientRect().top +
      24 +
      fallbackIndex * CARD_HEIGHT_ESTIMATE
    );
  }
  try {
    return editor.view.coordsAtPos(range.from).top;
  } catch {
    return (
      container.getBoundingClientRect().top +
      24 +
      fallbackIndex * CARD_HEIGHT_ESTIMATE
    );
  }
}

/** 本文の外側に浮かぶ、生成中だけ存在する読者コメントのレール。 */
export function LiveReaderCommentRail({
  editor,
  containerRef,
  sceneId,
}: Props) {
  const showReaderComments = useAnnotationStore((s) => s.showReaderComments);
  const comments = useLiveReaderStore(
    (s) => s.commentsByScene.get(sceneId) ?? EMPTY_COMMENTS,
  );
  const clearComment = useLiveReaderStore((s) => s.clearComment);
  const [positions, setPositions] = useState<PositionedComment[]>([]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!editor || !container || !showReaderComments || comments.length === 0) {
      setPositions([]);
      return;
    }
    const rect = container.getBoundingClientRect();
    const canFitRight =
      rect.right + CARD_GAP + CARD_WIDTH <= window.innerWidth - 8;
    const canFitLeft = rect.left - CARD_GAP - CARD_WIDTH >= 8;
    const left = canFitRight
      ? rect.right + CARD_GAP
      : canFitLeft
        ? rect.left - CARD_GAP - CARD_WIDTH
        : Math.max(
            8,
            Math.min(rect.left + 8, window.innerWidth - CARD_WIDTH - 8),
          );
    let previousBottom = rect.top + 8;
    const next = comments.map((comment, index) => {
      const anchorTop = findCommentTop(editor, container, comment, index);
      const top = Math.max(anchorTop - 8, previousBottom + CARD_GAP);
      previousBottom = top + CARD_HEIGHT_ESTIMATE;
      return { comment, top, left, width: CARD_WIDTH };
    });
    setPositions(next);
  }, [comments, containerRef, editor, showReaderComments]);

  useEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => measure();
    window.addEventListener("resize", onScroll);
    // Linear mode places the anchor inside a parent scroll container, while
    // tab mode uses the editor container itself. Capture all scroll targets so
    // fixed cards follow either layout.
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    editor?.on("transaction", measure);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
      editor?.off("transaction", measure);
    };
  }, [containerRef, editor, measure]);

  if (
    !showReaderComments ||
    positions.length === 0 ||
    typeof document === "undefined"
  ) {
    return null;
  }

  return createPortal(
    <div
      aria-label="Live reader comments"
      className="pointer-events-none fixed inset-0 z-40"
      data-live-reader-rail
    >
      {positions.map(({ comment, top, left, width }) => (
        <article
          key={comment.id}
          role="note"
          data-live-reader-comment={comment.id}
          className="pointer-events-auto absolute rounded-xl border border-pink-300/70 bg-pink-50/95 px-3 py-2 text-sm text-pink-950 shadow-lg backdrop-blur-sm dark:border-pink-400/40 dark:bg-pink-950/90 dark:text-pink-50"
          style={{
            top,
            left,
            width,
            transition: `top ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, opacity ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
          }}
        >
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-pink-700/80 dark:text-pink-200/80">
            <span className="flex min-w-0 items-center gap-1 truncate">
              <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {comment.persona || "読者"}
            </span>
            <button
              type="button"
              aria-label="コメントを閉じる"
              className="rounded p-0.5 text-pink-700/70 hover:bg-pink-200/70 hover:text-pink-950 dark:text-pink-200/70 dark:hover:bg-pink-900"
              onClick={() => clearComment(sceneId, comment.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <p className="leading-relaxed">{comment.content}</p>
        </article>
      ))}
    </div>,
    document.body,
  );
}
