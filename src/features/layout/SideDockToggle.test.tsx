// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SideDockToggle } from "./SideDockToggle";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SideDockToggle", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
    });
  });

  it("is pressed while the side region has an open panel", () => {
    useLayoutStore.getState().showPanel("scenes");
    render(<SideDockToggle region="left" />);
    expect(screen.getByRole("button", { pressed: true })).toBeDefined();
  });

  it("is not pressed while the side region is collapsed", () => {
    render(<SideDockToggle region="left" />);
    expect(screen.getByRole("button", { pressed: false })).toBeDefined();
  });

  it("collapses the left region when clicked while open", async () => {
    useLayoutStore.getState().showPanel("scenes");
    render(<SideDockToggle region="left" />);
    await userEvent.setup().click(screen.getByRole("button"));
    const left = useLayoutStore.getState().layout.regions.left.slots;
    expect(left.every((s) => s.activePanel === null)).toBe(true);
  });

  it("expands the left region when clicked while collapsed", async () => {
    render(<SideDockToggle region="left" />);
    await userEvent.setup().click(screen.getByRole("button"));
    const left = useLayoutStore.getState().layout.regions.left.slots;
    expect(left.some((s) => s.activePanel !== null)).toBe(true);
  });

  it("restores a mixed left-region state across hide and show", async () => {
    useLayoutStore.getState().showPanel("scenes");
    render(<SideDockToggle region="left" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    const left = useLayoutStore.getState().layout.regions.left.slots;
    expect(left.find((slot) => slot.id === "l0")?.activePanel).toBe("scenes");
    expect(left.find((slot) => slot.id === "l1")?.activePanel).toBeNull();
  });

  it("controls the right region when region is 'right'", async () => {
    render(<SideDockToggle region="right" />);
    await userEvent.setup().click(screen.getByRole("button"));
    const right = useLayoutStore.getState().layout.regions.right.slots;
    expect(right.some((s) => s.activePanel !== null)).toBe(true);
  });
});
