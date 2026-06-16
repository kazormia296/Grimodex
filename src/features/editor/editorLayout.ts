import type React from "react";
import type { EditorSettings } from "@/features/settings/hooks/useEditorSettings";

/**
 * Pure layout helpers shared by the tab editor (EditorContentArea) and the
 * linear view (LinearEditorView / LinearSceneBlock).
 *
 * Writing-mode strategy: styles use CSS logical properties so the same
 * declarations work for horizontal-tb and vertical-rl. In vertical-rl the
 * inline axis is vertical, so max-inline-size caps the line length (physical
 * height) and margin-inline:auto centers the column vertically — the direct
 * analog of max-width + margin:0 auto in horizontal writing.
 */

export type EditorContentStyleSettings = Pick<
  EditorSettings,
  | "fontFamily"
  | "fontSize"
  | "lineHeight"
  | "maxContentWidth"
  | "wordBreak"
  | "lineBreak"
  | "textAutospace"
  | "paragraphIndent"
  | "paragraphSpacing"
>;

/** Line-length cap + centering only (LinearEditorView outer wrapper). */
export function buildEditorMeasureStyle(
  maxContentWidth: number,
): React.CSSProperties {
  return {
    maxInlineSize: `${maxContentWidth}px`,
    marginBlock: 0,
    marginInline: "auto",
  };
}

/** Full content wrapper style (EditorContentArea / LinearSceneBlock). */
export function buildEditorContentStyle(
  s: EditorContentStyleSettings,
): React.CSSProperties {
  return {
    ...buildEditorMeasureStyle(s.maxContentWidth),
    fontFamily: s.fontFamily,
    fontSize: `${s.fontSize}px`,
    lineHeight: s.lineHeight,
    wordBreak: s.wordBreak as React.CSSProperties["wordBreak"],
    lineBreak: s.lineBreak as React.CSSProperties["lineBreak"],
    // 和欧間スペーシング。WebKit 系は no-autospace が既定なので、normal を
    // 明示しないと和欧間アキが効かない（表示のみ・本文は不変）。
    textAutospace: s.textAutospace as React.CSSProperties["textAutospace"],
    "--editor-paragraph-indent": `${s.paragraphIndent}em`,
    "--editor-paragraph-spacing": `${s.paragraphSpacing}px`,
  } as React.CSSProperties;
}

export interface ScrollOffsets {
  scrollTop: number;
  scrollLeft: number;
}

/**
 * Logical scroll offset = non-negative distance from the block-start edge.
 * Chromium's vertical-rl scroll origin is the right edge (scrollLeft 0) and
 * scrolling toward the content end goes negative — that engine-specific sign
 * convention is confined to these two functions.
 */
export function getLogicalScrollOffset(
  el: ScrollOffsets,
  vertical: boolean,
): number {
  return vertical ? -el.scrollLeft : el.scrollTop;
}

export function setLogicalScrollOffset(
  el: ScrollOffsets,
  offset: number,
  vertical: boolean,
): void {
  if (vertical) {
    el.scrollLeft = -offset;
  } else {
    el.scrollTop = offset;
  }
}

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Signed distance from the container's block-start edge to the rect's. */
export function getBlockStartOffset(
  containerRect: RectLike,
  rect: RectLike,
  vertical: boolean,
): number {
  return vertical
    ? containerRect.right - rect.right
    : rect.top - containerRect.top;
}

/** Whether the rect overlaps the container along the block axis. */
export function intersectsBlockAxis(
  containerRect: RectLike,
  rect: RectLike,
  vertical: boolean,
): boolean {
  return vertical
    ? !(rect.right < containerRect.left || rect.left > containerRect.right)
    : !(rect.bottom < containerRect.top || rect.top > containerRect.bottom);
}

/**
 * Visible scene closest to the container's block-start edge (the linear
 * view's active-scene rule, extracted from its IntersectionObserver handler).
 */
export function pickActiveSceneId(
  containerRect: RectLike,
  items: ReadonlyArray<{ id: string; rect: RectLike }>,
  vertical: boolean,
): string | null {
  let closestId: string | null = null;
  let closestDist = Infinity;
  for (const { id, rect } of items) {
    if (!intersectsBlockAxis(containerRect, rect, vertical)) continue;
    const dist = Math.abs(getBlockStartOffset(containerRect, rect, vertical));
    if (dist < closestDist) {
      closestDist = dist;
      closestId = id;
    }
  }
  return closestId;
}

export function canScrollBlockAxis(
  el: {
    scrollHeight: number;
    clientHeight: number;
    scrollWidth: number;
    clientWidth: number;
  },
  vertical: boolean,
): boolean {
  return vertical
    ? el.scrollWidth > el.clientWidth
    : el.scrollHeight > el.clientHeight;
}

/** Pre-mount margin for the linear view's IntersectionObserver. */
export function getLinearRootMargin(vertical: boolean): string {
  return vertical ? "0px 200%" : "200% 0px";
}
