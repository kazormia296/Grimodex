import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAnnotationStore } from "./annotationStore";
import { listAnnotationsForScene } from "./api";
import {
  groupPseudoThreads,
  PseudoCommentThread,
  type PseudoThread,
} from "./PseudoCommentThread";

interface Props {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

interface Target {
  annId: string;
  x: number;
  y: number;
}

/**
 * 本文横の疑似コメント吹き出し。`.pe-annotation-pseudo_comment` span を
 * ホバーすると、その annotation のスレッド (コメント + 返信 + 返信入力) を
 * ポップオーバー表示する。CommentHoverPopover の配置パターンを踏襲。
 */
export function PseudoCommentBubble({ editor, containerRef }: Props) {
  const showReaderComments = useAnnotationStore((s) => s.showReaderComments);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const setAnnotations = useAnnotationStore((s) => s.setAnnotations);
  const [target, setTarget] = useState<Target | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => setTarget(null), 250);
  }, [clearHideTimer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showReaderComments) return;

    function onMouseOver(e: MouseEvent) {
      const el = (e.target as Element).closest(
        '[data-pe-category="pseudo_comment"]',
      ) as HTMLElement | null;
      if (!el) {
        scheduleHide();
        return;
      }
      clearHideTimer();
      const annId = el.getAttribute("data-pe-ann-id");
      if (!annId) return;
      const rect = el.getBoundingClientRect();
      setTarget({ annId, x: rect.left, y: rect.bottom + 6 });
    }

    container.addEventListener("mouseover", onMouseOver);
    return () => container.removeEventListener("mouseover", onMouseOver);
  }, [containerRef, showReaderComments, scheduleHide, clearHideTimer]);

  useEffect(() => {
    if (!showReaderComments) setTarget(null);
  }, [showReaderComments]);

  const reload = useCallback(async () => {
    const { projectId, activeSceneId } = useTreeStore.getState();
    if (!activeSceneId) return;
    const resp = await listAnnotationsForScene({
      projectId,
      sceneId: activeSceneId,
    });
    setAnnotations(activeSceneId, resp.annotations);
  }, [setAnnotations]);

  if (!target || !editor) return null;

  const activeSceneId = useTreeStore.getState().activeSceneId;
  const sceneAnnotations = activeSceneId
    ? (annotationsByScene.get(activeSceneId) ?? [])
    : [];
  // ホバー対象 annotation が属するスレッド (root が対象、または対象が root)
  const threads = groupPseudoThreads(sceneAnnotations);
  const thread: PseudoThread | undefined = threads.find(
    (t) =>
      t.root.id === target.annId ||
      t.replies.some((r) => r.id === target.annId),
  );
  if (!thread) return null;

  const width = 300;
  const x = Math.min(target.x, window.innerWidth - width - 8);
  const y = Math.min(target.y, window.innerHeight - 200);

  return createPortal(
    <div
      className="fixed z-50"
      style={{ left: x, top: y, width }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      <div className="rounded-md border border-border bg-popover p-1 shadow-md">
        <PseudoCommentThread thread={thread} onChanged={() => void reload()} />
      </div>
    </div>,
    document.body,
  );
}
