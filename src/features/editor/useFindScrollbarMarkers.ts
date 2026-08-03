import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";
import {
  buildFindScrollbarMarkers,
  getFindGeometryScale,
  getFindScrollbarTrackPixel,
  type FindScrollbarMarker,
} from "./findScrollbarMarkerGeometry";
import { collectFindMatchRects } from "./findScrollbarMarkerSampling";
import { mutationsAffectFindScrollbarGeometry } from "./findScrollbarMarkerMutations";
import {
  readFindState,
  sameFindMarkers,
  sameFindState,
  type FindStateSnapshot,
} from "./findScrollbarMarkerState";

interface UseFindScrollbarMarkersOptions {
  editor: Editor | null;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  enabled: boolean;
  verticalMode: boolean;
}

interface MarkerMeasurement {
  editor: Editor;
  verticalMode: boolean;
  markers: FindScrollbarMarker[];
}

export function useFindScrollbarMarkers({
  editor,
  scrollContainerRef,
  enabled,
  verticalMode,
}: UseFindScrollbarMarkersOptions): FindScrollbarMarker[] {
  const [measurement, setMeasurement] = useState<MarkerMeasurement | null>(
    null,
  );
  const animationFrameRef = useRef<number | null>(null);
  const findStateRef = useRef<FindStateSnapshot | null>(null);

  const measure = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!enabled || !editor || editor.isDestroyed || !scrollContainer) {
      setMeasurement(null);
      return;
    }

    try {
      const decorations = editor.view.dom.querySelectorAll<HTMLElement>(
        ".find-match, .find-current",
      );
      const clientExtent = verticalMode
        ? scrollContainer.clientWidth
        : scrollContainer.clientHeight;
      const containerRect = scrollContainer.getBoundingClientRect();
      const geometryScale = getFindGeometryScale(
        scrollContainer,
        containerRect,
        verticalMode,
      );
      const matchRects = collectFindMatchRects({
        decorations,
        maximumGeometryReads: clientExtent + 1,
        getTrackPixel: (rect) =>
          getFindScrollbarTrackPixel({
            rect,
            containerRect,
            scrollMetrics: scrollContainer,
            verticalMode,
            geometryScale,
          }),
      });

      const nextMarkers = buildFindScrollbarMarkers({
        matchRects,
        containerRect,
        scrollMetrics: scrollContainer,
        verticalMode,
        geometryScale,
      });
      setMeasurement((previous) => {
        if (
          previous?.editor === editor &&
          previous.verticalMode === verticalMode &&
          sameFindMarkers(previous.markers, nextMarkers)
        ) {
          return previous;
        }
        return { editor, verticalMode, markers: nextMarkers };
      });
    } catch {
      setMeasurement(null);
    }
  }, [editor, enabled, scrollContainerRef, verticalMode]);

  const scheduleMeasure = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = -1;
    const frameId = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      measure();
    });
    if (animationFrameRef.current !== null) {
      animationFrameRef.current = frameId;
    }
  }, [measure]);

  useEffect(() => {
    if (!enabled || !editor || editor.isDestroyed) {
      findStateRef.current = null;
      setMeasurement(null);
      return;
    }

    findStateRef.current = readFindState(editor);
    const handleTransaction = () => {
      const nextFindState = readFindState(editor);
      if (!nextFindState) {
        scheduleMeasure();
        return;
      }
      if (sameFindState(findStateRef.current, nextFindState)) return;
      findStateRef.current = nextFindState;
      scheduleMeasure();
    };
    editor.on("transaction", handleTransaction);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    const scrollContainer = scrollContainerRef.current;
    const paper =
      scrollContainer?.querySelector<HTMLElement>(".zen-editor-paper") ?? null;
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (
              mutationsAffectFindScrollbarGeometry(
                records,
                scrollContainer,
                paper,
              )
            ) {
              scheduleMeasure();
            }
          });
    for (const target of new Set(
      [scrollContainer, paper, editor.view.dom].filter(
        (candidate): candidate is HTMLElement => candidate !== null,
      ),
    )) {
      resizeObserver?.observe(target);
    }
    mutationObserver?.observe(scrollContainer ?? editor.view.dom, {
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
      childList: true,
      subtree: true,
    });
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      editor.off("transaction", handleTransaction);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [editor, enabled, scheduleMeasure, scrollContainerRef]);

  return enabled &&
    measurement?.editor === editor &&
    measurement.verticalMode === verticalMode
    ? measurement.markers
    : [];
}
