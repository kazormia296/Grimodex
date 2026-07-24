import { useEffect } from "react";
import { useSemanticNavStore, type PendingChunkJump } from "./semanticNavStore";

interface PendingSemanticJumpOptions {
  sceneId: string | null;
  ready: boolean;
  applyJump: (jump: PendingChunkJump) => void;
}

/**
 * Consume both new jump events and a jump that was queued while this editor was
 * hidden. The latter is what lets a preloaded secondary phone pane become the
 * navigation owner without requiring a nodeId reload.
 */
export function usePendingSemanticJump({
  sceneId,
  ready,
  applyJump,
}: PendingSemanticJumpOptions): void {
  useEffect(() => {
    if (!sceneId || !ready) return;
    const consume = (): void => {
      const jump = useSemanticNavStore.getState().pendingJump;
      if (!jump || jump.sceneId !== sceneId) return;
      const consumed = useSemanticNavStore.getState().consumeJump(sceneId);
      if (consumed) applyJump(consumed);
    };

    consume();
    return useSemanticNavStore.subscribe((state, previous) => {
      if (state.pendingJump && state.pendingJump !== previous.pendingJump) {
        consume();
      }
    });
  }, [applyJump, ready, sceneId]);
}
