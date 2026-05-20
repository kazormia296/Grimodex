// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useLayoutStore } from "./layoutStore";
import {
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
} from "./toolWindowDefaults";
import type { StripeSegment } from "./useStripeSegmentsByRegion";
import type { StripePanel } from "./useStripePanelsByRegion";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ToolWindowStripe } from "./ToolWindowStripe";

function resetStore() {
  useLayoutStore.setState({
    dockviewApi: null,
    toolWindows: {},
    undockedPanels: new Set(),
    stripePanelIds: new Set(),
    stripeSizes: { ...DEFAULT_STRIPE_SIZES },
    stripeVisibility: { ...DEFAULT_STRIPE_VISIBILITY },
  });
}

/** Helper: 1 segment fixture */
function seg(
  key: string,
  panels: StripePanel[],
  opts: { groupIds?: string[]; sizeRatio?: number } = {},
): StripeSegment {
  return {
    key,
    groupIds: opts.groupIds ?? [key],
    panels,
    sizeRatio: opts.sizeRatio ?? 1,
  };
}

describe("ToolWindowStripe (Y モデル)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns null when segments list is empty", () => {
    const { container } = render(
      <ToolWindowStripe region="left" orientation="vertical" segments={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an icon for each panel across segments", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        segments={[
          seg("g1", [
            { id: "scenes", slot: "LT", visible: true, active: true },
          ]),
          seg("g2", [
            {
              id: "command-center-results",
              slot: "LB",
              visible: false,
              active: false,
            },
          ]),
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "layout.panel.scenes" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "layout.panel.command-center-results",
      }),
    ).toBeTruthy();
  });

  it("shown icon has aria-pressed=true and data-state='shown'", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        segments={[
          seg("g1", [
            { id: "scenes", slot: "LT", visible: true, active: true },
          ]),
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("data-state")).toBe("shown");
  });

  it("background-tab icon (visible but not active) has data-state='background'", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        segments={[
          seg("g1", [
            { id: "scenes", slot: "LT", visible: true, active: false },
          ]),
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
    expect(btn.getAttribute("data-state")).toBe("background");
  });

  it("closed icon (not visible) has data-state='closed'", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        segments={[
          seg("g1", [
            { id: "scenes", slot: "LT", visible: false, active: false },
          ]),
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
    expect(btn.getAttribute("data-state")).toBe("closed");
  });

  it("click invokes togglePanel", async () => {
    const togglePanel = vi.fn();
    useLayoutStore.setState({ togglePanel });
    const user = userEvent.setup();
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        segments={[
          seg("g1", [
            { id: "scenes", slot: "LT", visible: true, active: true },
          ]),
        ]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "layout.panel.scenes" }),
    );
    expect(togglePanel).toHaveBeenCalledWith("scenes");
  });

  describe("divider rendering (N-1 for N segments)", () => {
    it("renders no divider for 1 segment", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      expect(container.querySelectorAll("[data-stripe-divider]").length).toBe(
        0,
      );
    });

    it("renders 1 divider for 2 segments", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
            seg("g2", [
              { id: "codex", slot: "LB", visible: false, active: false },
            ]),
          ]}
        />,
      );
      expect(container.querySelectorAll("[data-stripe-divider]").length).toBe(
        1,
      );
    });

    it("renders 2 dividers for 3 segments", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
            seg("g2", [
              { id: "codex", slot: "LB", visible: false, active: false },
            ]),
            seg("g3", [
              {
                id: "command-center-results",
                slot: "LB",
                visible: false,
                active: false,
              },
            ]),
          ]}
        />,
      );
      expect(container.querySelectorAll("[data-stripe-divider]").length).toBe(
        2,
      );
    });
  });

  describe("segment flex-grow reflects sizeRatio", () => {
    it("each segment gets flexGrow inline style from sizeRatio", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg(
              "g1",
              [{ id: "scenes", slot: "LT", visible: true, active: true }],
              { sizeRatio: 300 },
            ),
            seg(
              "g2",
              [{ id: "codex", slot: "LB", visible: false, active: false }],
              { sizeRatio: 100 },
            ),
          ]}
        />,
      );
      const g1 = container.querySelector("[data-drop-segment='g1']");
      const g2 = container.querySelector("[data-drop-segment='g2']");
      expect((g1 as HTMLElement).style.flexGrow).toBe("300");
      expect((g2 as HTMLElement).style.flexGrow).toBe("100");
    });
  });

  describe("DnD icon reassignment", () => {
    it("icon button is draggable", () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      expect(btn.getAttribute("draggable")).toBe("true");
    });

    it("dragstart sets application/grimodex-toolwindow-reassign with panelId", () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      const setData = vi.fn();
      fireEvent.dragStart(btn, {
        dataTransfer: { setData, effectAllowed: "move" },
      });
      expect(setData).toHaveBeenCalledWith(
        "application/grimodex-toolwindow-reassign",
        "scenes",
      );
    });

    it("drop on segment calls moveToGroup with the band's first group id", () => {
      const moveToGroup = vi.fn();
      useLayoutStore.setState({ moveToGroup });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg(
              "g1",
              [{ id: "scenes", slot: "LT", visible: true, active: true }],
              { groupIds: ["g1"] },
            ),
            seg(
              "g2",
              [{ id: "codex", slot: "LB", visible: false, active: false }],
              { groupIds: ["g2"] },
            ),
          ]}
        />,
      );
      const g2Zone = container.querySelector("[data-drop-segment='g2']");
      expect(g2Zone).not.toBeNull();
      fireEvent.drop(g2Zone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("scenes") },
      });
      expect(moveToGroup).toHaveBeenCalledWith("scenes", "g2");
    });

    it("drop on a multi-group band targets the first group", () => {
      const moveToGroup = vi.fn();
      useLayoutStore.setState({ moveToGroup });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg(
              "g-l+g-r",
              [{ id: "scenes", slot: "LT", visible: true, active: true }],
              { groupIds: ["g-l", "g-r"] },
            ),
          ]}
        />,
      );
      const zone = container.querySelector("[data-drop-segment='g-l+g-r']");
      fireEvent.drop(zone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("codex") },
      });
      expect(moveToGroup).toHaveBeenCalledWith("codex", "g-l");
    });

    it("drop on ghost segment (no group) is a no-op", () => {
      const moveToGroup = vi.fn();
      useLayoutStore.setState({ moveToGroup });
      const ghost: StripeSegment = {
        key: "ghost-left",
        groupIds: [],
        panels: [{ id: "scenes", slot: "LT", visible: false, active: false }],
        sizeRatio: 1,
      };
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[ghost]}
        />,
      );
      const zone = container.querySelector("[data-drop-segment='ghost-left']");
      fireEvent.drop(zone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("codex") },
      });
      expect(moveToGroup).not.toHaveBeenCalled();
    });

    it("drop with empty panelId is a no-op", () => {
      const moveToGroup = vi.fn();
      useLayoutStore.setState({ moveToGroup });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const zone = container.querySelector("[data-drop-segment='g1']");
      fireEvent.drop(zone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("") },
      });
      expect(moveToGroup).not.toHaveBeenCalled();
    });

    it("drop respects layout lock", () => {
      const moveToGroup = vi.fn();
      useLayoutStore.setState({ moveToGroup, layoutLocked: true });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg(
              "g1",
              [{ id: "scenes", slot: "LT", visible: true, active: true }],
              { groupIds: ["g1"] },
            ),
          ]}
        />,
      );
      const zone = container.querySelector("[data-drop-segment='g1']");
      fireEvent.drop(zone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("scenes") },
      });
      expect(moveToGroup).not.toHaveBeenCalled();
    });
  });

  describe("right-click context menu", () => {
    it("right-click on icon renders 'Remove from sidebar' option", async () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      fireEvent.contextMenu(btn);
      const removeItem = await screen.findByTestId(
        "ctx-remove-from-stripe-scenes",
      );
      expect(removeItem).toBeTruthy();
    });

    it("clicking 'Remove from sidebar' calls removePanelFromStripe", async () => {
      const removePanelFromStripe = vi.fn();
      useLayoutStore.setState({ removePanelFromStripe });
      const user = userEvent.setup();
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      fireEvent.contextMenu(btn);
      const removeItem = await screen.findByTestId(
        "ctx-remove-from-stripe-scenes",
      );
      await user.click(removeItem);
      expect(removePanelFromStripe).toHaveBeenCalledWith("scenes");
    });

    it("context menu shows Move To trigger", async () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          segments={[
            seg("g1", [
              { id: "scenes", slot: "LT", visible: true, active: true },
            ]),
          ]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      fireEvent.contextMenu(btn);
      const moveTrigger = await screen.findByTestId("ctx-move-to-scenes");
      expect(moveTrigger).toBeTruthy();
    });
  });
});
