import { useCallback } from "react";

/**
 * Returns a function that captures currently selected text within a container.
 * If no text is selected (or selection is outside the container), returns null.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const getSelectedText = useCallback((): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return null;

    // Verify selection is within the container
    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) {
      return null;
    }

    const text = sel.toString().trim();
    return text.length > 0 ? text : null;
  }, [containerRef]);

  return { getSelectedText };
}
