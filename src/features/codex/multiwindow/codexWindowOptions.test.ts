import { describe, it, expect } from "vitest";
import { buildCodexWindowOptions } from "./codexWindowOptions";
import { CODEX_WINDOW_LABEL } from "./codexWindowMode";

describe("buildCodexWindowOptions", () => {
  const opts = buildCodexWindowOptions();

  it("label は codex-window（capability scope と一致）", () => {
    expect(opts.label).toBe(CODEX_WINDOW_LABEL);
  });

  it("url は panel-only マウントに分岐する ?window=codex を含む", () => {
    expect(opts.url).toContain("window=codex");
  });

  it("glass shell 前提に合わせ transparent / decorations:false を継承する", () => {
    // 指定しないと現 UI(glass)が崩れる(検討メモ §4.1)。
    expect(opts.transparent).toBe(true);
    expect(opts.decorations).toBe(false);
  });

  it("初期サイズが指定されている（参照しやすい縦長）", () => {
    expect(typeof opts.width).toBe("number");
    expect(typeof opts.height).toBe("number");
    expect(opts.width).toBeGreaterThan(0);
    expect(opts.height).toBeGreaterThan(0);
  });
});
