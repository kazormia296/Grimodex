// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Splitter } from "./Splitter";
import { PANEL_GAP_PX, STRIPE_GAP_PX } from "./layoutConstants";

describe("Splitter", () => {
  it("sizes a column divider by its thickness for horizontal orientation", () => {
    render(
      <div className="flex h-40 w-40">
        <Splitter orientation="horizontal" onDrag={() => {}} />
      </div>,
    );
    const el = screen.getByRole("separator");
    expect(el.style.width).toBe(`${STRIPE_GAP_PX}px`);
    expect(el.style.height).toBe("100%");
    expect(el.className).toContain("cursor-col-resize");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("sizes a row divider by its thickness for vertical orientation", () => {
    render(
      <div className="flex h-40 w-40 flex-col">
        <Splitter orientation="vertical" onDrag={() => {}} />
      </div>,
    );
    const el = screen.getByRole("separator");
    expect(el.style.height).toBe(`${STRIPE_GAP_PX}px`);
    expect(el.style.width).toBe("100%");
    expect(el.className).toContain("cursor-row-resize");
    expect(el.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("honours an explicit thickness prop", () => {
    render(
      <div className="flex h-40 w-40">
        <Splitter
          orientation="horizontal"
          thickness={PANEL_GAP_PX}
          onDrag={() => {}}
        />
      </div>,
    );
    const el = screen.getByRole("separator");
    expect(el.style.width).toBe(`${PANEL_GAP_PX}px`);
  });

  it("stretches the SplitterHandle's cross axis so chrome's percentage does not collapse", () => {
    // Regression: SplitterHandle に何も class が無いと、flex-row 親の slot
    // splitter で main 軸 (width) が auto = 0 に潰れ、内側 chrome の
    // width:100% が 0 px になりヒット領域が消える。w-full でこの軸を埋める。
    render(
      <div className="flex h-40 w-40 flex-col">
        <Splitter orientation="vertical" onDrag={() => {}} />
      </div>,
    );
    const handle = document.querySelector<HTMLElement>(
      "[data-splitter-handle]",
    );
    expect(handle).not.toBeNull();
    expect(handle!.className).toContain("w-full");
    // h-full を付けると flex-col 親に直接乗るケース (bottom region splitter)
    // で grid cell 全体を占有してしまい、bottom panel が画面外にはみ出る。
    expect(handle!.className).not.toContain("h-full");
  });

  describe("keyboard resize (keyboardResize)", () => {
    it("is not focusable and has no aria-value when keyboardResize is off (slot splitter)", () => {
      render(
        <div className="flex h-40 w-40">
          <Splitter orientation="horizontal" onDrag={() => {}} />
        </div>,
      );
      const el = screen.getByRole("separator");
      expect(el.getAttribute("tabindex")).toBeNull();
      expect(el.getAttribute("aria-valuenow")).toBeNull();
    });

    it("becomes a focusable window splitter with aria-value* when enabled", () => {
      render(
        <div className="flex h-40 w-40">
          <Splitter
            orientation="horizontal"
            onDrag={() => {}}
            keyboardResize
            ariaLabel="左パネルの幅を変更"
            ariaValueNow={260}
            ariaValueMin={120}
            ariaValueMax={1000}
            ariaValueText="260px"
          />
        </div>,
      );
      const el = screen.getByRole("separator");
      expect(el.getAttribute("tabindex")).toBe("0");
      expect(el).toHaveAttribute("aria-label", "左パネルの幅を変更");
      expect(el).toHaveAttribute("aria-valuenow", "260");
      expect(el).toHaveAttribute("aria-valuemin", "120");
      expect(el).toHaveAttribute("aria-valuemax", "1000");
      expect(el).toHaveAttribute("aria-valuetext", "260px");
    });

    it("is tab-unreachable (tabindex -1) when disabled", () => {
      render(
        <div className="flex h-40 w-40">
          <Splitter
            orientation="horizontal"
            disabled
            onDrag={() => {}}
            keyboardResize
            ariaValueNow={260}
          />
        </div>,
      );
      expect(screen.getByRole("separator").getAttribute("tabindex")).toBe("-1");
    });

    it("maps horizontal arrows to +/- delta matching pointer semantics", () => {
      const onDrag = vi.fn();
      render(
        <div className="flex h-40 w-40">
          <Splitter
            orientation="horizontal"
            onDrag={onDrag}
            keyboardResize
            ariaValueNow={260}
          />
        </div>,
      );
      const el = screen.getByRole("separator");
      fireEvent.keyDown(el, { key: "ArrowRight" });
      fireEvent.keyDown(el, { key: "ArrowLeft" });
      expect(onDrag.mock.calls[0][0]).toBeGreaterThan(0);
      expect(onDrag.mock.calls[1][0]).toBeLessThan(0);
    });

    it("maps vertical arrows to +/- delta and ignores cross-axis keys", () => {
      const onDrag = vi.fn();
      render(
        <div className="flex h-40 w-40 flex-col">
          <Splitter
            orientation="vertical"
            onDrag={onDrag}
            keyboardResize
            ariaValueNow={220}
          />
        </div>,
      );
      const el = screen.getByRole("separator");
      fireEvent.keyDown(el, { key: "ArrowDown" });
      fireEvent.keyDown(el, { key: "ArrowUp" });
      // 横バーは左右キーを無視する
      fireEvent.keyDown(el, { key: "ArrowRight" });
      expect(onDrag).toHaveBeenCalledTimes(2);
      expect(onDrag.mock.calls[0][0]).toBeGreaterThan(0);
      expect(onDrag.mock.calls[1][0]).toBeLessThan(0);
    });

    it("does not respond to keys when disabled", () => {
      const onDrag = vi.fn();
      render(
        <div className="flex h-40 w-40">
          <Splitter
            orientation="horizontal"
            disabled
            onDrag={onDrag}
            keyboardResize
            ariaValueNow={260}
          />
        </div>,
      );
      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
      expect(onDrag).not.toHaveBeenCalled();
    });
  });
});
