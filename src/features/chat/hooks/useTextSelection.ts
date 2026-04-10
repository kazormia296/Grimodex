import { useCallback, useEffect, useRef, useState } from "react";

export interface SelectionInfo {
  text: string;
  rect: DOMRect;
}

/**
 * Returns reactive selectionInfo state (updated on selectionchange) and a
 * getSelectedText() helper for backward-compatible point-in-time capture.
 * Selection is cleared when a mousedown happens outside the container.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(
    null,
  );
  const rafRef = useRef<number | null>(null);

  const getSelectedText = useCallback((): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return null;

    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) {
      return null;
    }

    const text = sel.toString().trim();
    return text.length > 0 ? text : null;
  }, [containerRef]);

  useEffect(() => {
    function handleSelectionChange() {
      // Debounce with requestAnimationFrame to avoid jitter while dragging
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !containerRef.current) {
          setSelectionInfo(null);
          return;
        }

        const range = sel.getRangeAt(0);
        if (!containerRef.current.contains(range.commonAncestorContainer)) {
          setSelectionInfo(null);
          return;
        }

        const text = sel.toString().trim();
        if (text.length === 0) {
          setSelectionInfo(null);
          return;
        }

        const rect = range.getBoundingClientRect();
        setSelectionInfo({ text, rect });
      });
    }

    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setSelectionInfo(null);
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mousedown", handleMouseDown);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [containerRef]);

  return { selectionInfo, getSelectedText };
}
