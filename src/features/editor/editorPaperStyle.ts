import type { CSSProperties } from "react";

interface EditorPaperStyleOptions {
  enabled: boolean;
  opacity: number;
  edgeFade: number;
}

type EditorPaperStyle = CSSProperties & {
  "--editor-paper-fill": string;
  "--editor-paper-edge-fade": string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Keep glyphs fully opaque; every blend operation belongs to the paper paint. */
export function buildEditorPaperStyle({
  enabled = true,
  opacity = 100,
  edgeFade = 8,
}: EditorPaperStyleOptions): EditorPaperStyle {
  const percent = enabled ? clamp(opacity, 0, 100) : 100;
  const fadePercent = enabled ? clamp(edgeFade, 0, 30) : 0;

  return {
    backgroundColor: "transparent",
    "--editor-paper-fill": `color-mix(in oklch, var(--content-background) ${percent}%, transparent)`,
    "--editor-paper-edge-fade": `${fadePercent}%`,
  };
}
