import type { CSSProperties } from "react";

interface EditorPaperStyleOptions {
  enabled: boolean;
}

type EditorPaperStyle = CSSProperties & {
  "--editor-paper-fill": string;
};

/** Keep glyphs opaque while exposing the shader through the entire paper. */
export function buildEditorPaperStyle({
  enabled = true,
}: EditorPaperStyleOptions): EditorPaperStyle {
  return {
    backgroundColor: "transparent",
    "--editor-paper-fill": enabled
      ? "transparent"
      : "var(--content-background)",
  };
}
