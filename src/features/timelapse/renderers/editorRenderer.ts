import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 執筆タイムラプス Editor canvas renderer (P7 + P1).
 *
 * Paints a ProseMirror doc as wrapped plain-text paragraphs on a 2D canvas.
 * Glyphs are drawn in a single `text` colour (matching the live editor, which
 * does NOT recolour text by authorship); instead AuthorshipMark provenance is
 * shown the same way the editor shows it — a **background tint behind AI /
 * unknown runs**, gated by `showAttribution`, with human runs left untinted
 * (see AttributionPlugin / index.css `.attribution-*`).
 *
 * Schema coverage is still paragraph + text only (no headings / lists / nested
 * nodes); structural fidelity is P2. Theme colours (background / text /
 * attribution tints) and the editor font are supplied by the export path via
 * `resolveEditorTheme` so the video matches the user's active theme rather than
 * a hard-coded white/sans default.
 */

export type AuthorshipSource = "ai" | "human" | "unknown" | null;

export interface EditorRenderTheme {
  background: string;
  /** Uniform glyph colour (live editor keeps text colour constant). */
  text: string;
  /**
   * Whether to paint authorship tints. Mirrors the live editor's
   * `showAttribution` toggle so the timelapse matches what the writer saw.
   */
  showAttribution: boolean;
  /** Background tint behind source=ai runs (resolved colour). */
  attributionAi: string;
  /** Background tint behind source=unknown runs (resolved colour). */
  attributionUnknown: string;
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  paddingPx: number;
  paragraphGapPx: number;
}

export const DEFAULT_THEME: EditorRenderTheme = {
  background: "#ffffff",
  text: "#222222",
  // Off by default: the bare default theme stays neutral. The export path
  // supplies the live setting + resolved tint colours (P1 / resolveEditorTheme).
  showAttribution: false,
  attributionAi: "rgba(34, 197, 94, 0.18)",
  attributionUnknown: "rgba(217, 119, 6, 0.16)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSizePx: 16,
  lineHeightPx: 24,
  paddingPx: 32,
  paragraphGapPx: 12,
};

interface Run {
  text: string;
  source: AuthorshipSource;
}

type Ctx2D = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "font" | "fillRect" | "fillText" | "measureText"
>;

/** Background tint for a run's source, or null if it should not be tinted. */
function attributionTint(
  source: AuthorshipSource,
  theme: EditorRenderTheme,
): string | null {
  if (!theme.showAttribution) return null;
  if (source === "ai") return theme.attributionAi;
  if (source === "unknown") return theme.attributionUnknown;
  // human (and untracked) is intentionally left untinted, matching the editor.
  return null;
}

/**
 * Render `doc` into `ctx` at canvas size `width × height`.
 *
 * Lines are wrapped greedily using `ctx.measureText`. Each text run carries its
 * AuthorshipMark source so the painter can draw the provenance background tint.
 */
export function renderDocToCanvas(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  width: number,
  height: number,
  theme: EditorRenderTheme = DEFAULT_THEME,
): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${theme.fontSizePx}px ${theme.fontFamily}`;

  const contentWidth = width - theme.paddingPx * 2;
  let y = theme.paddingPx + theme.fontSizePx;

  // Manual childCount loop (not `doc.forEach`) so the past-canvas-bottom
  // early-out below can actually `break` — ProseMirror's Fragment.forEach
  // ignores a callback's return value, so returning early there is a no-op.
  for (let bi = 0; bi < doc.childCount; bi += 1) {
    const block = doc.child(bi);
    const runs: Run[] = [];
    block.forEach((child) => {
      if (!child.isText || !child.text) return;
      const mark = child.marks.find((m) => m.type.name === "authorship");
      const source =
        (mark?.attrs.source as AuthorshipSource | undefined) ?? null;
      runs.push({ text: child.text, source });
    });
    if (runs.length === 0) {
      y += theme.lineHeightPx + theme.paragraphGapPx;
      continue;
    }
    const linesPainted = paintParagraph(
      ctx,
      runs,
      theme.paddingPx,
      y,
      contentWidth,
      theme,
    );
    y += linesPainted * theme.lineHeightPx + theme.paragraphGapPx;
    if (y > height + theme.lineHeightPx) {
      // Stop drawing once we're well past the canvas bottom; later content
      // would be clipped anyway and measureText calls add up.
      break;
    }
  }
}

function paintParagraph(
  ctx: Ctx2D,
  runs: Run[],
  startX: number,
  startY: number,
  maxWidth: number,
  theme: EditorRenderTheme,
): number {
  const lineHeight = theme.lineHeightPx;
  const fontSize = theme.fontSizePx;
  let x = startX;
  let y = startY;
  let lines = 1;
  let firstOnLine = true;

  for (const run of runs) {
    const tint = attributionTint(run.source, theme);
    const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0);
    for (const token of tokens) {
      const w = ctx.measureText(token).width;
      if (!firstOnLine && x + w > startX + maxWidth && !/^\s+$/.test(token)) {
        // wrap before this token
        y += lineHeight;
        x = startX;
        lines += 1;
        firstOnLine = true;
      }
      if (firstOnLine && /^\s+$/.test(token)) {
        // skip leading whitespace on a fresh line
        continue;
      }
      // Authorship tint = background band behind the run (incl. its spaces),
      // drawn before the glyph so text stays readable. Brackets the glyph line.
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(x, y - fontSize * 0.85, w, fontSize * 1.15);
      }
      ctx.fillStyle = theme.text;
      ctx.fillText(token, x, y);
      x += w;
      firstOnLine = false;
    }
  }
  return lines;
}

export { paintParagraph as _paintParagraphForTest };
