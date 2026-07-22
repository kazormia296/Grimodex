import type { CSSProperties } from "react";

/** Keep glyphs fully opaque; transparency belongs to the paper paint only. */
export function buildEditorPaperStyle(opacity: number): CSSProperties {
  const percent = Math.min(100, Math.max(0, opacity));
  return {
    background: `color-mix(in oklch, var(--content-background) ${percent}%, transparent)`,
  };
}
