// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useLayoutStore } from "./layoutStore";
import {
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
} from "./toolWindowDefaults";

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

describe("ToolWindowStripe", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns null when panels list is empty", () => {
    const { container } = render(
      <ToolWindowStripe region="left" orientation="vertical" panels={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an icon for each panel (active + inactive)", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        panels={[
          { id: "scenes", slot: "LT", visible: true, active: true },
          {
            id: "command-center-results",
            slot: "LB",
            visible: false,
            active: false,
          },
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
        panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
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
        panels={[{ id: "scenes", slot: "LT", visible: true, active: false }]}
      />,
    );
    const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("data-state")).toBe("background");
  });

  it("closed icon (not visible) has data-state='closed'", () => {
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        panels={[{ id: "scenes", slot: "LT", visible: false, active: false }]}
      />,
    );
    const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("data-state")).toBe("closed");
  });

  it("click invokes togglePanel regardless of state (close active / setActive or open inactive)", async () => {
    const togglePanel = vi.fn();
    useLayoutStore.setState({ togglePanel });
    const user = userEvent.setup();
    render(
      <ToolWindowStripe
        region="left"
        orientation="vertical"
        panels={[
          { id: "scenes", slot: "LT", visible: true, active: true },
          {
            id: "command-center-results",
            slot: "LB",
            visible: false,
            active: false,
          },
        ]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "layout.panel.scenes" }),
    );
    expect(togglePanel).toHaveBeenCalledWith("scenes");
    await user.click(
      screen.getByRole("button", {
        name: "layout.panel.command-center-results",
      }),
    );
    expect(togglePanel).toHaveBeenCalledWith("command-center-results");
  });

  describe("Phase 2 - sub-slot divider", () => {
    it("renders a divider between LT and LB groups when both have panels", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[
            { id: "scenes", slot: "LT", visible: true, active: true },
            { id: "codex", slot: "LB", visible: false, active: false },
          ]}
        />,
      );
      expect(container.querySelector("[data-stripe-divider]")).not.toBeNull();
    });

    it("renders a divider even when all panels share the same sub-slot (always visible)", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
        />,
      );
      expect(container.querySelector("[data-stripe-divider]")).not.toBeNull();
    });

    it("renders a divider for bottom stripe with only BL panels (always visible)", () => {
      const { container } = render(
        <ToolWindowStripe
          region="bottom"
          orientation="horizontal"
          panels={[{ id: "timeline", slot: "BL", visible: true, active: true }]}
        />,
      );
      expect(container.querySelector("[data-stripe-divider]")).not.toBeNull();
    });

    it("renders divider between BL and BR groups in bottom stripe", () => {
      const { container } = render(
        <ToolWindowStripe
          region="bottom"
          orientation="horizontal"
          panels={[
            { id: "timeline", slot: "BL", visible: true, active: true },
            { id: "snippets", slot: "BR", visible: false, active: false },
          ]}
        />,
      );
      expect(container.querySelector("[data-stripe-divider]")).not.toBeNull();
    });

    it("LT group appears before LB group in vertical stripe", () => {
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[
            { id: "codex", slot: "LB", visible: false, active: false },
            { id: "scenes", slot: "LT", visible: true, active: true },
          ]}
        />,
      );
      const buttons = container.querySelectorAll("button");
      const ids = Array.from(buttons).map((b) =>
        b.getAttribute("data-stripe-icon"),
      );
      const scenesIdx = ids.indexOf("scenes");
      const codexIdx = ids.indexOf("codex");
      expect(scenesIdx).toBeLessThan(codexIdx);
    });
  });

  describe("Phase 2 - DnD icon reassignment", () => {
    it("icon button is draggable", () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
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
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
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

    it("drop on LB drop zone calls moveToSlot(panelId, 'LB')", () => {
      const moveToSlot = vi.fn();
      useLayoutStore.setState({ moveToSlot });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[
            { id: "scenes", slot: "LT", visible: true, active: true },
            { id: "codex", slot: "LB", visible: false, active: false },
          ]}
        />,
      );
      const lbZone = container.querySelector("[data-drop-slot='LB']");
      expect(lbZone).not.toBeNull();
      fireEvent.drop(lbZone!, {
        dataTransfer: {
          getData: vi.fn().mockReturnValue("scenes"),
        },
      });
      expect(moveToSlot).toHaveBeenCalledWith("scenes", "LB");
    });

    it("drop on LT drop zone calls moveToSlot(panelId, 'LT')", () => {
      const moveToSlot = vi.fn();
      useLayoutStore.setState({ moveToSlot });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[
            { id: "scenes", slot: "LT", visible: true, active: true },
            { id: "codex", slot: "LB", visible: false, active: false },
          ]}
        />,
      );
      const ltZone = container.querySelector("[data-drop-slot='LT']");
      expect(ltZone).not.toBeNull();
      fireEvent.drop(ltZone!, {
        dataTransfer: {
          getData: vi.fn().mockReturnValue("codex"),
        },
      });
      expect(moveToSlot).toHaveBeenCalledWith("codex", "LT");
    });

    it("LT drop zone exists and accepts drops even when LT has no panels", () => {
      const moveToSlot = vi.fn();
      useLayoutStore.setState({ moveToSlot });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "codex", slot: "LB", visible: true, active: true }]}
        />,
      );
      const ltZone = container.querySelector("[data-drop-slot='LT']");
      expect(ltZone).not.toBeNull();
      fireEvent.drop(ltZone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("codex") },
      });
      expect(moveToSlot).toHaveBeenCalledWith("codex", "LT");
    });

    it("LB drop zone exists and accepts drops even when LB has no panels", () => {
      const moveToSlot = vi.fn();
      useLayoutStore.setState({ moveToSlot });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
        />,
      );
      const lbZone = container.querySelector("[data-drop-slot='LB']");
      expect(lbZone).not.toBeNull();
      fireEvent.drop(lbZone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("scenes") },
      });
      expect(moveToSlot).toHaveBeenCalledWith("scenes", "LB");
    });

    it("drop with empty panelId is a no-op", () => {
      const moveToSlot = vi.fn();
      useLayoutStore.setState({ moveToSlot });
      const { container } = render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
        />,
      );
      const ltZone = container.querySelector("[data-drop-slot='LT']");
      fireEvent.drop(ltZone!, {
        dataTransfer: { getData: vi.fn().mockReturnValue("") },
      });
      expect(moveToSlot).not.toHaveBeenCalled();
    });
  });

  describe("Phase 2 - right-click context menu", () => {
    it("right-click on icon renders 'Remove from sidebar' option", async () => {
      render(
        <ToolWindowStripe
          region="left"
          orientation="vertical"
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      fireEvent.contextMenu(btn);
      // Radix ContextMenu renders in portal; wait for it
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
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
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
          panels={[{ id: "scenes", slot: "LT", visible: true, active: true }]}
        />,
      );
      const btn = screen.getByRole("button", { name: "layout.panel.scenes" });
      fireEvent.contextMenu(btn);
      const moveTrigger = await screen.findByTestId("ctx-move-to-scenes");
      expect(moveTrigger).toBeTruthy();
    });
  });
});
