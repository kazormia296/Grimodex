import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, KEY_SCOPE } from "@/features/settings/types";
import {
  buildEditorContentStyle,
  buildEditorMeasureStyle,
  canScrollBlockAxis,
  getBlockStartOffset,
  getLinearRootMargin,
  getLogicalScrollOffset,
  intersectsBlockAxis,
  pickActiveSceneId,
  resolveEditorFontFamily,
  setLogicalScrollOffset,
} from "./editorLayout";

function rect(top: number, bottom: number, left: number, right: number) {
  return { top, bottom, left, right };
}

describe("editor.verticalMode setting registration", () => {
  // KEY_SCOPE 登録漏れだと settingsStore が legacy app_settings に永続化して
  // しまい per-project にならない。デフォルトと合わせてここで gate する。
  it("is registered as a project-scope key with a default", () => {
    expect(KEY_SCOPE["editor.verticalMode"]).toBe("project");
    expect(DEFAULT_SETTINGS["editor.verticalMode"]).toBe("false");
  });
});

describe("editor.textAutospace setting registration", () => {
  // 和欧間スペーシング (text-autospace) は作品ごとの組版選択なので
  // wordBreak / lineBreak と同じ project スコープ。デフォルトは normal —
  // WebKit のデフォルトは no-autospace なので、明示しないと和欧間アキが
  // 効かない（仕様本来の既定値である normal を明示する）。
  it("is registered as a project-scope key defaulting to normal", () => {
    expect(KEY_SCOPE["editor.textAutospace"]).toBe("project");
    expect(DEFAULT_SETTINGS["editor.textAutospace"]).toBe("normal");
  });
});

describe("buildEditorContentStyle / buildEditorMeasureStyle", () => {
  const settings = {
    fontFamily: '"Noto Serif JP"',
    fontSize: 18,
    lineHeight: 2,
    maxContentWidth: 720,
    wordBreak: "normal",
    lineBreak: "strict",
    textAutospace: "normal",
    paragraphIndent: 1,
    paragraphSpacing: 8,
  };

  it("emits logical properties for the line-length cap and centering", () => {
    const style = buildEditorContentStyle(settings);
    expect(style.maxInlineSize).toBe("720px");
    expect(style.marginBlock).toBe(0);
    expect(style.marginInline).toBe("auto");
    // 物理プロパティは出力しない（writing-mode 両対応の要）
    expect(style).not.toHaveProperty("maxWidth");
    expect(style).not.toHaveProperty("margin");
  });

  it("passes typography settings through", () => {
    const style = buildEditorContentStyle(settings) as Record<string, unknown>;
    expect(style.fontFamily).toBe('"Noto Serif JP"');
    expect(style.fontSize).toBe("18px");
    expect(style.lineHeight).toBe(2);
    expect(style.wordBreak).toBe("normal");
    expect(style.lineBreak).toBe("strict");
    // editor.textAutospace（和欧間スペーシング）の配線漏れ再発防止。
    // 設定UIのみ存在し本文に届かないバグの regression gate。
    expect(style.textAutospace).toBe("normal");
    expect(style["--editor-paragraph-indent"]).toBe("1em");
    // editor.paragraphSpacing 設定の配線漏れ再発防止（設定UIのみ存在し
    // 本文に届かないバグの regression gate）
    expect(style["--editor-paragraph-spacing"]).toBe("8px");
  });

  it("measure style is the subset used by the linear outer wrapper", () => {
    expect(buildEditorMeasureStyle(480)).toEqual({
      maxInlineSize: "480px",
      marginBlock: 0,
      marginInline: "auto",
    });
  });
});

describe("logical scroll offset", () => {
  it("passes through scrollTop in horizontal mode", () => {
    const el = { scrollTop: 120, scrollLeft: 0 };
    expect(getLogicalScrollOffset(el, false)).toBe(120);
    setLogicalScrollOffset(el, 300, false);
    expect(el.scrollTop).toBe(300);
    expect(el.scrollLeft).toBe(0);
  });

  it("negates scrollLeft in vertical mode (Chromium vertical-rl convention)", () => {
    const el = { scrollTop: 0, scrollLeft: -150 };
    expect(getLogicalScrollOffset(el, true)).toBe(150);
    setLogicalScrollOffset(el, 100, true);
    expect(el.scrollLeft).toBe(-100);
    expect(el.scrollTop).toBe(0);
  });

  it("round-trips and treats offset 0 as the start edge", () => {
    const el = { scrollTop: 0, scrollLeft: 0 };
    for (const vertical of [false, true]) {
      setLogicalScrollOffset(el, 42, vertical);
      expect(getLogicalScrollOffset(el, vertical)).toBe(42);
      setLogicalScrollOffset(el, 0, vertical);
      expect(getLogicalScrollOffset(el, vertical)).toBe(0);
    }
  });
});

describe("getBlockStartOffset", () => {
  const container = rect(100, 500, 200, 800);

  it("horizontal: distance from container top to rect top", () => {
    expect(getBlockStartOffset(container, rect(160, 300, 0, 0), false)).toBe(
      60,
    );
    expect(getBlockStartOffset(container, rect(40, 90, 0, 0), false)).toBe(-60);
  });

  it("vertical: distance from container right to rect right", () => {
    // vertical-rl の block-start は右端。コンテナ右端 800 から rect 右端 740 まで 60。
    expect(getBlockStartOffset(container, rect(0, 0, 600, 740), true)).toBe(60);
    expect(getBlockStartOffset(container, rect(0, 0, 820, 860), true)).toBe(
      -60,
    );
  });
});

