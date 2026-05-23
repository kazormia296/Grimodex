// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState, findPanelLocation } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("ToolWindowIcon context menu", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      hiddenStripePanels: new Set(),
    });
    useLayoutStore.getState().showPanel("scenes");
  });

  it("removes an active panel from the stripe", async () => {
    const slotId = findPanelLocation(
      useLayoutStore.getState().layout,
      "scenes",
    )!.slot.id;
    render(
      <ToolWindowIcon
        region="left"
        panelId="scenes"
        slotId={slotId}
        active
        slotOpen
      />,
    );
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    await user.click(
      await screen.findByTestId("ctx-remove-from-stripe-scenes"),
    );

    expect(useLayoutStore.getState().hiddenStripePanels.has("scenes")).toBe(
      true,
    );
    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(false);
  });

  it("shows remove from sidebar even when the panel is inactive", async () => {
    useLayoutStore.getState().togglePanel("scenes");
    const slotId = findPanelLocation(
      useLayoutStore.getState().layout,
      "scenes",
    )!.slot.id;
    render(
      <ToolWindowIcon
        region="left"
        panelId="scenes"
        slotId={slotId}
        active={false}
        slotOpen={false}
      />,
    );
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    await user.click(
      await screen.findByTestId("ctx-remove-from-stripe-scenes"),
    );

    expect(useLayoutStore.getState().hiddenStripePanels.has("scenes")).toBe(
      true,
    );
  });
});
