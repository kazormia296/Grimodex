// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelToggleDropdown } from "./PanelToggleDropdown";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./PanelHighlightOverlay", () => ({
  PanelHighlightOverlay: () => null,
}));

function resetStore() {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    panelDragSource: null,
    activePresetId: null,
    customPresets: [],
    initialized: false,
  });
}

describe("PanelToggleDropdown pointer drag", () => {
  beforeEach(() => {
    resetStore();
  });

  async function openMenu() {
    render(<PanelToggleDropdown />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /layout.panels/i }));
    return user;
  }

  it("opts out of Tauri window drag region", async () => {
    await openMenu();
    expect(screen.getByTestId("panel-toggle-root")).toHaveAttribute(
      "data-tauri-drag-region",
      "false",
    );
    expect(screen.getByTestId("panel-toggle-item-grid")).toHaveAttribute(
      "data-tauri-drag-region",
      "false",
    );
  });

  it("starts pointer drag after movement threshold", async () => {
    await openMenu();
    const item = screen.getByTestId("panel-toggle-item-grid");

    fireEvent.pointerDown(item, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });
    fireEvent.pointerMove(document, {
      clientX: 30,
      clientY: 10,
      pointerId: 1,
      bubbles: true,
    });

    expect(useLayoutStore.getState().draggingPanel).toBe("grid");
    expect(useLayoutStore.getState().panelDragSource).toBe("pointer");
  });

  it("toggles panel on click without movement", async () => {
    await openMenu();
    const item = screen.getByTestId("panel-toggle-item-grid");

    fireEvent.pointerDown(item, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });
    fireEvent.pointerUp(item, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });

    expect(useLayoutStore.getState().draggingPanel).toBeNull();
    expect(useLayoutStore.getState().isPanelActive("grid")).toBe(true);
  });

  it("does not start drag when layout is locked", async () => {
    useLayoutStore.setState({ layoutLocked: true });
    await openMenu();
    const item = screen.getByTestId("panel-toggle-item-grid");

    fireEvent.pointerDown(item, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });
    fireEvent.pointerMove(document, {
      clientX: 40,
      clientY: 10,
      pointerId: 1,
      bubbles: true,
    });

    expect(useLayoutStore.getState().draggingPanel).toBeNull();
  });
});
