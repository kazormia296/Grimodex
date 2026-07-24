// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CategoryNav } from "./CategoryNav";

vi.mock("@/features/license/store", () => ({
  useLicenseStore: (
    selector: (state: { licensingEnabled: boolean }) => unknown,
  ) => selector({ licensingEnabled: false }),
}));

vi.mock("@/features/updater/UpdateDot", () => ({
  UpdateDot: () => null,
}));

describe("CategoryNav mobile layout", () => {
  it("keeps categories in a horizontally scrollable single row", () => {
    render(<CategoryNav active="project" onChange={vi.fn()} phoneWorkspace />);

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).toHaveAttribute("data-phone-category-nav", "true");
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).not.toContain("flex-col");
    expect(screen.getByRole("button", { name: /Project/ }).className).toContain(
      "whitespace-nowrap",
    );
  });

  it("retains the vertical desktop navigation", () => {
    render(<CategoryNav active="project" onChange={vi.fn()} />);

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).not.toHaveAttribute("data-phone-category-nav");
    expect(nav.className).toContain("flex-col");
    expect(nav.className).toContain("w-[120px]");
  });
});
