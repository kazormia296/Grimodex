import { memo, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { SceneEditor } from "@/features/tree/SceneEditor";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { registerEditorFocusHandler, useLayoutStore } from "./layoutStore";

/** Central editor cell — always mounted when center band exists. */
export const EditorArea = memo(function EditorArea() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorOpen = useLayoutStore((s) => s.layout.center.editorOpen);
  const prevOpenRef = useRef(editorOpen);
  const reduced = useReducedMotion();

  useEffect(() => {
    registerEditorFocusHandler(() => {
      containerRef.current?.focus({ preventScroll: true });
      const editor = containerRef.current?.querySelector<HTMLElement>(
        ".ProseMirror, [contenteditable='true']",
      );
      editor?.focus({ preventScroll: true });
    });
    return () => registerEditorFocusHandler(null);
  }, []);

  useEffect(() => {
    if (!prevOpenRef.current && editorOpen) {
      requestAnimationFrame(() => {
        containerRef.current?.focus({ preventScroll: true });
        const editor = containerRef.current?.querySelector<HTMLElement>(
          ".ProseMirror, [contenteditable='true']",
        );
        editor?.focus({ preventScroll: true });
      });
    }
    prevOpenRef.current = editorOpen;
  }, [editorOpen]);

  return (
    <motion.div
      ref={containerRef}
      data-editor-area
      tabIndex={-1}
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={
        reduced
          ? { duration: 0 }
          : { duration: DURATIONS.normal, ease: EASINGS.easeOut }
      }
      className="gx-panel gx-panel--flat glass-region-panel h-full min-h-0 w-full min-w-0 overflow-hidden outline-none"
    >
      <SceneEditor />
    </motion.div>
  );
});
