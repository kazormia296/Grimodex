import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  collectEditorTextCoverage,
  type EditorTextCoverageRect,
} from "./editorTextCoverageIndex";

export function useEditorTextCoverage(
  editor: Editor | null,
  surfaceRef: React.RefObject<HTMLElement | null>,
  draggingRef: React.RefObject<boolean>,
) {
  const [coverage, setCoverage] = useState<EditorTextCoverageRect[]>([]);
  const [measureVersion, setMeasureVersion] = useState(0);

  const requestMeasure = useCallback(() => {
    setMeasureVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (
      !editor ||
      typeof editor.on !== "function" ||
      typeof editor.off !== "function" ||
      !editor.view?.dom
    ) {
      setCoverage([]);
      return;
    }

    let frame = 0;
    let queuedDuringDrag = false;
    const measure = () => {
      frame = 0;
      const surface = surfaceRef.current;
      if (!surface || draggingRef.current) {
        queuedDuringDrag = true;
        return;
      }
      const editorRoot = editor.view.dom as HTMLElement;
      const surfaceRect = surface.getBoundingClientRect();
      setCoverage(
        collectEditorTextCoverage(editorRoot, {
          left: surfaceRect.left,
          top: surfaceRect.top,
        }),
      );
      queuedDuringDrag = false;
    };
    const schedule = () => {
      if (draggingRef.current) {
        queuedDuringDrag = true;
        return;
      }
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    const onDragEnd = () => {
      if (queuedDuringDrag) schedule();
    };

    editor.on("transaction", schedule);
    editor.on("update", schedule);
    const editorRoot = editor.view.dom as HTMLElement;
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(schedule);
    mutationObserver?.observe(editorRoot, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resizeObserver?.observe(editorRoot);
    resizeObserver?.observe(surfaceRef.current ?? editorRoot);
    const fontsReady = document.fonts?.ready.then(schedule).catch(() => {});

    schedule();
    return () => {
      editor.off("transaction", schedule);
      editor.off("update", schedule);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      void fontsReady;
      onDragEnd();
    };
  }, [draggingRef, editor, measureVersion, requestMeasure, surfaceRef]);

  return { coverage, requestMeasure };
}
