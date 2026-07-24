import { useEffect } from "react";
import { useEditorSessionStore } from "./editorSessionStore";
import type { GroupIndex } from "./tabStore";

interface RequestedEditorFocusOptions {
  groupIndex: GroupIndex;
  ready: boolean;
  focus: () => void;
}

/**
 * Consume an explicit focus handoff both for a document that is still loading
 * and for an already-loaded pane that was merely revealed on phone.
 */
export function useRequestedEditorFocus({
  groupIndex,
  ready,
  focus,
}: RequestedEditorFocusOptions): void {
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let focusFrame: number | null = null;

    const fulfill = (): void => {
      if (
        disposed ||
        !useEditorSessionStore.getState().consumeEditorFocusRequest(groupIndex)
      ) {
        return;
      }
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null;
        if (!disposed) focus();
      });
    };

    fulfill();
    const unsubscribe = useEditorSessionStore.subscribe((state, previous) => {
      if (
        state.focusRequests[groupIndex] &&
        !previous.focusRequests[groupIndex]
      ) {
        fulfill();
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    };
  }, [focus, groupIndex, ready]);
}
