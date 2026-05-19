// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
          { id: "scenes", visible: true, active: true },
          { id: "command-center-results", visible: false, active: false },
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
        panels={[{ id: "scenes", visible: true, active: true }]}
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
        panels={[{ id: "scenes", visible: true, active: false }]}
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
        panels={[{ id: "scenes", visible: false, active: false }]}
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
          { id: "scenes", visible: true, active: true },
          {
            id: "command-center-results",
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
});
