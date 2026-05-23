// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState, findPanelLocation } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ToolWindowIcon DnD hit testing", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      hiddenStripePanels: new Set(),
    });
  });

  it("disables pointer events on icons while another panel is dragged", () => {
    useLayoutStore.setState({ draggingPanel: "codex" });
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
        slotOpen
      />,
    );

    expect(screen.getByRole("button").className).toContain(
      "pointer-events-none",
    );
  });
});
