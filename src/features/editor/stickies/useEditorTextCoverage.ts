import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  collectEditorTextCoverage,
  indexEditorTextCoverage,
  type EditorTextCoverageIndex,
  type EditorTextCoverageRect,
} from "./editorTextCoverageIndex";

const EMPTY_COVERAGE: EditorTextCoverageRect[] = [];

export function useEditorTextCoverage(
  editor: Editor | null,
  surfaceRef: React.RefObject<HTMLElement | null>,
  draggingRef: React.RefObject<boolean>,
  enabled: boolean,
) {
  const [coverage, setCoverage] =
    useState<EditorTextCoverageRect[]>(EMPTY_COVERAGE);
  const [measureVersion, setMeasureVersion] = useState(0);

  const requestMeasure = useCallback(() => {
    setMeasureVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (
      !enabled ||
      !editor ||
      typeof editor.on !== "function" ||
      typeof editor.off !== "function" ||
      !editor.view?.dom
    ) {
      setCoverage(EMPTY_COVERAGE);
      return;
    }

    let frame = 0;
    let disposed = false;
    let queuedDuringDrag = false;
    const measure = () => {
      if (disposed) return;
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
      if (disposed) return;
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
    editorRoot.addEventListener("compositionstart", schedule);
    editorRoot.addEventListener("compositionupdate", schedule);
    editorRoot.addEventListener("compositionend", schedule);
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
      disposed = true;
      editor.off("transaction", schedule);
      editor.off("update", schedule);
      editorRoot.removeEventListener("compositionstart", schedule);
      editorRoot.removeEventListener("compositionupdate", schedule);
      editorRoot.removeEventListener("compositionend", schedule);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      void fontsReady;
      onDragEnd();
    };
  }, [
    draggingRef,
    editor,
    enabled,
    measureVersion,
    requestMeasure,
    surfaceRef,
  ]);

  const coverageIndex: EditorTextCoverageIndex = useMemo(
    () => indexEditorTextCoverage(coverage),
    [coverage],
  );
  return { coverage: coverageIndex, requestMeasure };
}
