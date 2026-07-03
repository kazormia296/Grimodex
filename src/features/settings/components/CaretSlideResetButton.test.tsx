// @vitest-environment happy-dom
//
// CaretSlideResetButton のテスト。gate しているのは
//   - クリックで duration/snappiness の両設定が既定値へ書き戻されること
//   - 両方とも既定値のときはボタンが無効なこと
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CaretSlideResetButton } from "./CaretSlideResetButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

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

describe("CaretSlideResetButton", () => {
  beforeEach(() => {
    h.values = {};
    h.setSpy = vi.fn();
  });

  it("クリックで両設定が既定値へ書き戻される", () => {
    h.values = {
      "editor.caretSlideDuration": 200,
      "editor.caretSlideSnappiness": 100,
    };
    render(<CaretSlideResetButton />);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.editor.caretMotionReset" }),
    );
    expect(h.setSpy).toHaveBeenCalledWith("editor.caretSlideDuration", 80);
    expect(h.setSpy).toHaveBeenCalledWith("editor.caretSlideSnappiness", 50);
  });

  it("既定値のままのときは無効", () => {
    render(<CaretSlideResetButton />);
    const btn = screen.getByRole("button", {
      name: "settings.editor.caretMotionReset",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
