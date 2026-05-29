/**
 * 実 Chromium で resolveEditorTheme の色解決を検証する。happy-dom は
 * var()/oklch/color-mix を解決しないため、probe+getComputedStyle が canvas に
 * 塗れる色を返すことは実ブラウザでしか確認できない。
 *
 * 検証は「rgb 文字列か」ではなく **同一エンジンの canvas が実際に塗れるか**
 * (painted pixel の alpha / 輝度) で行う。getComputedStyle が oklch() を保持しても
 * 同エンジンの canvas fillStyle はそれを受け付けるため、これが faithful な判定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEditorTheme } from "./resolveEditorTheme";
import { useAttributionStore } from "@/features/attribution/attributionStore";

const CSS = `
:root {
  --content-background: oklch(0.97 0.02 95);
  --content-foreground: oklch(0.2 0.02 95);
  --attribution-pct: 20%;
}
.attribution-ai {
  background-color: color-mix(in oklch, oklch(0.72 0.2 165) var(--attribution-pct), var(--content-background));
}
.attribution-unknown {
  background-color: color-mix(in oklch, oklch(0.72 0.14 30) var(--attribution-pct), var(--content-background));
}
.tiptap { font-family: Georgia, serif; font-size: 18px; line-height: 2; }
`;

function paint(color: string): [number, number, number, number] {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d ctx");
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

let styleEl: HTMLStyleElement;
let tiptap: HTMLDivElement;

beforeEach(() => {
  styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  tiptap = document.createElement("div");
  tiptap.className = "tiptap";
  document.body.appendChild(tiptap);
  useAttributionStore.setState({ showAttribution: false });
});

afterEach(() => {
  styleEl.remove();
  tiptap.remove();
});

describe("resolveEditorTheme (real browser)", () => {
  it("resolves theme vars (oklch / color-mix) to canvas-paintable colours", () => {
    const t = resolveEditorTheme();
    for (const c of [
      t.background,
      t.text,
      t.attributionAi,
      t.attributionUnknown,
    ]) {
      const [, , , a] = paint(c);
      // opaque → the engine accepted the colour and painted it (a rejected
      // fillStyle would leave the cleared transparent pixel, a === 0).
      expect(a).toBe(255);
    }
    // background (paper) is lighter than text (ink) → both resolved to real,
    // distinct colours rather than both collapsing to a fallback.
    const [br, bg, bb] = paint(t.background);
    const [tr, tg, tb] = paint(t.text);
    expect(br + bg + bb).toBeGreaterThan(tr + tg + tb);
  });

  it("picks up the editor font metrics from the live .tiptap node", () => {
    const t = resolveEditorTheme();
    expect(t.fontFamily.toLowerCase()).toContain("georgia");
    expect(t.fontSizePx).toBe(18);
    expect(t.lineHeightPx).toBe(36); // 18px * line-height 2
  });

  it("reflects the live showAttribution setting", () => {
    useAttributionStore.setState({ showAttribution: true });
    expect(resolveEditorTheme().showAttribution).toBe(true);
    useAttributionStore.setState({ showAttribution: false });
    expect(resolveEditorTheme().showAttribution).toBe(false);
  });
});