describe("intersectsBlockAxis", () => {
  const container = rect(100, 500, 200, 800);

  it("matches the linear view's horizontal visibility test", () => {
    expect(intersectsBlockAxis(container, rect(50, 99, 0, 0), false)).toBe(
      false,
    );
    expect(intersectsBlockAxis(container, rect(50, 150, 0, 0), false)).toBe(
      true,
    );
    expect(intersectsBlockAxis(container, rect(501, 600, 0, 0), false)).toBe(
      false,
    );
    // 境界接触（bottom === container.top）は既存実装どおり可視扱い
    expect(intersectsBlockAxis(container, rect(50, 100, 0, 0), false)).toBe(
      true,
    );
  });

  it("vertical: tests overlap along the horizontal axis", () => {
    expect(intersectsBlockAxis(container, rect(0, 0, 100, 199), true)).toBe(
      false,
    );
    expect(intersectsBlockAxis(container, rect(0, 0, 100, 250), true)).toBe(
      true,
    );
    expect(intersectsBlockAxis(container, rect(0, 0, 801, 900), true)).toBe(
      false,
    );
  });
});

describe("pickActiveSceneId", () => {
  const container = rect(100, 500, 200, 800);

  it("horizontal: picks the visible scene closest to the container top", () => {
    // LinearEditorView の既存 IntersectionObserver ループと同値の振る舞いを固定
    const items = [
      { id: "above", rect: rect(-200, 99, 0, 0) }, // 不可視
      { id: "first", rect: rect(80, 300, 0, 0) }, // |80-100| = 20
      { id: "second", rect: rect(300, 700, 0, 0) }, // |300-100| = 200
    ];
    expect(pickActiveSceneId(container, items, false)).toBe("first");
  });

  it("vertical: picks the visible scene closest to the container right edge", () => {
    const items = [
      { id: "offscreen", rect: rect(0, 0, 810, 900) }, // 右外
      { id: "first", rect: rect(0, 0, 500, 790) }, // |800-790| = 10
      { id: "second", rect: rect(0, 0, 250, 500) }, // |800-500| = 300
    ];
    expect(pickActiveSceneId(container, items, true)).toBe("first");
  });

  it("returns null when nothing is visible", () => {
    const items = [{ id: "a", rect: rect(600, 700, 0, 0) }];
    expect(pickActiveSceneId(container, items, false)).toBeNull();
    expect(pickActiveSceneId(container, [], true)).toBeNull();
  });
});

describe("canScrollBlockAxis / getLinearRootMargin", () => {
  it("checks the scrollable axis per mode", () => {
    const el = {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollWidth: 400,
      clientWidth: 400,
    };
    expect(canScrollBlockAxis(el, false)).toBe(true);
    expect(canScrollBlockAxis(el, true)).toBe(false);
  });

  it("swaps the pre-mount margin axis", () => {
    expect(getLinearRootMargin(false)).toBe("200% 0px");
    expect(getLinearRootMargin(true)).toBe("0px 200%");
  });
});

describe("resolveEditorFontFamily — WebKitGTK 縦書きの vert フォント解決", () => {
  it("横書き or 非 WebKitGTK では変換せずユーザ設定をそのまま返す", () => {
    const f = '"Noto Serif JP"';
    // 横書き
    expect(
      resolveEditorFontFamily(f, { vertical: false, webkitGtk: true }),
    ).toBe(f);
    // 非 WebKitGTK（Chromium 等は Unicode 縦書き字形フォールバック内蔵）
    expect(
      resolveEditorFontFamily(f, { vertical: true, webkitGtk: false }),
    ).toBe(f);
    // 両方 false
    expect(
      resolveEditorFontFamily(f, { vertical: false, webkitGtk: false }),
    ).toBe(f);
  });

  it("WebKitGTK 縦書き: 同梱明朝はシステム CJK 明朝を先頭へ差し替える（元指定は残す）", () => {
    const out = resolveEditorFontFamily('"Noto Serif JP"', {
      vertical: true,
      webkitGtk: true,
    });
    // vert を持つシステムフォントが先頭
    expect(out.startsWith('"Noto Serif CJK JP", "Source Han Serif JP"')).toBe(
      true,
    );
    // ユーザ選択（元の指定）も残る＝システムに無ければ従来どおりにフォールバック
    expect(out).toContain('"Noto Serif JP"');
    // 汎用 CJK フォールバック
    expect(out).toContain("serif");
  });

  it("WebKitGTK 縦書き: 同梱ゴシックは vert を持つシステムゴシックへ差し替える", () => {
    const out = resolveEditorFontFamily('"M PLUS 1"', {
      vertical: true,
      webkitGtk: true,
    });
    expect(out.startsWith('"Noto Sans CJK JP", "Source Han Sans JP"')).toBe(
      true,
    );
    expect(out).toContain('"M PLUS 1"');
  });

  it("WebKitGTK 縦書き: 未知（＝ユーザ指定システムフォント）は尊重し CJK フォールバックのみ足す", () => {
    const out = resolveEditorFontFamily('"Yu Mincho"', {
      vertical: true,
      webkitGtk: true,
    });
    // ユーザ選択が先頭で尊重される
    expect(out.startsWith('"Yu Mincho"')).toBe(true);
    // vert を持つ CJK フォールバックが末尾に付く
    expect(out).toContain('"Noto Serif CJK JP"');
  });
});
