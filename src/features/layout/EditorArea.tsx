import { memo, useEffect, useRef } from "react";
import { SceneEditor } from "@/features/tree/SceneEditor";
import { registerEditorFocusHandler } from "./layoutStore";

/** Central editor cell — always mounted. */
export const EditorArea = memo(function EditorArea() {
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={containerRef}
      data-editor-area
      tabIndex={-1}
      className="glass-region-panel h-full min-h-0 w-full min-w-0 overflow-hidden outline-none"
    >
      <SceneEditor />
    </div>
  );
});
