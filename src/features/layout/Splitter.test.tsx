// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Splitter } from "./Splitter";

describe("Splitter", () => {
  it("renders a column divider with non-zero width for horizontal orientation", () => {
    render(
      <div className="flex h-40 w-40">
        <Splitter orientation="horizontal" onDrag={() => {}} />
      </div>,
    );
    const el = screen.getByRole("separator");
    expect(el.className).toContain("w-1.5");
    expect(el.className).toContain("h-full");
    expect(el.className).toContain("cursor-col-resize");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("renders a row divider with non-zero height for vertical orientation", () => {
    render(
      <div className="flex h-40 w-40 flex-col">
        <Splitter orientation="vertical" onDrag={() => {}} />
      </div>,
    );
    const el = screen.getByRole("separator");
    expect(el.className).toContain("h-1.5");
    expect(el.className).toContain("w-full");
    expect(el.className).toContain("cursor-row-resize");
    expect(el.getAttribute("aria-orientation")).toBe("horizontal");
  });
});
