// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StripeBandContextMenu } from "./StripeBandContextMenu";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("StripeBandContextMenu", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      hiddenStripePanels: new Set(),
    });
  });

  async function openToolBandMenu(region: "left" | "right" = "left") {
    const slotId =
      region === "left"
        ? useLayoutStore.getState().layout.regions.left.slots[0].id
        : useLayoutStore.getState().layout.regions.right.slots[0].id;
    render(
      <StripeBandContextMenu region={region} slotId={slotId} bandKind="tool">
        <div data-testid="stripe-band-target">band</div>
      </StripeBandContextMenu>,
    );
    const user = userEvent.setup();
    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByTestId("stripe-band-target"),
    });
    return user;
  }

  it("shows add panel, collapse, and remove-all for tool bands", async () => {
    await openToolBandMenu();
    expect(screen.getByTestId("stripe-band-ctx-add-panel")).toBeTruthy();
    expect(screen.getByTestId("stripe-band-ctx-collapse")).toBeTruthy();
    expect(screen.getByTestId("stripe-band-ctx-remove-all")).toBeTruthy();
  });

  it("shows add panel and collapse (not remove-all) for center editor bands", async () => {
    render(
      <StripeBandContextMenu region="center" slotId="ceditor" bandKind="editor">
        <div data-testid="stripe-band-target">band</div>
      </StripeBandContextMenu>,
    );
    const user = userEvent.setup();
    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByTestId("stripe-band-target"),
    });

    expect(screen.getByTestId("stripe-band-ctx-add-panel")).toBeTruthy();
    expect(screen.getByTestId("stripe-band-ctx-collapse")).toBeTruthy();
    expect(screen.queryByTestId("stripe-band-ctx-remove-all")).toBeNull();
  });

  it("opens the shared panel picker in the add-panel submenu", async () => {
    const leftSlotId =
      useLayoutStore.getState().layout.regions.left.slots[0].id;
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(
      <StripeBandContextMenu region="left" slotId={leftSlotId} bandKind="tool">
        <div data-testid="stripe-band-target">band</div>
      </StripeBandContextMenu>,
    );

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByTestId("stripe-band-target"),
    });
    await user.hover(screen.getByTestId("stripe-band-ctx-add-panel"));

    await waitFor(() => {
      expect(screen.getAllByTestId("panel-pick-item-chat").length).toBeGreaterThan(
        0,
      );
    });
  });

  it("collapses the region from the band menu", async () => {
    useLayoutStore.getState().showPanel("scenes");
    const user = await openToolBandMenu();
    await user.click(screen.getByTestId("stripe-band-ctx-collapse"));

    expect(
      useLayoutStore
        .getState()
        .layout.regions.left.slots.every((slot) => slot.activePanel === null),
    ).toBe(true);
  });

  it("removes all panels in the region from the stripe", async () => {
    useLayoutStore.getState().showPanel("chat");
    const user = await openToolBandMenu("right");
    await user.click(screen.getByTestId("stripe-band-ctx-remove-all"));

    expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(true);
  });
});
