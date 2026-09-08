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
import { resolveNir1EvidenceRange } from "./nir1EvidenceRange";
import { serializeProseMirrorDocument } from "@/features/narrative-extraction/source/proseMirrorSerializer";
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
        const serialized = serializeProseMirrorDocument(
          documentJson,
          "database",
        );
        if (!serialized.ok) return;
        const canonicalDigest = await sha256Digest(serialized.canonical.text);
        const qualified = await qualifyNir1Evidence(claim.identity);
        const current = latest.current.captureState();
        if (
          cancelled ||
          !claim.isCurrent() ||
          qualified.status !== "qualified" ||
          qualified.bindingKey !== claim.identity ||
          qualified.queryBinding !== claim.queryBinding ||
          qualified.sceneId !== claim.sceneId ||
          !current ||
          !isNir1EvidenceEditorCurrent(capture, current) ||
          capture.binding.kind !== "tree" ||
          capture.binding.id !== claim.sceneId ||
          capture.binding.loadedVersion !== qualified.sourceVersion
        )
          return;
        if (
          editor.isDestroyed ||
          canonicalDigest !== qualified.canonicalTextDigest
        )
          return;
        const range = resolveNir1EvidenceRange({
          documentJson,
          fullQuote: qualified.fullQuote,
          normalizerVersion: qualified.normalizerVersion,
        });
        if (
          range.status !== "highlight" ||
          range.canonicalRange.start !== qualified.canonicalRange.start ||
          range.canonicalRange.end !== qualified.canonicalRange.end
        )
          return;
        // No await between this final generation check and selection. Never
        // clamp a stale range or use a prefix/Raw jump fallback.
        const final = latest.current.captureState();
        if (
          !final ||
          !claim.isCurrent() ||
          !isNir1EvidenceEditorCurrent(capture, final)
        )
          return;
        latest.current.beforeSelection();
        editor
          .chain()
          .focus()
          .setTextSelection(range.selection)
          .scrollIntoView()
          .run();
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
