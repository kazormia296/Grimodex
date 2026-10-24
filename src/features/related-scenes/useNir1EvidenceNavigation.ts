import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { qualifyNir1Evidence } from "./nir1RelatedScenesApi";
import {
  captureNir1EvidenceEditor,
  isNir1EvidenceEditorCurrent,
  type Nir1EvidenceEditorState,
} from "./nir1EvidenceNavigationState";
import {
  claimNir1EvidenceNavigation,
  subscribeNir1EvidenceNavigation,
} from "./nir1EvidenceNavigation";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";

interface Options {
  readonly editor: Editor | null;
  readonly sceneId: string | null;
  readonly ready: boolean;
  readonly captureState: () => Nir1EvidenceEditorState | null;
  readonly beforeSelection: () => void;
}

/** The same guarded consumer handles load completion and an already-open S1. */
export function useNir1EvidenceNavigation(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.ready || !options.editor || !options.sceneId) return;
    let cancelled = false;
    const consume = async () => {
      const claim = claimNir1EvidenceNavigation(options.sceneId!);
      if (!claim) return;
      try {
        const initial = latest.current.captureState();
        const capture = initial && captureNir1EvidenceEditor(initial);
        if (!capture) return;
        const editor = latest.current.editor;
        if (!editor || editor.isDestroyed) return;
        const documentJson = JSON.stringify(editor.getJSON());
        // D5-B (DR-CP3B-10): the claim and first capture stay here, before
        // any await; the IR and Graph-only matching lives in a lazy module.
        const { consumeNir1Evidence } = await import("./nir1EvidenceConsume");
        if (cancelled || !claim.isCurrent() || editor.isDestroyed) return;
        await consumeNir1Evidence({
          claim,
          capture,
          editor,
          documentJson,
          cancelled: () => cancelled,
          captureState: () => latest.current.captureState(),
          beforeSelection: () => latest.current.beforeSelection(),
          isEditorCurrent: isNir1EvidenceEditorCurrent,
          qualifyEvidence: qualifyNir1Evidence,
          digest: sha256Digest,
        });
      } catch {
        // An unavailable qualification leaves the scene open without applying
        // a selection; exception payloads never enter the display.
      } finally {
        claim.finish();
      }
    };
    void consume();
    const unsubscribe = subscribeNir1EvidenceNavigation(() => {
      void consume();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [options.editor, options.ready, options.sceneId]);
}
