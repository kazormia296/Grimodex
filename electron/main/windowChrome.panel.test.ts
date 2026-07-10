/**
 * パネル別窓の純関数部の単体テスト（設計書 §6.5、Phase 2 S7 —
 * label 検証 / URL は main が組み立て / window-state 復元優先）。
 */
import { describe, expect, it } from "vitest";

import {
  buildPanelUrl,
  buildPanelWindowOptions,
  isValidPanelLabel,
  PANEL_WINDOW_DEFAULTS,
} from "./windowChrome.js";

// ─────────────────────────────────────────────────────────────────────────────
// isValidPanelLabel（Tauri capability windows scope `panel-*` の代替ガード）
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidPanelLabel", () => {
  it.each(["panel-codex", "panel-chat", "panel-snippet-2", "panel-a"])(
    "%s を受理する",
    (label) => {
      expect(isValidPanelLabel(label)).toBe(true);
    },
  );

  it.each([
    "main", // パネル以外の label で registry を上書きさせない
    "panel-", // 空 id
    "panel-Codex", // 大文字
    "panel-codex?window=main", // クエリ注入
    "panel-codex/../main", // パス風注入
    "panel-コデックス", // 非 ASCII
    "xpanel-codex", // プレフィックス不一致
    "",
  ])("%s を拒否する", (label) => {
    expect(isValidPanelLabel(label)).toBe(false);
  });

  it("文字列以外を拒否する", () => {
    expect(isValidPanelLabel(null)).toBe(false);
    expect(isValidPanelLabel(42)).toBe(false);
    expect(isValidPanelLabel({ label: "panel-codex" })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPanelUrl（renderer 供給 URL は受け取らない — main が label から組み立て）
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPanelUrl", () => {
  it("dev: ELECTRON_RENDERER_URL 起点で ?window=panel&panel=<id> を組み立てる", () => {
    expect(buildPanelUrl("http://localhost:1430", "panel-codex")).toBe(
      "http://localhost:1430/?window=panel&panel=codex",
    );
  });

  it("dev: 末尾スラッシュ付き base でも二重スラッシュにしない", () => {
    expect(buildPanelUrl("http://localhost:1430/", "panel-codex")).toBe(
      "http://localhost:1430/?window=panel&panel=codex",
    );
  });

  it("prod: app://bundle/index.html 起点（§6.5。app:// 実装は S8）", () => {
    expect(buildPanelUrl(undefined, "panel-chat")).toBe(
      "app://bundle/index.html?window=panel&panel=chat",
    );
  });

  it("id は label から panel- プレフィックスを剥がしたもの（parsePanelWindowTarget の受理形式）", () => {
    expect(buildPanelUrl("http://localhost:1430", "panel-snippet-2")).toBe(
      "http://localhost:1430/?window=panel&panel=snippet-2",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPanelWindowOptions（§6.5: transparent / frame:false / 480×900 /
// label 別 window-state 復元）
// ─────────────────────────────────────────────────────────────────────────────

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

describe("buildPanelWindowOptions", () => {
  it("既定は frame:false + transparent + show:false（全 OS — Tauri の decorations:false 相当）", () => {
    const { options, startMaximized } = buildPanelWindowOptions({
      savedState: undefined,
      displayWorkAreas: [WORK_AREA],
      requested: { width: 480, height: 900, title: "Codex" },
    });
    expect(options.frame).toBe(false);
    expect(options.transparent).toBe(true);
    expect(options.backgroundColor).toBe("#00000000");
    expect(options.show).toBe(false);
    expect(options.title).toBe("Codex");
    expect(options.width).toBe(480);
    expect(options.height).toBe(900);
    expect(startMaximized).toBe(false);
  });

  it.each([
    ["負値", -100],
    ["ゼロ", 0],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["文字列", "900"],
    ["未指定", undefined],
  ])("renderer 供給サイズを信用しない: %s はデフォルトへ", (_name, bad) => {
    const { options } = buildPanelWindowOptions({
      savedState: undefined,
      displayWorkAreas: [WORK_AREA],
      requested: { width: bad, height: bad, title: "Codex" },
    });
    expect(options.width).toBe(PANEL_WINDOW_DEFAULTS.width);
    expect(options.height).toBe(PANEL_WINDOW_DEFAULTS.height);
  });

  it("title が文字列でなければフォールバックする", () => {
    const { options } = buildPanelWindowOptions({
      savedState: undefined,
      displayWorkAreas: [WORK_AREA],
      requested: { width: 480, height: 900, title: { evil: true } },
    });
    expect(options.title).toBe("Grimodex");
  });

  it("保存済み window-state は requested サイズより優先して復元する", () => {
    const { options } = buildPanelWindowOptions({
      savedState: {
        bounds: { x: 100, y: 60, width: 640, height: 720 },
        maximized: false,
      },
      displayWorkAreas: [WORK_AREA],
      requested: { width: 480, height: 900, title: "Codex" },
    });
    expect(options.x).toBe(100);
    expect(options.y).toBe(60);
    expect(options.width).toBe(640);
    expect(options.height).toBe(720);
  });

  it("画面外の保存 bounds は捨てて requested サイズ + 既定位置に落とす", () => {
    const { options } = buildPanelWindowOptions({
      savedState: {
        bounds: { x: 99999, y: 99999, width: 640, height: 720 },
        maximized: false,
      },
      displayWorkAreas: [WORK_AREA],
      requested: { width: 480, height: 900, title: "Codex" },
    });
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect(options.width).toBe(480);
    expect(options.height).toBe(900);
  });

  it("maximized で保存されていれば startMaximized=true", () => {
    const { startMaximized } = buildPanelWindowOptions({
      savedState: {
        bounds: { x: 0, y: 0, width: 640, height: 720 },
        maximized: true,
      },
      displayWorkAreas: [WORK_AREA],
      requested: {},
    });
    expect(startMaximized).toBe(true);
  });
});
