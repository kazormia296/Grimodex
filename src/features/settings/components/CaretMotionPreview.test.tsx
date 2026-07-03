// @vitest-environment happy-dom
//
// CaretMotionPreview（スムースキャレット設定のサンドボックス）のテスト。
// gate しているのは
//   - トリガボタンでポップオーバーが開閉すること
//   - 開いている間、疑似キャレットが自動で進むこと（fake timers）
//   - サンプル文字クリックでキャレットがその位置へ移動する（index 更新）こと
// 実ピクセル位置は happy-dom では測れないため data-caret-index で gate する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { CaretMotionPreview } from "./CaretMotionPreview";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// 設定の読み書きは useSettingNumber 経由。永続化 (IPC) を避けつつ
// リセットボタンの書き込みを検証できるようスパイでモックする。
const h = vi.hoisted(() => ({
  values: {} as Record<string, number>,
  setSpy: vi.fn() as (key: string, v: number) => void,
}));
vi.mock("../useSettingControl", () => ({
  useSettingNumber: (key: string, def: number) => ({
    value: h.values[key] ?? def,
    setValue: (v: number) => h.setSpy(key, v),
  }),
}));

describe("CaretMotionPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.values = {};
    h.setSpy = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function openPreview() {
    render(<CaretMotionPreview />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.editor.caretMotionPreviewOpen",
      }),
    );
  }

  it("トリガボタンでサンドボックスが開く", () => {
    openPreview();
    expect(document.querySelector(".caret-preview-caret")).not.toBeNull();
  });

  it("自動再生でキャレットが進む", () => {
    openPreview();
    const sandbox = document.querySelector("[data-caret-index]") as HTMLElement;
    const before = Number(sandbox.dataset.caretIndex);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const after = Number(sandbox.dataset.caretIndex);
    expect(after).not.toBe(before);
  });

  it("外側クリックでは閉じない (スライダーを弄りながら見られる)", () => {
    openPreview();
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(document.querySelector("[data-caret-index]")).not.toBeNull();
  });

  it("閉じるボタンで閉じる", async () => {
    openPreview();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    // AnimatePresence の exit アニメは fake timers では進まないため実タイマーで待つ
    vi.useRealTimers();
    await waitFor(() =>
      expect(document.querySelector("[data-caret-index]")).toBeNull(),
    );
  });

  it("手動操作 (クリック/キー) で自動再生が止まる", () => {
    openPreview();
    const chars = document.querySelectorAll("[data-preview-char]");
    fireEvent.click(chars[5]);
    const sandbox = document.querySelector("[data-caret-index]") as HTMLElement;
    expect(sandbox.dataset.caretIndex).toBe("5");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(sandbox.dataset.caretIndex).toBe("5");
  });

  it("開くとサンドボックスへフォーカスされ矢印キーが即効く", () => {
    openPreview();
    const sandbox = document.querySelector("[data-caret-index]") as HTMLElement;
    expect(document.activeElement).toBe(sandbox);
  });

  it("キーボード (←/→/Home/End) でキャレットを動かせる", () => {
    openPreview();
    const sandbox = document.querySelector("[data-caret-index]") as HTMLElement;
    fireEvent.keyDown(sandbox, { key: "ArrowRight" });
    expect(sandbox.dataset.caretIndex).toBe("1");
    fireEvent.keyDown(sandbox, { key: "End" });
    expect(Number(sandbox.dataset.caretIndex)).toBeGreaterThan(1);
    fireEvent.keyDown(sandbox, { key: "Home" });
    expect(sandbox.dataset.caretIndex).toBe("0");
  });

  it("エディタ未マウントでも開くと CSS 変数が :root へ書かれる", () => {
    document.documentElement.style.removeProperty("--caret-slide-duration");
    openPreview();
    expect(
      document.documentElement.style.getPropertyValue("--caret-slide-duration"),
    ).toBe("80ms");
  });

  it("disabled のときトリガボタンが無効になる", () => {
    render(<CaretMotionPreview disabled />);
    const btn = screen.getByRole("button", {
      name: "settings.editor.caretMotionPreviewOpen",
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("サンプル文字のクリックでその位置へ移動する", () => {
    openPreview();
    const chars = document.querySelectorAll("[data-preview-char]");
    expect(chars.length).toBeGreaterThan(5);
    fireEvent.click(chars[5]);
    const sandbox = document.querySelector("[data-caret-index]") as HTMLElement;
    expect(sandbox.dataset.caretIndex).toBe("5");
  });
});
