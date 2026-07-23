import { memo, useEffect, useRef, type CSSProperties } from "react";
import { motion } from "motion/react";
import { SceneEditor } from "@/features/tree/SceneEditor";
import { useZenShaderConfig } from "@/features/editor/zen/useZenShaderConfig";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { PanelChromeMenu } from "./PanelChromeMenu";
import { registerEditorFocusHandler, useLayoutStore } from "./layoutStore";

/** Central editor cell — always mounted when center band exists. */
export const EditorArea = memo(function EditorArea() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorOpen = useLayoutStore((s) => s.layout.center.editorOpen);
  const initialized = useLayoutStore((s) => s.initialized);
  const prevOpenRef = useRef(editorOpen);
  const reduced = useReducedMotion();
  const glass = useZenShaderConfig().glass;
  const glassStyle = {
    "--editor-fluid-glass-blur": `${glass.blur}px`,
    "--editor-fluid-glass-saturate": glass.saturation,
    "--editor-fluid-glass-shine": glass.shine,
  } as CSSProperties;

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
    // PanelChromeMenu: TabBar 行 (data-panel-header) の右クリックメニュー +
    // dblclick 最大化。エディタ本文には届かない（ヘッダー帯限定の委譲）。
    <PanelChromeMenu panelId="editor">
      <motion.div
        ref={containerRef}
        data-editor-area
        data-editor-fluid-glass={glass.enabled ? "true" : "false"}
        data-editor-fluid-glass-blur={glass.blur}
        data-editor-fluid-glass-refraction={glass.refraction}
        data-editor-fluid-glass-saturation={glass.saturation}
        data-editor-fluid-glass-shine={glass.shine}
        tabIndex={-1}
        style={glassStyle}
        // 起動 hydration 中の mount はユーザー操作ではないため静的に表示する。
        // 初期化後に editor を開き直した mount では従来どおり enter を残す。
        initial={reduced || !initialized ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={
          reduced
            ? { duration: 0 }
            : { duration: DURATIONS.normal, ease: EASINGS.easeOut }
        }
        className="editor-fluid-glass gx-panel gx-panel--flat glass-region-panel h-full min-h-0 w-full min-w-0 overflow-hidden outline-none"
      >
        <SceneEditor />
      </motion.div>
    </PanelChromeMenu>
  );
});
