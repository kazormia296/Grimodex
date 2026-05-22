// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
