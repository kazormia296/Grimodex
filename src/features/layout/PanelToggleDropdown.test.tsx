// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelToggleDropdown } from "./PanelToggleDropdown";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";
import { resolveDropTargetFromPoint } from "./layoutDnD";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./PanelHighlightOverlay", () => ({
  PanelHighlightOverlay: () => null,
}));

// resolveDropTargetFromPoint だけ stub する（document.elementFromPoint は
// happy-dom で null 固定なので、これが無いと drop 分岐に到達できない＝browser
// 専用になってしまう）。performToolWindowDrop / 閾値 / store は実物を使い、
// hook が「drop 時に resolved target + dragged panelId で着地させる」配線を gate する。
// 実座標→target の解決自体は layoutDnD.test.ts で別途 happy-dom カバー済。
vi.mock("./layoutDnD", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layoutDnD")>();
  return { ...actual, resolveDropTargetFromPoint: vi.fn(() => null) };
});

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

  it("routes the drop to the resolved target with the dragged panel on pointerup", async () => {
    // 末端 store action を spy にして「drop 時に dragged panelId + resolved target で
    // 着地させる」配線を検証する（performToolWindowDrop の routing は実物）。
    const movePanelToSlot = vi.fn();
    useLayoutStore.setState({ layoutLocked: false, movePanelToSlot });
    vi.mocked(resolveDropTargetFromPoint).mockReturnValue({
      type: "slot",
      region: "left",
      slotId: "l0",
    });

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
    fireEvent.pointerUp(document, {
      clientX: 40,
      clientY: 10,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });

    // type:"slot" → performToolWindowDrop → movePanelToSlot(panelId, region, slotId)
    expect(movePanelToSlot).toHaveBeenCalledWith("grid", "left", "l0");
    // drop 後は drag セッションがクリアされる (endSession(true))
    expect(useLayoutStore.getState().draggingPanel).toBeNull();
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
